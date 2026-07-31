import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEASUREMENT_INTAKE_SCHEMA_VERSION,
  MEASUREMENT_PHASE1_WINDOWS,
  buildCohort,
  buildIssueIntake,
  buildPhase1Intake,
  formatPercent,
  formatTopProviders,
  normalizeHeartbeatUsage,
  parseIsoTimestamp,
  readPhase1Intake,
  registerMeasurementCommands,
  renderPhase1Display,
  writePhase1Intake,
  type Phase1Intake,
  type RawHeartbeatRun,
} from "../commands/client/measurement.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const ISSUE_A = "44444444-4444-4444-8444-444444444444";
const ISSUE_B = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-07-30T16:00:00.000Z");

function makeRun(overrides: Partial<RawHeartbeatRun> = {}): RawHeartbeatRun {
  return {
    id: cryptoRandom(),
    status: "succeeded",
    startedAt: "2026-07-30T15:00:00.000Z",
    createdAt: "2026-07-30T15:00:00.000Z",
    finishedAt: "2026-07-30T15:05:00.000Z",
    agentId: "agent-1",
    usageJson: {
      provider: "ollama-cloud",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      executionRoute: { routing_reason: "preferred", provider_id: "ollama-cloud" },
    },
    ...overrides,
  };
}

function cryptoRandom(): string {
  // Deterministic enough for tests; no Math.random for repeatability.
  return `r-${Math.floor((Date.now() + Math.random() * 1e9) * 1000).toString(16)}`;
}

