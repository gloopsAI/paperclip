import { describe, expect, it } from "vitest";
import {
  admitCampaignRun,
  admitExecutionCampaign,
  CAMPAIGN_DEADMAN_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_DURATION_SECONDS,
  MAX_CAMPAIGN_DURATION_SECONDS,
  MIN_CAMPAIGN_DURATION_SECONDS,
  enforceCampaignExecutionDeadline,
  parseCampaignDeadmanPolicy,
  parseExecutionCampaignPolicy,
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

const THIRTY_DAYS_SECONDS = 2_592_000;
const thirtyDayPolicy: CampaignDeadmanPolicy = {
  ...policy,
  durationSeconds: THIRTY_DAYS_SECONDS,
};
const thirtyDayDeadlineAt = "2026-08-16T07:00:00.000Z";

const configured = (
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
  PAPERCLIP_CAMPAIGN_ID: policy.campaignId,
  PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: policy.socketPath,
  ...overrides,
});

describe("campaign deadman policy", () => {
  it("admits general execution without campaign environment or a socket call", async () => {
    const general = parseExecutionCampaignPolicy({
      PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE: "general",
    });
    let campaignAdmissionCalls = 0;
    await expect(admitExecutionCampaign(
      general,
      { companyId: "company-1", runId: "run-1" },
      async () => {
        campaignAdmissionCalls += 1;
        throw new Error("general execution touched the campaign deadman");
      },
    )).resolves.toBeNull();
    expect(campaignAdmissionCalls).toBe(0);
    expect(enforceCampaignExecutionDeadline({
      policy: general,
      receipt: null,
      budget: null,
    })).toBeNull();
  });

  it("requires explicit, non-ambiguous campaign scoping", () => {
    expect(parseExecutionCampaignPolicy(configured({
      PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE: "campaign-bound",
    }))).toEqual({ scope: "campaign-bound", deadman: policy });
    expect(() => parseExecutionCampaignPolicy(configured({
      PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE: "general",
    }))).toThrow("general execution must not inherit campaign configuration");
    expect(() => parseExecutionCampaignPolicy({
      PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE: "campaign-bound",
    })).toThrow("requires a complete campaign deadman policy");
  });

  it("caps an in-flight campaign invocation at the epoch and refuses expiry", () => {
    const campaign = parseExecutionCampaignPolicy(configured({
      PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE: "campaign-bound",
    }));
    const receipt = {
      schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
      campaignId: policy.campaignId,
      companyId: "company-1",
      firstRunId: "run-1",
      firstAdmittedAt,
      deadlineAt,
      durationSeconds: policy.durationSeconds,
      epochSha256: `sha256:${"a".repeat(64)}`,
    };
    const budget = {
      schemaVersion: "paperclip.provider-invocation-budget.v1" as const,
      budgetId: "budget-1",
      reservationId: "a".repeat(64),
      maxInputTokens: 1_000,
      maxOutputTokens: 500,
      maxTurns: 8,
      maxToolCalls: 32,
      maxWallMs: 60_000,
    };
    const capped = enforceCampaignExecutionDeadline({
      policy: campaign,
      receipt,
      budget,
      now: new Date("2026-07-18T06:59:30.000Z"),
    });
    expect(capped?.maxWallMs).toBe(30_000);
    expect(Object.values(capped?.phasePlan ?? {}).reduce((sum, phase) => sum + phase.wallMs, 0))
      .toBe(30_000);
    expect(() => enforceCampaignExecutionDeadline({
      policy: campaign,
      receipt,
      budget,
      now: new Date(deadlineAt),
    })).toThrow("campaign epoch expired before adapter invocation");
    expect(() => enforceCampaignExecutionDeadline({
      policy: campaign,
      receipt,
      budget: null,
      now: new Date("2026-07-18T06:59:30.000Z"),
    })).toThrow("strict adapter wall-time budget");
  });

  it("requires the campaign id and deadman socket as a complete pair", () => {
    expect(parseCampaignDeadmanPolicy({})).toBeNull();
    expect(() => parseCampaignDeadmanPolicy({
      PAPERCLIP_CAMPAIGN_ID: policy.campaignId,
    })).toThrow("must be configured together");
    expect(() => parseCampaignDeadmanPolicy({
      PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET: policy.socketPath,
    })).toThrow("must be configured together");
  });

  // CONTRACT CHANGE: the duration used to be hard-pinned to exactly 86400, so
  // the plane halted every 24 hours with no way to configure anything longer.
  // It is now a bounded range. These literals are the drift tripwire against
  // gloops-distribution/deploy/hermes/campaign-deadman.py, whose
  // campaign_deadman_test.py asserts the same three numbers.
  it("bounds the campaign duration to 1h..30d and defaults to 24h", () => {
    expect(MIN_CAMPAIGN_DURATION_SECONDS).toBe(3_600);
    expect(MAX_CAMPAIGN_DURATION_SECONDS).toBe(2_592_000);
    expect(DEFAULT_CAMPAIGN_DURATION_SECONDS).toBe(86_400);
  });

  it("accepts any whole-second duration inside the bounded range", () => {
    for (const durationSeconds of [3_600, 86_400, 2_592_000]) {
      expect(parseCampaignDeadmanPolicy(configured({
        PAPERCLIP_CAMPAIGN_DURATION_SECONDS: String(durationSeconds),
      }))).toEqual({ ...policy, durationSeconds });
    }
    expect(parseCampaignDeadmanPolicy(configured({
      PAPERCLIP_CAMPAIGN_DURATION_SECONDS: "86400",
      PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS: "1500",
    }))).toEqual({ ...policy, timeoutMs: 1_500 });
  });

  it("keeps the 24-hour epoch when the duration is unset or empty", () => {
    expect(parseCampaignDeadmanPolicy(configured())).toEqual(policy);
    expect(parseCampaignDeadmanPolicy(configured({
      PAPERCLIP_CAMPAIGN_DURATION_SECONDS: "   ",
    }))).toEqual(policy);
  });

  it("refuses any duration outside the bounded range", () => {
    for (const raw of ["3599", "2592001", "0", "-1", "86400.0", "nope", "1e5"]) {
      const parse = () => parseCampaignDeadmanPolicy(configured({
        PAPERCLIP_CAMPAIGN_DURATION_SECONDS: raw,
      }));
      expect(parse).toThrow(
        "PAPERCLIP_CAMPAIGN_DURATION_SECONDS must be a whole number of seconds "
          + "between 3600 and 2592000 inclusive",
      );
      // The rejected value is echoed back, as the Python broker does, so an
      // operator can see what the unit file or runtime.env actually supplied.
      expect(parse).toThrow(raw);
    }
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

  // The admission checks are exact against `policy.durationSeconds`, so proving
  // them at 86400 alone proves nothing about a configured epoch. A 30-day
  // policy must admit a 30-day receipt end to end.
  it("admits a 30-day receipt under a 30-day policy", async () => {
    const receipt = await admitCampaignRun(
      thirtyDayPolicy,
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
        deadlineAt: thirtyDayDeadlineAt,
        durationSeconds: THIRTY_DAYS_SECONDS,
        epochSha256: `sha256:${"d".repeat(64)}`,
      }),
    );

    expect(receipt).toMatchObject({
      campaignId: thirtyDayPolicy.campaignId,
      durationSeconds: THIRTY_DAYS_SECONDS,
      firstAdmittedAt,
      deadlineAt: thirtyDayDeadlineAt,
    });
    expect(Date.parse(receipt.deadlineAt) - Date.parse(receipt.firstAdmittedAt))
      .toBe(THIRTY_DAYS_SECONDS * 1_000);
  });

  it("refuses a receipt whose epoch disagrees with a 30-day policy", async () => {
    // The broker reports a different duration than the policy holds — the two
    // halves were started with different configuration.
    await expect(admitCampaignRun(
      thirtyDayPolicy,
      { companyId: "company-1", runId: "run-1" },
      async () => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "armed",
        campaignId: thirtyDayPolicy.campaignId,
        companyId: "company-1",
        firstRunId: "run-1",
        firstAdmittedAt,
        deadlineAt: thirtyDayDeadlineAt,
        durationSeconds: 86_400,
        epochSha256: `sha256:${"e".repeat(64)}`,
      }),
    )).rejects.toThrow("mismatched epoch receipt");

    // The duration agrees but the deadline span does not: a 24-hour window
    // wearing a 30-day label must not be admitted as a 30-day epoch.
    await expect(admitCampaignRun(
      thirtyDayPolicy,
      {
        companyId: "company-1",
        runId: "run-1",
        now: new Date("2026-07-17T07:00:01.000Z"),
      },
      async () => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "armed",
        campaignId: thirtyDayPolicy.campaignId,
        companyId: "company-1",
        firstRunId: "run-1",
        firstAdmittedAt,
        deadlineAt,
        durationSeconds: THIRTY_DAYS_SECONDS,
        epochSha256: `sha256:${"f".repeat(64)}`,
      }),
    )).rejects.toThrow("invalid or expired deadline");
  });

  it("admits a 1-hour receipt under a 1-hour policy", async () => {
    const receipt = await admitCampaignRun(
      { ...policy, durationSeconds: MIN_CAMPAIGN_DURATION_SECONDS },
      {
        companyId: "company-1",
        runId: "run-1",
        now: new Date("2026-07-17T07:00:01.000Z"),
      },
      async () => ({
        schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
        allowed: true,
        status: "armed",
        campaignId: policy.campaignId,
        companyId: "company-1",
        firstRunId: "run-1",
        firstAdmittedAt,
        deadlineAt: "2026-07-17T08:00:00.000Z",
        durationSeconds: MIN_CAMPAIGN_DURATION_SECONDS,
        epochSha256: `sha256:${"1".repeat(64)}`,
      }),
    );

    expect(receipt.durationSeconds).toBe(MIN_CAMPAIGN_DURATION_SECONDS);
  });
});
