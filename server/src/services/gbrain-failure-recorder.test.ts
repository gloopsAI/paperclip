import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE,
  GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT,
  GBRAIN_RECENT_FINGERPRINT_SCHEMA,
  configureGbrainFailureBufferSize,
  getRecentFingerprints,
  getRecordedFailureEntryCount,
  recordServerFailure,
  resetGbrainFailureRecorder,
} from "./gbrain-failure-recorder.js";
import { FAILURE_FINGERPRINT_SCHEMA } from "./gbrain-microplane.js";

afterEach(() => {
  resetGbrainFailureRecorder();
});

describe("gbrain-failure-recorder", () => {
  it("records a normalized failure fingerprint for a company", () => {
    const ok = recordServerFailure({
      companyId: "company-1",
      errorCode: "package_not_found",
      message: "apt package foo-bar not found on host",
      tool: "shell",
      stage: "workspace_prep",
      recoveryHint: "install via hermes image layer, not apt at runtime",
    });
    expect(ok).toBe(true);

    const res = getRecentFingerprints("company-1", 10);
    expect(res.schemaVersion).toBe(GBRAIN_RECENT_FINGERPRINT_SCHEMA);
    expect(res.advisory).toBe(true);
    expect(res.companyId).toBe("company-1");
    expect(res.count).toBe(1);
    expect(res.fingerprints[0]).toMatchObject({
      schemaVersion: FAILURE_FINGERPRINT_SCHEMA,
      advisory: true,
      errorCode: "package_not_found",
    });
    expect(res.fingerprints[0]?.key).toContain("error:package_not_found");
  });

  it("returns newest-first ordering", () => {
    recordServerFailure({
      companyId: "company-1",
      errorCode: "error_a",
      message: "first failure",
    });
    recordServerFailure({
      companyId: "company-1",
      errorCode: "error_b",
      message: "second failure",
    });
    recordServerFailure({
      companyId: "company-1",
      errorCode: "error_c",
      message: "third failure",
    });

    const res = getRecentFingerprints("company-1", 10);
    expect(res.count).toBe(3);
    expect(res.fingerprints.map((f) => f.errorCode)).toEqual([
      "error_c",
      "error_b",
      "error_a",
    ]);
  });

  it("partitions by companyId so other companies cannot read entries", () => {
    recordServerFailure({
      companyId: "company-1",
      errorCode: "error_a",
      message: "company 1 failure",
    });
    recordServerFailure({
      companyId: "company-2",
      errorCode: "error_b",
      message: "company 2 failure",
    });

    expect(getRecentFingerprints("company-1", 10).count).toBe(1);
    expect(getRecentFingerprints("company-2", 10).count).toBe(1);
    expect(getRecentFingerprints("company-3", 10).count).toBe(0);
  });

  it("respects the ring buffer cap and drops oldest entries", () => {
    configureGbrainFailureBufferSize(3);
    for (let i = 0; i < 5; i += 1) {
      recordServerFailure({
        companyId: "company-1",
        errorCode: `error_${i}`,
        message: `failure ${i}`,
      });
    }

    const res = getRecentFingerprints("company-1", 10);
    expect(res.count).toBe(3);
    expect(res.bufferSize).toBe(3);
    expect(res.fingerprints.map((f) => f.errorCode)).toEqual([
      "error_4",
      "error_3",
      "error_2",
    ]);
  });

  it("clamps the hard limit on getRecentFingerprints", () => {
    for (let i = 0; i < GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT + 5; i += 1) {
      recordServerFailure({
        companyId: "company-1",
        errorCode: `error_${i}`,
        message: `failure ${i}`,
      });
    }
    const res = getRecentFingerprints(
      "company-1",
      GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT + 100,
    );
    expect(res.count).toBe(GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT);
  });

  it("infers stage from method+url when caller did not provide one", () => {
    const ok = recordServerFailure({
      companyId: "company-1",
      errorCode: "internal_error",
      message: "kaboom",
      method: "post",
      url: "/api/companies/abc/issues",
    });
    expect(ok).toBe(true);
    const res = getRecentFingerprints("company-1", 10);
    expect(res.fingerprints[0]?.stage).toBe("post_api_companies_abc_issues");
  });

  it("returns false and never throws for unusable input", () => {
    expect(
      recordServerFailure({
        companyId: "company-1",
        errorCode: "",
        message: "no error code",
      }),
    ).toBe(false);
    expect(
      recordServerFailure({
        companyId: "company-1",
        errorCode: "ok_code",
        message: "",
      }),
    ).toBe(false);
    expect(getRecordedFailureEntryCount()).toBe(0);
  });

  it("returns an empty advisory envelope for unknown companies", () => {
    const res = getRecentFingerprints("never-seen", 10);
    expect(res.advisory).toBe(true);
    expect(res.count).toBe(0);
    expect(res.fingerprints).toEqual([]);
    expect(res.companyId).toBe("never-seen");
  });

  it("reconfiguring buffer size trims existing overflow", () => {
    for (let i = 0; i < 5; i += 1) {
      recordServerFailure({
        companyId: "company-1",
        errorCode: `error_${i}`,
        message: `failure ${i}`,
      });
    }
    configureGbrainFailureBufferSize(2);
    const res = getRecentFingerprints("company-1", 10);
    expect(res.count).toBe(2);
    expect(res.fingerprints.map((f) => f.errorCode)).toEqual([
      "error_4",
      "error_3",
    ]);
  });

  it("uses default buffer size after reset", () => {
    configureGbrainFailureBufferSize(8);
    resetGbrainFailureRecorder();
    recordServerFailure({
      companyId: "company-1",
      errorCode: "x",
      message: "y",
    });
    const res = getRecentFingerprints("company-1", 10);
    expect(res.bufferSize).toBe(DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE);
  });
});