describe("measurement consumer — pure helpers", () => {
  it("parseIsoTimestamp normalises trailing Z and rejects junk", () => {
    expect(parseIsoTimestamp("2026-07-30T16:00:00Z")?.toISOString()).toBe(
      "2026-07-30T16:00:00.000Z",
    );
    expect(parseIsoTimestamp("2026-07-30T16:00:00")?.toISOString()).toBe(
      "2026-07-30T16:00:00.000Z",
    );
    expect(parseIsoTimestamp(null)).toBeNull();
    expect(parseIsoTimestamp("not-a-date")).toBeNull();
  });

  it("normalizeHeartbeatUsage handles missing/null/stringified usage", () => {
    const norm = normalizeHeartbeatUsage(null);
    expect(norm.provider).toBe("unknown");
    expect(norm.inputTokens).toBe(0);
    expect(norm.routingReason).toBe("unset");

    const fromObject = normalizeHeartbeatUsage({
      provider: "grok",
      inputTokens: 5,
      cachedInputTokens: 2,
      outputTokens: 7,
      executionRoute: { routing_reason: "grok-fallback", provider_id: "grok" },
    });
    expect(fromObject.provider).toBe("grok");
    expect(fromObject.inputTokens).toBe(5);
    expect(fromObject.outputTokens).toBe(7);
    expect(fromObject.routingReason).toBe("grok-fallback");

    const fromStringUsage = normalizeHeartbeatUsage(
      JSON.stringify({ biller: "codex", inputTokens: 1, outputTokens: 2 }),
    );
    // Non-object usage (including stringified JSON) returns the empty sentinel;
    // this matches the canonical producer's expectation that usageJson is a dict.
    expect(fromStringUsage.provider).toBe("unknown");
    expect(fromStringUsage.inputTokens).toBe(0);
  });

  it("formatPercent renders nullable fraction safely", () => {
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(0.5)).toBe("50.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("formatTopProviders orders + truncates", () => {
    expect(formatTopProviders({})).toBe("(none)");
    expect(formatTopProviders({ a: 1, b: 2, c: 3 })).toBe("c:3, b:2, a:1");
    expect(formatTopProviders({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 2)).toBe("e:5, d:4");
  });

  it("buildCohort filters by createdAt/startedAt window and tallies by status", () => {
    const runs: RawHeartbeatRun[] = [
      makeRun({ id: "r1", status: "succeeded", startedAt: "2026-07-30T15:00:00.000Z" }),
      makeRun({
        id: "r2",
        status: "failed",
        startedAt: "2026-07-29T15:00:00.000Z",
        usageJson: { provider: "grok", inputTokens: 0, outputTokens: 0 },
      }),
      makeRun({
        id: "r3",
        status: "cancelled",
        startedAt: "2026-07-29T10:00:00.000Z",
        usageJson: { provider: "ollama-cloud", inputTokens: 1, outputTokens: 1 },
      }),
      makeRun({
        id: "r4",
        status: "succeeded",
        startedAt: "2026-07-15T00:00:00.000Z",
        usageJson: { provider: "codex", inputTokens: 9999, outputTokens: 1 },
      }),
    ];

    const oneDay = buildCohort({ runs, windowDays: 1, now: NOW });
    expect(oneDay.run_count_in_sample).toBe(1);
    expect(oneDay.succeeded).toBe(1);
    expect(oneDay.failed).toBe(0);
    expect(oneDay.cancelled).toBe(0);
    expect(oneDay.success_rate_ex_cancel).toBe(1);
    expect(oneDay.tokens_in).toBe(100);

    const threeDay = buildCohort({ runs, windowDays: 3, now: NOW });
    expect(threeDay.run_count_in_sample).toBe(3);
    expect(threeDay.succeeded).toBe(1);
    expect(threeDay.failed).toBe(1);
    expect(threeDay.cancelled).toBe(1);
    expect(threeDay.success_rate_ex_cancel).toBe(0.5);
    expect(threeDay.tokens_in).toBe(101);
    expect(threeDay.providers).toEqual({
      "ollama-cloud": 2,
      grok: 1,
    });

    const fourteenDay = buildCohort({ runs, windowDays: 14, now: NOW });
    // 14-day window cuts at 2026-07-16T16:00:00Z; r4 at 2026-07-15 falls outside.
    expect(fourteenDay.run_count_in_sample).toBe(3);
    expect(fourteenDay.tokens_in).toBe(101);
  });

  it("buildCohort handles runs with missing timestamps as out-of-window", () => {
    const runs: RawHeartbeatRun[] = [
      makeRun({ id: "r1", status: "succeeded", startedAt: undefined, createdAt: undefined }),
    ];
    const cohort = buildCohort({ runs, windowDays: 1, now: NOW });
    expect(cohort.run_count_in_sample).toBe(0);
  });

  it("buildIssueIntake tallies status, tokens, providers", () => {
    // Use run fixtures with explicit inputTokens counts so the assertion is
    // deterministic; normalizeHeartbeatUsage() sums inputTokens + rawInputTokens
    // (NOT cached) per the canonical producer algorithm.
    const runs: RawHeartbeatRun[] = [
      makeRun({ id: "r1", status: "succeeded", usageJson: { provider: "ollama-cloud", inputTokens: 10, outputTokens: 5 } }),
      makeRun({
        id: "r2",
        status: "failed",
        usageJson: { provider: "codex", inputTokens: 10, outputTokens: 5 },
      }),
      makeRun({
        id: "r3",
        status: "succeeded",
        usageJson: { provider: "codex", inputTokens: 10, outputTokens: 1 },
      }),
    ];
    const intake = buildIssueIntake({
      issueRef: ISSUE_A,
      runs,
      costSummary: { totalCents: 12 },
    });
    expect(intake.issue_ref).toBe(ISSUE_A);
    expect(intake.run_count).toBe(3);
    expect(intake.succeeded).toBe(2);
    expect(intake.failed).toBe(1);
    expect(intake.tokens_in).toBe(30);
    expect(intake.tokens_out).toBe(11);
    expect(intake.providers).toEqual({
      codex: 2,
      "ollama-cloud": 1,
    });
    expect(intake.cost_summary).toEqual({ totalCents: 12 });
    expect(intake.cost_summary_error).toBeUndefined();
  });

  it("buildIssueIntake captures cost-summary error when supplied", () => {
    const intake = buildIssueIntake({
      issueRef: ISSUE_B,
      runs: [],
      costSummary: null,
      costSummaryError: "404 Not Found",
    });
    expect(intake.cost_summary_error).toBe("404 Not Found");
    expect(intake.run_count).toBe(0);
  });
});

describe("measurement consumer — buildPhase1Intake", () => {
  it("produces intake shape identical to canonical producer schema (cohorts, sources, instruments)", async () => {
    const runs: RawHeartbeatRun[] = [
      makeRun({
        id: "r-in-window",
        status: "succeeded",
        startedAt: "2026-07-30T15:30:00.000Z",
        usageJson: { provider: "ollama-cloud", inputTokens: 200, outputTokens: 100 },
      }),
      makeRun({
        id: "r-fail",
        status: "failed",
        startedAt: "2026-07-29T15:30:00.000Z",
        usageJson: { provider: "grok", inputTokens: 50, outputTokens: 10 },
      }),
    ];
    const intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: runs,
      costsSummary: { ok: true },
      costsByProvider: { providers: [] },
      subscriptionEconomics: { truth: "subscription-economics" },
      issues: [{ id: ISSUE_A }, { id: ISSUE_B }],
      fetchIssueRuns: async (issueId) => {
        if (issueId === ISSUE_A) return [
          makeRun({ id: "issueA-1", status: "succeeded" }),
        ];
        return [];
      },
      fetchIssueCostSummary: async (issueId) => {
        if (issueId === ISSUE_A) return { totalCents: 5 };
        throw new Error("not_found");
      },
      generatedAt: NOW,
    });

    expect(intake.schema_version).toBe(MEASUREMENT_INTAKE_SCHEMA_VERSION);
    expect(intake.company_id).toBe(COMPILED_DATA);
    // sanity: schema marker present
    expect(intake.schema_version).toMatch(/^paperclip\.measurement-spine/);

    // canonical schema: every window key present, every cohort has window_days
    for (const w of MEASUREMENT_PHASE1_WINDOWS) {
      expect(intake.cohorts[w]).toBeDefined();
      expect(typeof intake.cohorts[w].window_days).toBe("number");
      expect(intake.cohorts[w]).toHaveProperty("run_count_in_sample");
      expect(intake.cohorts[w]).toHaveProperty("status_counts");
      expect(intake.cohorts[w]).toHaveProperty("tokens_in");
      expect(intake.cohorts[w]).toHaveProperty("providers");
      expect(intake.cohorts[w]).toHaveProperty("routing_reasons");
      expect(intake.cohorts[w]).toHaveProperty("sample_note");
    }

    // instruments_not_trusted list mirrors the canonical producer's stance
    expect(intake.instruments_not_trusted).toContain(
      "spentMonthlyCents (inert $0 class)",
    );
    expect(intake.instruments_not_trusted).toContain(
      "agent self-report done-counts",
    );

    // source URLs are present and ok=true for the synchronous endpoints
    expect(intake.sources.heartbeat_runs.url).toBe(
      `/api/companies/${COMPANY_ID}/heartbeat-runs?limit=500`,
    );
    expect(intake.sources.costs_summary.url).toBe(
      `/api/companies/${COMPANY_ID}/costs/summary`,
    );
    expect(intake.sources.costs_by_provider.url).toBe(
      `/api/companies/${COMPANY_ID}/costs/by-provider`,
    );
    expect(intake.sources.costs_subscription_economics.url).toBe(
      `/api/companies/${COMPANY_ID}/costs/subscription-economics`,
    );
    expect(intake.sources.issue_runs).toHaveLength(2);
    expect(intake.sources.issue_cost_summary).toHaveLength(2);
    expect(intake.sources.issue_cost_summary[0].ok).toBe(true);
    expect(intake.sources.issue_cost_summary[1].ok).toBe(false);
    expect(intake.sources.issue_cost_summary[1].error).toMatch(/not_found/);

    expect(intake.run_sample_size).toBe(2);
    expect(intake.oldest_run_in_sample).toBe("2026-07-29T15:30:00.000Z");
    expect(intake.newest_run_in_sample).toBe("2026-07-30T15:30:00.000Z");

    expect(intake.costs_summary).toEqual({ ok: true });
    expect(intake.costs_by_provider).toEqual({ providers: [] });
    expect(intake.subscription_economics).toEqual({ truth: "subscription-economics" });

    expect(intake.issue_intakes).toHaveLength(2);
    expect(intake.issue_intakes[0].issue_ref).toBe(ISSUE_A);
    expect(intake.issue_intakes[0].run_count).toBe(1);
    expect(intake.issue_intakes[0].cost_summary).toEqual({ totalCents: 5 });
    expect(intake.issue_intakes[1].cost_summary_error).toBe("not_found");
  });

  it("computed cohort counts match the canonical producer's algorithm", async () => {
    // Cross-check: the canonical /opt/data/bin/measurement-spine-report.py
    // computes cohort counts as: succeeded = sum(status in {succeeded,success,completed}),
    // failed = sum(status in {failed,error,timed_out,timeout}),
    // cancelled = sum(status in {cancelled,canceled}),
    // success_rate_ex_cancel = succeeded / (succeeded + failed).
    // This consumer must match.
    const runs: RawHeartbeatRun[] = [
      makeRun({ id: "s1", status: "succeeded" }),
      makeRun({ id: "s2", status: "success" }),
      makeRun({ id: "s3", status: "completed" }),
      makeRun({ id: "f1", status: "failed" }),
      makeRun({ id: "f2", status: "error" }),
      makeRun({ id: "f3", status: "timed_out" }),
      makeRun({ id: "f4", status: "timeout" }),
      makeRun({ id: "c1", status: "cancelled" }),
      makeRun({ id: "c2", status: "canceled" }),
      makeRun({ id: "x1", status: "queued" }),
      makeRun({ id: "x2", status: "running" }),
    ];
    const intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: runs,
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const sevenDay = intake.cohorts["7d"];
    expect(sevenDay.succeeded).toBe(3);
    expect(sevenDay.failed).toBe(4);
    expect(sevenDay.cancelled).toBe(2);
    expect(sevenDay.run_count_in_sample).toBe(11);
    // 3 succeeded / (3 succeeded + 4 failed) = 3/7
    expect(sevenDay.success_rate_ex_cancel).toBeCloseTo(3 / 7);
  });
});

