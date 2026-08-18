import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const RELEASE = "v2026.817.0";
const BRIDGE_TABLE = "gloops_upstream_migration_bridge";
const MANIFEST_PATH = fileURLToPath(
  new URL(`./upstream-migrations/${RELEASE}/manifest.json`, import.meta.url),
);
const UPSTREAM_SQL_DIR = fileURLToPath(
  new URL(`./upstream-migrations/${RELEASE}/`, import.meta.url),
);
const FORK_MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export const PINNED_UPSTREAM_MIGRATION_MANIFEST_DIGEST =
  "sha256:0641aea7e6f0cc06ad35c698df61a10b104eb150d6e851779909d3db2f4f69b1";

const CLASSIFICATIONS = new Set(["adopt", "adapt", "superseded", "conflict"]);
const EXECUTIONS = new Set([
  "record_only_adopted",
  "deferred_adaptation",
  "record_only_superseded",
  "record_only_conflict",
]);

type Effects = {
  createTables: string[];
  alterTables: string[];
  dropTables: string[];
  createIndexes: string[];
  dropIndexes: string[];
  dataMutationStatements: number;
};

export type UpstreamMigrationBridgeEntry = {
  id: string;
  file: string;
  sqlSha256: string;
  sourceCommit: string;
  sourceSubject: string;
  upstreamDisposition: string;
  classification: "adopt" | "adapt" | "superseded" | "conflict";
  classificationReason: string;
  execution:
    | "record_only_adopted"
    | "deferred_adaptation"
    | "record_only_superseded"
    | "record_only_conflict";
  destructive: boolean;
  effects: Effects;
};

type ForkOverlapEntry = {
  id: string;
  file: string;
  sqlSha256: string;
};

export type UpstreamMigrationBridgeManifest = {
  schemaVersion: "gloops.upstream-migration-bridge-manifest.v1";
  release: string;
  upstreamHead: string;
  forkBase: string;
  forkMigrationRange: { first: string; last: string };
  forkOverlapEntries: ForkOverlapEntry[];
  upstreamMigrationRange: { first: string; last: string };
  entryCount: number;
  entries: UpstreamMigrationBridgeEntry[];
  manifestDigest: string;
};

type Sql = ReturnType<typeof postgres>;

export type BridgeDatabaseObservation = {
  schemaDigest: string;
  rowCounts: Record<string, number>;
  migrationJournalDigest: string;
  migrationJournalRows: number;
};

