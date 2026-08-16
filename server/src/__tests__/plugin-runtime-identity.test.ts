import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  attestContentAddressedPluginPackage,
  computeContentAddressedPluginTreeSha256,
} from "../services/plugin-loader.js";

const roots: string[] = [];
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("content-addressed plugin runtime identity", () => {
  it("binds the immutable full package, host manifest jobs, and deployment source receipt", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-cas-test-"));
    roots.push(parent);
    const ownerUid = process.getuid?.() ?? 0;
    const staging = path.join(parent, "staging");
    await mkdir(path.join(staging, "dist"), { recursive: true, mode: 0o755 });
    await writeFile(path.join(staging, "dist", "worker.js"), "import './support.js';\n", { mode: 0o444 });
    await writeFile(path.join(staging, "dist", "support.js"), "export const value = 1;\n", { mode: 0o444 });
    const digest = await computeContentAddressedPluginTreeSha256(staging, ownerUid, parent);
    const packageRoot = path.join(parent, digest);
    await rename(staging, packageRoot);
    const deploymentReceipt = {
      schemaVersion: "paperclip-plugin-deployment-receipt@1",
      sourceRepository: "gloopsAI/gloops-paperclip-plugin",
      sourceHeadSha: "a".repeat(40),
      packageTreeSha256: digest,
    };
    await writeFile(`${packageRoot}.provenance.json`, JSON.stringify({
      deploymentReceipt,
      deploymentReceiptDigest: createHash("sha256").update(stable(deploymentReceipt)).digest("hex"),
    }), { mode: 0o444 });
    const manifest = {
      id: "gloops.autonomic-improvement-policy",
      version: "0.3.1",
      apiVersion: "1",
      displayName: "Autonomic policy",
      capabilities: [],
      worker: { entrypoint: "dist/worker.js" },
      jobs: [{ jobKey: "observe", displayName: "Observe", schedule: "0 * * * *" }],
    } as unknown as PaperclipPluginManifestV1;
    const identity = await attestContentAddressedPluginPackage({
      packageRoot,
      workerEntrypoint: path.join(packageRoot, "dist", "worker.js"),
      installationId: "installation-id",
      pluginKey: manifest.id,
      manifest,
      ownerUid,
      trustedRoot: parent,
    });
    expect(identity).toMatchObject({
      packageTreeSha256: digest,
      sourceRepository: "gloopsai/gloops-paperclip-plugin",
      sourceHeadSha: "a".repeat(40),
      jobDeclarationCount: 1,
      jobKeys: ["observe"],
    });

    await chmod(path.join(packageRoot, "dist", "support.js"), 0o644);
    await writeFile(path.join(packageRoot, "dist", "support.js"), "export const value = 2;\n");
    await chmod(path.join(packageRoot, "dist", "support.js"), 0o444);
    expect(await attestContentAddressedPluginPackage({
      packageRoot,
      workerEntrypoint: path.join(packageRoot, "dist", "worker.js"),
      installationId: "installation-id",
      pluginKey: manifest.id,
      manifest,
      ownerUid,
      trustedRoot: parent,
    })).toBeNull();
  });

  it("rejects symlinked or writable package content", async () => {
    const parent = await mkdtemp(path.join(process.cwd(), ".plugin-cas-test-"));
    roots.push(parent);
    const ownerUid = process.getuid?.() ?? 0;
    const root = path.join(parent, "candidate");
    await mkdir(root, { mode: 0o755 });
    await writeFile(path.join(root, "target.js"), "export {};\n", { mode: 0o444 });
    await symlink("target.js", path.join(root, "worker.js"));
    await expect(computeContentAddressedPluginTreeSha256(root, ownerUid, parent))
      .rejects.toThrow("Untrusted content-addressed plugin entry");
    await rm(path.join(root, "worker.js"));
    await chmod(path.join(root, "target.js"), 0o666);
    await expect(computeContentAddressedPluginTreeSha256(root, ownerUid, parent))
      .rejects.toThrow("Untrusted content-addressed plugin entry");
  });
});