describe("measurement consumer — render + IO", () => {
  it("renderPhase1Display produces a stable, table-formatted report", async () => {
    const intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [
        makeRun({
          status: "succeeded",
          startedAt: "2026-07-30T15:00:00.000Z",
        }),
      ],
      costsSummary: { ok: true },
      costsByProvider: {},
      subscriptionEconomics: {},
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const report = renderPhase1Display(intake);
    expect(report).toContain(`Phase-1 measurement intake — ${COMPANY_ID}`);
    expect(report).toContain("Cohorts");
    expect(report).toContain("success%");
    expect(report).toContain("ollama-cloud");
    expect(report).toMatch(/1d/);
    expect(report).toMatch(/14d/);
    expect(report).toContain("spentMonthlyCents");
  });

  it("writePhase1Intake + readPhase1Intake round-trips and validates schema", async () => {
    const intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [makeRun({ status: "succeeded" })],
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "measurement-intake-"));
    const file = path.join(dir, "intake.json");
    const written = await writePhase1Intake(intake, file);
    expect(written).toBe(file);
    expect(fs.existsSync(file)).toBe(true);
    const parsed = await readPhase1Intake(file);
    expect(parsed.schema_version).toBe(MEASUREMENT_INTAKE_SCHEMA_VERSION);
    expect(parsed.company_id).toBe(intake.company_id);
    expect(parsed.generated_at).toBe(intake.generated_at);

    // schema mismatch must reject
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ schema_version: "wrong" }), "utf8");
    await expect(readPhase1Intake(bad)).rejects.toThrow(/not schema/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("renderPhase1Display includes issue intakes when present", async () => {
    const intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [],
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [{ id: ISSUE_A }],
      fetchIssueRuns: async () => [
        makeRun({ status: "succeeded", usageJson: { provider: "codex", inputTokens: 1, outputTokens: 1 } }),
      ],
      fetchIssueCostSummary: async () => ({ totalCents: 42 }),
      generatedAt: NOW,
    });
    const report = renderPhase1Display(intake);
    expect(report).toContain(`Issue intakes (1)`);
    expect(report).toContain(ISSUE_A);
    expect(report).toContain("runs=1");
    expect(report).toContain("tokens_in=1");
    expect(report).toContain("codex");
  });
});

