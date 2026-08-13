import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

function packageVersion(packageName: string, fromPath?: string): string {
  const packagePath = require.resolve(`${packageName}/package.json`, {
    paths: fromPath ? [fromPath] : undefined,
  });
  return JSON.parse(fs.readFileSync(packagePath, "utf8")).version as string;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (actualParts[index] > minimumParts[index]) return true;
    if (actualParts[index] < minimumParts[index]) return false;
  }
  return true;
}

describe("Codex ACP runtime compatibility", () => {
  it("retains the Terra-capable ACP and Codex runtime floor", () => {
    const codexAcpPackagePath = require.resolve("@agentclientprotocol/codex-acp/package.json");
    const codexAcpVersion = packageVersion("@agentclientprotocol/codex-acp");
    const codexVersion = packageVersion("@openai/codex", path.dirname(codexAcpPackagePath));

    expect(versionAtLeast(codexAcpVersion, "1.2.0")).toBe(true);
    expect(versionAtLeast(codexVersion, "0.147.0")).toBe(true);
  });
});