export type UpstreamMigrationBridgeReceipt = {
  schemaVersion: "gloops.upstream-migration-bridge-receipt.v1";
  command: "verify" | "record" | "rollback-classification";
  release: string;
  manifestDigest: string;
  forkBase: string;
  upstreamHead: string;
  classifications: Record<string, number>;
  destructiveMigrationIds: string[];
  rowsWritten: number;
  databaseBefore: BridgeDatabaseObservation;
  databaseAfter: BridgeDatabaseObservation;
  receiptDigest: string;
};

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys do not match the accepted schema`);
  }
}

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function inferDestructive(sql: string): boolean {
  return /\bDROP\s+(?:TABLE|INDEX|COLUMN)\b|\bTRUNCATE\b/iu.test(sql);
}

async function loadSqlFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
}

export async function verifyUpstreamMigrationBridgeManifest(
  manifestPath = MANIFEST_PATH,
): Promise<UpstreamMigrationBridgeManifest> {
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  exactKeys(
    parsed,
    [
      "schemaVersion", "release", "upstreamHead", "forkBase", "forkMigrationRange",
      "forkOverlapEntries", "upstreamMigrationRange", "entryCount", "entries", "manifestDigest",
    ],
    "upstream migration bridge manifest",
  );
  const manifest = parsed as UpstreamMigrationBridgeManifest;
  if (
    manifest.schemaVersion !== "gloops.upstream-migration-bridge-manifest.v1"
    || manifest.release !== RELEASE
    || !isSha(manifest.upstreamHead)
    || !isSha(manifest.forkBase)
    || !Array.isArray(manifest.entries)
    || !Array.isArray(manifest.forkOverlapEntries)
    || manifest.entryCount !== manifest.entries.length
    || manifest.entries.length !== 65
  ) {
    throw new Error("upstream migration bridge manifest identity is invalid");
  }

  const withoutDigest = { ...manifest } as Record<string, unknown>;
  delete withoutDigest.manifestDigest;
  const observedManifestDigest = `sha256:${sha256(canonicalJson(withoutDigest))}`;
  if (
    manifest.manifestDigest !== observedManifestDigest
    || manifest.manifestDigest !== PINNED_UPSTREAM_MIGRATION_MANIFEST_DIGEST
  ) {
    throw new Error("upstream migration bridge manifest digest mismatch");
  }

  const sqlFiles = await loadSqlFiles(UPSTREAM_SQL_DIR);
  const manifestFiles = manifest.entries.map((entry) => entry.file);
  if (
    sqlFiles.length !== manifestFiles.length
    || sqlFiles.some((file, index) => file !== manifestFiles[index])
  ) {
    throw new Error("upstream migration SQL set differs from the reviewed manifest");
  }

  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    exactKeys(
      entry,
      [
        "id", "file", "sqlSha256", "sourceCommit", "sourceSubject",
        "upstreamDisposition", "classification", "classificationReason", "execution", "destructive", "effects",
      ],
      `upstream migration entry ${String(entry.id)}`,
    );
    if (
      entry.file !== `${entry.id}.sql`
      || ids.has(entry.id)
      || !isSha256(entry.sqlSha256)
      || !isSha(entry.sourceCommit)
      || typeof entry.sourceSubject !== "string"
      || entry.sourceSubject.length === 0
      || !CLASSIFICATIONS.has(entry.classification)
      || typeof entry.classificationReason !== "string"
      || entry.classificationReason.length === 0
      || !EXECUTIONS.has(entry.execution)
    ) {
      throw new Error(`upstream migration entry ${entry.id} is invalid`);
    }
    ids.add(entry.id);
    const sql = await readFile(new URL(`./upstream-migrations/${RELEASE}/${entry.file}`, import.meta.url));
    if (sha256(sql) !== entry.sqlSha256) {
      throw new Error(`upstream migration SQL digest mismatch: ${entry.id}`);
    }
    if (inferDestructive(sql.toString("utf8")) !== entry.destructive) {
      throw new Error(`upstream migration destructive classification mismatch: ${entry.id}`);
    }
  }

  const forkFiles = (await loadSqlFiles(FORK_MIGRATIONS_DIR)).filter((file) =>
    /^01(?:4[7-9]|5[0-4])_/u.test(file)
  );
  if (
    forkFiles.length !== manifest.forkOverlapEntries.length
    || forkFiles.some((file, index) => file !== manifest.forkOverlapEntries[index]?.file)
  ) {
    throw new Error("fork overlap migration set differs from the reviewed manifest");
  }
  for (const entry of manifest.forkOverlapEntries) {
    const sql = await readFile(new URL(`./migrations/${entry.file}`, import.meta.url));
    if (
      entry.id !== entry.file.replace(/\.sql$/u, "")
      || !isSha256(entry.sqlSha256)
      || sha256(sql) !== entry.sqlSha256
    ) {
      throw new Error(`fork overlap migration digest mismatch: ${entry.id}`);
    }
  }
  return manifest;
}

async function discoverMigrationJournal(sql: Sql): Promise<string> {
  const rows = await sql<{ table_schema: string }[]>`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = '__drizzle_migrations'
    ORDER BY CASE WHEN table_schema = 'drizzle' THEN 0 ELSE 1 END, table_schema
  `;
  if (rows.length !== 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(rows[0]!.table_schema)) {
    throw new Error("fork migration journal is missing or ambiguous");
  }
  return rows[0]!.table_schema;
}

async function verifyForkMigrationJournal(sql: Sql): Promise<{ digest: string; rows: number }> {
  const schema = await discoverMigrationJournal(sql);
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ${schema} AND table_name = '__drizzle_migrations'
  `;
  const names = new Set(columns.map((row) => row.column_name));
  if (!names.has("hash") && !names.has("name")) {
    throw new Error("fork migration journal has no verifiable identity column");
  }
  const rows = await sql.unsafe<Array<{ hash?: string | null; name?: string | null; created_at?: unknown }>>(
    `SELECT ${names.has("hash") ? "hash" : "NULL AS hash"},
            ${names.has("name") ? "name" : "NULL AS name"},
            ${names.has("created_at") ? "created_at" : "NULL AS created_at"}
       FROM "${schema}"."__drizzle_migrations"
       ORDER BY id`,
  );
  const files = await loadSqlFiles(FORK_MIGRATIONS_DIR);
  const identities = await Promise.all(
    files.map(async (file) => ({
      file,
      hash: sha256(await readFile(new URL(`./migrations/${file}`, import.meta.url))),
    })),
  );
  const byHash = new Map(identities.map((entry) => [entry.hash, entry.file]));
  const byName = new Map(identities.map((entry) => [entry.file, entry.hash]));
  for (const row of rows) {
    const hash = typeof row.hash === "string" ? row.hash : null;
    const name = typeof row.name === "string" ? row.name : null;
    if (
      (hash && !byHash.has(hash))
      || (name && !byName.has(name))
      || (hash && name && byName.get(name) !== hash)
    ) {
      throw new Error("fork migration journal contains an unknown or drifted migration");
    }
  }
  return { digest: `sha256:${sha256(canonicalJson(rows))}`, rows: rows.length };
}