describe("measurement consumer — CLI command registration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "measurement-cli-"));
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createProgram(): Command {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerMeasurementCommands(program);
    return program;
  }

  it("registers intake/display/cohort-show subcommands under `measurement`", () => {
    const program = createProgram();
    const measurementCmd = program.commands.find((c) => c.name() === "measurement");
    expect(measurementCmd).toBeDefined();
    const subNames = (measurementCmd?.commands ?? []).map((c) => c.name()).sort();
    expect(subNames).toEqual(["cohort-show", "display", "intake"]);
  });

  it("`measurement display --intake <file>` reads the saved JSON and prints the table", async () => {
    const intake: Phase1Intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [makeRun({ status: "succeeded" })],
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const intakePath = path.join(tempDir, "intake.json");
    await writePhase1Intake(intake, intakePath);

    await createProgram().parseAsync([
      "measurement",
      "display",
      "--intake",
      intakePath,
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ], { from: "user" });

    const log = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(log).toContain("Phase-1 measurement intake");
  });

  it("`measurement display --json` emits raw JSON", async () => {
    const intake: Phase1Intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [],
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const intakePath = path.join(tempDir, "intake.json");
    await writePhase1Intake(intake, intakePath);

    await createProgram().parseAsync([
      "measurement",
      "display",
      "--intake",
      intakePath,
      "--json",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ], { from: "user" });

    const log = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(log).toContain(`"schema_version": "${MEASUREMENT_INTAKE_SCHEMA_VERSION}"`);
  });

  it("`measurement cohort-show --window 7d` returns the 7d cohort", async () => {
    const intake: Phase1Intake = await buildPhase1Intake({
      companyId: COMPANY_ID,
      heartbeatRuns: [makeRun({ status: "succeeded" }), makeRun({ status: "failed" })],
      costsSummary: null,
      costsByProvider: null,
      subscriptionEconomics: null,
      issues: [],
      fetchIssueRuns: async () => [],
      fetchIssueCostSummary: async () => null,
      generatedAt: NOW,
    });
    const intakePath = path.join(tempDir, "intake.json");
    await writePhase1Intake(intake, intakePath);

    await createProgram().parseAsync([
      "measurement",
      "cohort-show",
      "--intake",
      intakePath,
      "--window",
      "7d",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ], { from: "user" });

    const log = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => String(c[0]))
      .join("\n");
    expect(log).toContain("\"window\": \"7d\"");
    expect(log).toContain(`"company_id": "${COMPANY_ID}"`);
    expect(log).toContain(`"succeeded": 1`);
    expect(log).toContain(`"failed": 1`);
  });

  it("`measurement intake` issues the expected API calls (parity with cost + run)", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify([]), { status: 200 })),
      );
    vi.stubGlobal("fetch", fetchMock);

    await createProgram().parseAsync([
      "measurement",
      "intake",
      "--company-id",
      COMPANY_ID,
      "--out",
      path.join(tempDir, "intake.json"),
      "--run-limit",
      "5",
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ], { from: "user" });

    const methods = fetchMock.mock.calls.map((c) => [c[1]?.method ?? "GET", String(c[0])]);
    expect(methods).toEqual(
      expect.arrayContaining([
        ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/heartbeat-runs?limit=5`],
        ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/summary`],
        ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/by-provider`],
        ["GET", `http://localhost:3100/api/companies/${COMPANY_ID}/costs/subscription-economics`],
      ]),
    );
    expect(fs.existsSync(path.join(tempDir, "intake.json"))).toBe(true);
  });

  it("`measurement intake` paginates heartbeat runs beyond the configured page size", async () => {
    const firstPage = [
      makeRun({ id: "run-a", createdAt: "2026-07-30T15:00:00.000Z" }),
      makeRun({ id: "run-b", createdAt: "2026-07-30T14:00:00.000Z" }),
    ];
    const secondPage = [makeRun({ id: "run-c", createdAt: "2026-07-30T13:00:00.000Z" })];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes(`/heartbeat-runs?limit=2&cursor=`)) {
        return Promise.resolve(new Response(JSON.stringify(secondPage), { status: 200 }));
      }
      if (url.includes(`/heartbeat-runs?limit=2`)) {
        return Promise.resolve(new Response(JSON.stringify(firstPage), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProgram().parseAsync([
      "measurement", "intake", "--company-id", COMPANY_ID,
      "--out", path.join(tempDir, "paginated-intake.json"), "--run-limit", "2",
      "--api-base", "http://localhost:3100", "--api-key", "board-token",
    ], { from: "user" });

    const heartbeatUrls = fetchMock.mock.calls.map((call) => String(call[0]))
      .filter((url) => url.includes("/heartbeat-runs?"));
    expect(heartbeatUrls).toHaveLength(2);
    expect(heartbeatUrls[1]).toContain("cursor=");
    const intake = JSON.parse(fs.readFileSync(path.join(tempDir, "paginated-intake.json"), "utf8"));
    expect(intake.run_sample_size).toBe(3);
  });

  it("`measurement intake` pulls /api/issues/{id}/runs + cost-summary for each --issue", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes(`/issues/${ISSUE_A}/runs`)) {
        return Promise.resolve(new Response(JSON.stringify([makeRun({ status: "succeeded" })]), { status: 200 }));
      }
      if (url.includes(`/issues/${ISSUE_A}/cost-summary`)) {
        return Promise.resolve(new Response(JSON.stringify({ totalCents: 1 }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProgram().parseAsync([
      "measurement",
      "intake",
      "--company-id",
      COMPANY_ID,
      "--issue",
      ISSUE_A,
      "--out",
      path.join(tempDir, "intake.json"),
      "--api-base",
      "http://localhost:3100",
      "--api-key",
      "board-token",
    ], { from: "user" });

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain(`http://localhost:3100/api/issues/${ISSUE_A}/runs`);
    expect(urls).toContain(`http://localhost:3100/api/issues/${ISSUE_A}/cost-summary`);
  });
});

// Workaround for the test above that referenced COMPILED_DATA before the
// constant expansion — keep this constant defined so it stays a literal.
const COMPILED_DATA = COMPANY_ID;
