import { describe, expect, it } from "vitest";
import {
  ALLOWED_RELEASE_ENVIRONMENTS,
  RELEASE_CONTRACT_SCHEMA_VERSION,
  buildDeployReceipt,
  buildRollbackReceipt,
  evaluateHealth,
  shouldRollback,
  validateReleaseCandidate,
  type DeployReceipt,
  type ReleaseCandidate,
} from "./release-contract.js";

const DIGEST =
  "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PREV_DIGEST =
  "ghcr.io/gloops/paperclip@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD = "abcdef0123456789abcdef0123456789abcdef01";

function validCandidate(overrides: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  return {
    imageDigest: DIGEST,
    prRef: "refs/pull/42/head",
    headRef: HEAD,
    argusAccepted: true,
    ciGreen: true,
    environment: "surface",
    service: "paperclip.service",
    previousImageDigest: PREV_DIGEST,
    idempotencyKey: "release-42",
    ...overrides,
  };
}

describe("validateReleaseCandidate", () => {
  it("accepts a fully specified allowlisted candidate", () => {
    const result = validateReleaseCandidate(validCandidate());
    expect(result).toEqual({
      valid: true,
      errors: [],
      environment: "surface",
      imageDigest: DIGEST,
    });
  });

  it("fails closed when the candidate is missing", () => {
    const result = validateReleaseCandidate(null);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["missing_digest", "argus_not_accepted"]),
    );
  });

  it("fails closed when digest is missing", () => {
    const result = validateReleaseCandidate(validCandidate({ imageDigest: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "missing_digest" }),
    );
  });

  it("rejects non-exact digests (tags are not pins)", () => {
    const result = validateReleaseCandidate(
      validCandidate({ imageDigest: "ghcr.io/gloops/paperclip:latest" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "invalid_digest" }),
    );
  });

  it("accepts registry path @sha256 pins", () => {
    const result = validateReleaseCandidate(
      validCandidate({ imageDigest: PREV_DIGEST }),
    );
    expect(result.valid).toBe(true);
    expect(result.imageDigest).toBe(PREV_DIGEST);
  });

  it("fails closed when Argus has not accepted", () => {
    const result = validateReleaseCandidate(
      validCandidate({ argusAccepted: false }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "argus_not_accepted" }),
    );
  });

  it("rejects when CI is not green", () => {
    const result = validateReleaseCandidate(validCandidate({ ciGreen: false }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "ci_not_green" }),
    );
  });

  it("requires PR and head refs", () => {
    const result = validateReleaseCandidate(
      validCandidate({ prRef: "  ", headRef: "" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["missing_pr_ref", "missing_head_ref"]),
    );
  });

  it("rejects short or malformed head SHAs", () => {
    const result = validateReleaseCandidate(validCandidate({ headRef: "abc1234" }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "invalid_head_ref" }),
    );
  });

  it("rejects environments outside the allowlist", () => {
    const result = validateReleaseCandidate(
      validCandidate({ environment: "prod-shadow" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: "environment_not_allowlisted" }),
    );
    expect(ALLOWED_RELEASE_ENVIRONMENTS).toContain("surface");
  });
});

describe("buildDeployReceipt", () => {
  it("builds a completed deploy receipt from a valid candidate", () => {
    const receipt = buildDeployReceipt({
      receiptId: "deploy-1",
      candidate: validCandidate(),
      deployedAt: "2026-07-28T12:00:00.000Z",
      actor: "harbor",
    });
    expect(receipt).toMatchObject({
      schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
      kind: "deploy",
      receiptId: "deploy-1",
      imageDigest: DIGEST,
      previousImageDigest: PREV_DIGEST,
      environment: "surface",
      service: "paperclip.service",
      prRef: "refs/pull/42/head",
      headRef: HEAD,
      argusAccepted: true,
      ciGreen: true,
      actor: "harbor",
      idempotencyKey: "release-42",
      deployedAt: "2026-07-28T12:00:00.000Z",
      state: "completed",
    });
  });

  it("refuses to build a receipt for an invalid candidate", () => {
    expect(() =>
      buildDeployReceipt({
        receiptId: "deploy-1",
        candidate: validCandidate({ argusAccepted: false }),
      }),
    ).toThrow(/argus_not_accepted/);
  });
});

describe("evaluateHealth", () => {
  const now = Date.parse("2026-07-28T12:10:00.000Z");

  it("returns unknown when there are no signals", () => {
    expect(evaluateHealth([], 60_000, now)).toBe("unknown");
    expect(evaluateHealth(null, 60_000, now)).toBe("unknown");
  });

  it("returns unhealthy if any signal is unhealthy", () => {
    const verdict = evaluateHealth(
      [
        { name: "http", healthy: true, observedAt: "2026-07-28T12:00:00.000Z" },
        { name: "ready", healthy: false, observedAt: "2026-07-28T12:09:00.000Z" },
      ],
      60_000,
      now,
    );
    expect(verdict).toBe("unhealthy");
  });

  it("returns unknown while soak window is incomplete", () => {
    const verdict = evaluateHealth(
      [{ name: "http", healthy: true, observedAt: "2026-07-28T12:09:30.000Z" }],
      60_000,
      now,
    );
    expect(verdict).toBe("unknown");
  });

  it("returns healthy after soak with all healthy signals", () => {
    const verdict = evaluateHealth(
      [
        { name: "http", healthy: true, observedAt: "2026-07-28T12:00:00.000Z" },
        { name: "ready", healthy: true, observedAt: "2026-07-28T12:09:00.000Z" },
      ],
      60_000,
      now,
    );
    expect(verdict).toBe("healthy");
  });

  it("returns unknown for unparseable observation times", () => {
    expect(
      evaluateHealth(
        [{ name: "http", healthy: true, observedAt: "not-a-date" }],
        1,
        now,
      ),
    ).toBe("unknown");
  });
});

describe("shouldRollback + buildRollbackReceipt", () => {
  const deployReceipt: DeployReceipt = buildDeployReceipt({
    receiptId: "deploy-1",
    candidate: validCandidate(),
    deployedAt: "2026-07-28T12:00:00.000Z",
    actor: "harbor",
  });

  it("rolls back only on confirmed unhealthy health", () => {
    expect(shouldRollback("unhealthy", deployReceipt)).toBe(true);
    expect(shouldRollback("healthy", deployReceipt)).toBe(false);
    expect(shouldRollback("unknown", deployReceipt)).toBe(false);
    expect(shouldRollback("unhealthy", null)).toBe(false);
  });

  it("builds a rollback receipt bound to the deploy", () => {
    const rollback = buildRollbackReceipt({
      receiptId: "rollback-1",
      deployReceipt,
      healthVerdict: "unhealthy",
      reason: "post-deploy health failed after soak",
      rolledBackAt: "2026-07-28T12:15:00.000Z",
      verified: true,
    });
    expect(rollback).toMatchObject({
      schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
      kind: "rollback",
      receiptId: "rollback-1",
      deployReceiptId: "deploy-1",
      fromImageDigest: DIGEST,
      toImageDigest: PREV_DIGEST,
      environment: "surface",
      service: "paperclip.service",
      reason: "post-deploy health failed after soak",
      healthVerdict: "unhealthy",
      rolledBackAt: "2026-07-28T12:15:00.000Z",
      verified: true,
      state: "completed",
    });
  });

  it("defaults verified to false (fail closed on verification)", () => {
    const rollback = buildRollbackReceipt({
      receiptId: "rollback-2",
      deployReceipt,
      healthVerdict: "unhealthy",
      reason: "unverified rollback",
    });
    expect(rollback.verified).toBe(false);
  });
});
