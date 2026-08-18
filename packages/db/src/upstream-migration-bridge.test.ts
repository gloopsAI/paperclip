import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  PINNED_UPSTREAM_MIGRATION_MANIFEST_DIGEST,
  runUpstreamMigrationBridge,
  verifyUpstreamMigrationBridgeManifest,
} from "./upstream-migration-bridge.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe.sequential : describe.skip;
const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("upstream migration bridge manifest", () => {
  it("binds all 65 upstream migrations and the fork overlap by exact digest", async () => {
    const manifest = await verifyUpstreamMigrationBridgeManifest();
    expect(manifest.manifestDigest).toBe(PINNED_UPSTREAM_MIGRATION_MANIFEST_DIGEST);
    expect(manifest.entries).toHaveLength(65);
    expect(manifest.forkOverlapEntries).toHaveLength(8);
    expect(manifest.entries.filter((entry) => entry.destructive).map((entry) => entry.id)).toEqual([
      "0164_plugin_config_company_scope",
      "0167_environment_custom_image_instance_scope_cleanup",
      "0175_nested_skill_folders",
      "0190_status_card_single_prompt",
      "0196_drop_cloud_upstream_tables",
      "0199_decision_queue_composite_key",
      "0211_bright_morg",
    ]);
    expect(new Set(manifest.entries.map((entry) => entry.classification))).toEqual(
      new Set(["adapt", "conflict"]),
    );
  });

  it("rejects a paired manifest and digest rewrite outside the reviewed pin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paperclip-upstream-bridge-tamper-"));
    try {
      const originalPath = new URL(
        "./upstream-migrations/v2026.817.0/manifest.json",
        import.meta.url,
      );
      const manifest = JSON.parse(await readFile(originalPath, "utf8"));
      manifest.entries[0].classification = "adopt";
      manifest.entries[0].execution = "record_only_adopted";
      manifest.manifestDigest = "sha256:" + "a".repeat(64);
      const tampered = path.join(dir, "manifest.json");
      writeFileSync(tampered, JSON.stringify(manifest));
      await expect(verifyUpstreamMigrationBridgeManifest(tampered)).rejects.toThrow(
        /manifest digest mismatch/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describePostgres("upstream migration bridge ledger", () => {
  it("records exactly once, fails closed on drift, and rolls the classification ledger back", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-upstream-bridge-");
    cleanups.push(database.cleanup);

    const first = await runUpstreamMigrationBridge(database.connectionString, "record");
    expect(first.rowsWritten).toBe(65);
    expect(first.databaseAfter.rowCounts.gloops_upstream_migration_bridge).toBe(65);
    expect(first.classifications).toEqual({ adopt: 0, adapt: 37, superseded: 0, conflict: 28 });

    const replay = await runUpstreamMigrationBridge(database.connectionString, "record");
    expect(replay.rowsWritten).toBe(0);
    expect(replay.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);

    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      await sql`
        UPDATE gloops_upstream_migration_bridge
        SET sql_sha256 = 'drift'
        WHERE migration_id = '0147_cost_event_status'
      `;
      await expect(runUpstreamMigrationBridge(database.connectionString, "record")).rejects.toThrow(
        /ledger conflicts/,
      );
      const manifest = await verifyUpstreamMigrationBridgeManifest();
      await sql`
        UPDATE gloops_upstream_migration_bridge
        SET sql_sha256 = ${manifest.entries[0]!.sqlSha256}
        WHERE migration_id = '0147_cost_event_status'
      `;
    } finally {
      await sql.end();
    }

    const rollback = await runUpstreamMigrationBridge(
      database.connectionString,
      "rollback-classification",
    );
    expect(rollback.rowsWritten).toBe(65);
    expect(rollback.databaseAfter.rowCounts.gloops_upstream_migration_bridge).toBe(0);
    expect(rollback.databaseAfter.migrationJournalDigest).toBe(
      rollback.databaseBefore.migrationJournalDigest,
    );
  }, 30_000);
});
