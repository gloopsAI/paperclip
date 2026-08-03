import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "./canonical-patch-digest.mjs",
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const base = "88bdc05c05c01943a21c04fdf90bcb76211c87a6";
const head = "48f609d89645182ab618f707988b1ac9df139d22";

function runWithAbbrev(abbrev) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  if (abbrev !== undefined) {
    return execFileSync(
      "node",
      [script, "--base", base, "--head", head, "--repo", repo],
      {
        encoding: "utf8",
        env: {
          ...env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "core.abbrev",
          GIT_CONFIG_VALUE_0: String(abbrev),
        },
      },
    ).trim();
  }
  return execFileSync(
    "node",
    [script, "--base", base, "--head", head, "--repo", repo],
    { encoding: "utf8", env },
  ).trim();
}

function directDigest(abbrev) {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const extra = abbrev !== undefined ? ["-c", `core.abbrev=${abbrev}`] : [];
  const diff = execFileSync(
    "git",
    [...extra, "diff", "--no-color", "--full-index", `${base}..${head}`],
    { env, cwd: repo },
  );
  return createHash("sha256").update(diff).digest("hex");
}

describe("canonical-patch-digest", () => {
  it("emits a full-index SHA-256 regardless of core.abbrev", () => {
    const defaultDigest = runWithAbbrev(undefined);
    const eightDigest = runWithAbbrev(8);
    const tenDigest = runWithAbbrev(10);

    assert.equal(defaultDigest.length, 64, "digest must be 64 hex chars");
    assert.match(defaultDigest, /^[0-9a-f]+$/);
    assert.equal(defaultDigest, directDigest(undefined));
    assert.equal(defaultDigest, eightDigest);
    assert.equal(defaultDigest, tenDigest);
    assert.equal(defaultDigest, directDigest(8));
    assert.equal(defaultDigest, directDigest(10));
    assert.equal(
      defaultDigest,
      "19accf754864df9ee621642e33b108a3fc802926d0362011bf2bf7ba6a69567c",
    );
  });

  it("rejects abbreviated base and head SHAs", () => {
    assert.throws(() => {
      execFileSync("node", [script, "--base", "88bdc05", "--head", head, "--repo", repo]);
    });
    assert.throws(() => {
      execFileSync("node", [script, "--base", base, "--head", "48f609d", "--repo", repo]);
    });
  });

  it("rejects missing arguments", () => {
    assert.throws(() => {
      execFileSync("node", [script, "--base", base]);
    });
  });
});
