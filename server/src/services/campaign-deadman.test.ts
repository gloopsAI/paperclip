import { describe, expect, it } from "vitest";
import {
  admitCampaignRun,
  CAMPAIGN_DEADMAN_SCHEMA_VERSION,
  parseCampaignDeadmanPolicy,
  type CampaignDeadmanPolicy,
} from "./campaign-deadman.js";

const policy: CampaignDeadmanPolicy = {
  campaignId: "controlled-swarm-20260717",
  socketPath: "/run/paperclip-campaign/deadman.sock",
  durationSeconds: 86_400,
  timeoutMs: 2_000,
};
const firstAdmittedAt = "2026-07-17T07:00:00.000Z";
const deadlineAt = "2026-07-18T07:00:00.000Z";

describe("campaign deadman policy", () => {
  it("requires the fixed 24-hour campaign boundary as a complete pair", () => {
    expect(parseCampaignDeadmanPolicy({})).toBeNull();
    expect(() => parseCampaignDeadmanPolicy({
      PAPERCLIP_CAMPAIGN_ID: policy.campaignId,
    })).toThrow("must be configured together");
    expect(() => parseCampaignDeadmanPolicy({
      PAPERCLIP_CAMPAIGN_ID: policy.campaignId,
      PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: policy.socketPath,
      PAPERCLIP_CAMPAIGN_DURATION_SECONDS: "86401",
    })).toThrow("must be between 86400 and 86400");
    expect(parseCampaignDeadmanPolicy({
      PAPERCLIP_CAMPAIGN_ID: policy.campaignId,
      PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: policy.socketPath,
      PAPERCLIP_CAMPAIGN_DURATION_SECONDS: "86400",
      PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS: "1500",
    })).toEqual({ ...policy, timeoutMs: 1_500 });
  });

  it("accepts only an attributable, unexpired, exact-duration epoch", async () => {
    const receipt = await admitCampaignRun(
      policy,
      {
        companyId: "company-1",
        runId: "run-1",
        now: new Date("2026-07-17T07:00:01.000Z"),
      },
      async (_policy, request) => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "armed",
        campaignId: request.campaignId,
        companyId: request.companyId,
        firstRunId: request.runId,
        firstAdmittedAt,
        deadlineAt,
        durationSeconds: 86_400,
        epochSha256: `sha256:${"a".repeat(64)}`,
      }),
    );

    expect(receipt).toMatchObject({
      campaignId: policy.campaignId,
      companyId: "company-1",
      firstRunId: "run-1",
      deadlineAt,
    });
  });

  it("fails closed on denial, mismatch, and expiry", async () => {
    await expect(admitCampaignRun(
      policy,
      { companyId: "company-1", runId: "run-1" },
      async () => ({ allowed: false, reason: "expired" }),
    )).rejects.toThrow("denied admission: expired");

    await expect(admitCampaignRun(
      policy,
      { companyId: "company-1", runId: "run-1" },
      async () => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "active",
        campaignId: "different-campaign",
        companyId: "company-1",
        firstRunId: "run-1",
        firstAdmittedAt,
        deadlineAt,
        durationSeconds: 86_400,
        epochSha256: `sha256:${"b".repeat(64)}`,
      }),
    )).rejects.toThrow("mismatched epoch receipt");

    await expect(admitCampaignRun(
      policy,
      {
        companyId: "company-1",
        runId: "run-1",
        now: new Date(deadlineAt),
      },
      async () => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "active",
        campaignId: policy.campaignId,
        companyId: "company-1",
        firstRunId: "run-1",
        firstAdmittedAt,
        deadlineAt,
        durationSeconds: 86_400,
        epochSha256: `sha256:${"c".repeat(64)}`,
      }),
    )).rejects.toThrow("invalid or expired deadline");
  });
});