async function observeDatabase(sql: Sql): Promise<BridgeDatabaseObservation> {
  const columns = await sql<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }[]>`
    SELECT table_name, column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `;
  const existingTables = new Set(columns.map((column) => column.table_name));
  const rowCounts: Record<string, number> = {};
  for (
    const table of [
      "companies", "projects", "agents", "issues", "heartbeat_runs", "cost_events", BRIDGE_TABLE,
    ]
  ) {
    if (!existingTables.has(table)) continue;
    const rows = await sql.unsafe<Array<{ count: string }>>(
      `SELECT count(*)::text AS count FROM "${table}"`,
    );
    rowCounts[table] = Number(rows[0]?.count ?? 0);
  }
  const journal = await verifyForkMigrationJournal(sql);
  return {
    schemaDigest: `sha256:${sha256(canonicalJson(columns))}`,
    rowCounts,
    migrationJournalDigest: journal.digest,
    migrationJournalRows: journal.rows,
  };
}

function classificationCounts(manifest: UpstreamMigrationBridgeManifest): Record<string, number> {
  const counts: Record<string, number> = { adopt: 0, adapt: 0, superseded: 0, conflict: 0 };
  for (const entry of manifest.entries) {
    counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  }
  return counts;
}

function finishReceipt(
  command: UpstreamMigrationBridgeReceipt["command"],
  manifest: UpstreamMigrationBridgeManifest,
  before: BridgeDatabaseObservation,
  after: BridgeDatabaseObservation,
  rowsWritten: number,
): UpstreamMigrationBridgeReceipt {
  const unsigned = {
    schemaVersion: "gloops.upstream-migration-bridge-receipt.v1" as const,
    command,
    release: manifest.release,
    manifestDigest: manifest.manifestDigest,
    forkBase: manifest.forkBase,
    upstreamHead: manifest.upstreamHead,
    classifications: classificationCounts(manifest),
    destructiveMigrationIds: manifest.entries
      .filter((entry) => entry.destructive)
      .map((entry) => entry.id),
    rowsWritten,
    databaseBefore: before,
    databaseAfter: after,
  };
  return {
    ...unsigned,
    receiptDigest: `sha256:${sha256(canonicalJson(unsigned))}`,
  };
}

export async function runUpstreamMigrationBridge(
  connectionString: string,
  command: UpstreamMigrationBridgeReceipt["command"],
): Promise<UpstreamMigrationBridgeReceipt> {
  const manifest = await verifyUpstreamMigrationBridgeManifest();
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    const before = await observeDatabase(sql);
    if (command === "verify") return finishReceipt(command, manifest, before, before, 0);

    let rowsWritten = 0;
    await sql.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('gloops.upstream-migration-bridge.v1'))`;
      await verifyForkMigrationJournal(transaction as unknown as Sql);
      await transaction.unsafe(`
        CREATE TABLE IF NOT EXISTS "${BRIDGE_TABLE}" (
          release_tag text NOT NULL,
          migration_id text NOT NULL,
          sql_sha256 text NOT NULL,
          source_commit text NOT NULL,
          classification text NOT NULL,
          execution text NOT NULL,
          destructive boolean NOT NULL,
          state text NOT NULL,
          manifest_digest text NOT NULL,
          recorded_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (release_tag, migration_id),
          CHECK (state = 'classified')
        )
      `);
      const existing = await transaction.unsafe<Array<Record<string, unknown>>>(`
        SELECT release_tag, migration_id, sql_sha256, source_commit, classification,
               execution, destructive, state, manifest_digest
        FROM "${BRIDGE_TABLE}"
        ORDER BY release_tag, migration_id
      `);
      if (existing.some((row) => row.release_tag !== manifest.release)) {
        throw new Error("upstream migration bridge contains an unknown release");
      }
      if (command === "rollback-classification") {
        const result = await transaction.unsafe(
          `DELETE FROM "${BRIDGE_TABLE}" WHERE release_tag = $1`,
          [manifest.release],
        );
        rowsWritten = Number(result.count ?? 0);
        return;
      }
      const expected = new Map(manifest.entries.map((entry) => [entry.id, entry]));
      for (const row of existing) {
        const entry = expected.get(String(row.migration_id));
        if (
          !entry
          || row.sql_sha256 !== entry.sqlSha256
          || row.source_commit !== entry.sourceCommit
          || row.classification !== entry.classification
          || row.execution !== entry.execution
          || row.destructive !== entry.destructive
          || row.state !== "classified"
          || row.manifest_digest !== manifest.manifestDigest
        ) {
          throw new Error("upstream migration bridge ledger conflicts with the reviewed manifest");
        }
      }
      const existingIds = new Set(existing.map((row) => String(row.migration_id)));
      for (const entry of manifest.entries) {
        if (existingIds.has(entry.id)) continue;
        await transaction.unsafe(
          `INSERT INTO "${BRIDGE_TABLE}" (
             release_tag, migration_id, sql_sha256, source_commit, classification,
             execution, destructive, state, manifest_digest
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'classified',$8)`,
          [
            manifest.release, entry.id, entry.sqlSha256, entry.sourceCommit,
            entry.classification, entry.execution, entry.destructive, manifest.manifestDigest,
          ],
        );
        rowsWritten += 1;
      }
    });
    const after = await observeDatabase(sql);
    return finishReceipt(command, manifest, before, after, rowsWritten);
  } finally {
    await sql.end();
  }
}
