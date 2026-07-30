import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
  type ResolvedClientContext,
} from "./common.js";

// Phase-1 measurement consumer (GLO-2029).
//
// Phase-1 of the self-host mandate measurement spine requires an in-repo
// consumer that pulls the standing `heartbeat-runs`, `costs/*`,
// `/api/issues/{id}/runs`, and `/api/issues/{id}/cost-summary` reports and
// surfaces intake + display surfaces. The canonical host producer
// (`/opt/data/bin/measurement-spine-report.py`) writes JSON+markdown to
// /opt/paperclip/reports/measurement-spine/ — this consumer mirrors the same
// cohort/window/intake shape so the in-repo CLI is interchangeable with the
// producer/canary report.
//
// Consumer shape (intentionally stable across both surfaces):
//
//   {
//     generated_at: ISO8601 string,
//     company_id: string,
//     sources: { heartbeat_runs, costs_summary, costs_by_provider,
//                costs_subscription_economics, issues_runs, issue_cost_summary }
//     instruments_not_trusted: [...],
//     run_sample_size: number,
//     oldest_run_in_sample: ISO8601|null,
//     newest_run_in_sample: ISO8601|null,
//     cohorts: { "1d"|"3d"|"7d"|"14d": Phase1Cohort },
//     costs_summary: {...} (verbatim from API),
//     costs_by_provider: {...} (verbatim from API),
//     subscription_economics: {...} (verbatim from API),
//     issue_intakes: [Phase1IssueIntake],
//   }
//
// Phase1Cohort = {
//   window_days: number,
//   run_count_in_sample: number,
//   status_counts: Record<string, number>,
//   succeeded: number,
//   failed: number,
//   cancelled: number,
//   success_rate_ex_cancel: number|null,
//   tokens_in: number,
//   tokens_out: number,
//   providers: Record<string, number>,
//   routing_reasons: Record<string, number>,
//   sample_note: string,
// }
//
// Phase1IssueIntake = {
//   issue_ref: string,
//   run_count: number,
//   status_counts: Record<string, number>,
//   tokens_in: number,
//   tokens_out: number,
//   providers: Record<string, number>,
//   cost_summary: {...}|null (verbatim from /api/issues/{id}/cost-summary),
// }

export const MEASUREMENT_PHASE1_WINDOWS = ["1d", "3d", "7d", "14d"] as const;
export type MeasurementWindow = (typeof MEASUREMENT_PHASE1_WINDOWS)[number];
export const MEASUREMENT_PHASE1_WINDOW_DAYS: Record<MeasurementWindow, number> = {
  "1d": 1,
  "3d": 3,
  "7d": 7,
  "14d": 14,
};

export const MEASUREMENT_INTAKE_SCHEMA_VERSION = "paperclip.measurement-spine.phase1-intake.v1";

export const MEASUREMENT_INSTRUMENTS_NOT_TRUSTED = [
  "spentMonthlyCents (inert $0 class)",
  "agent self-report done-counts",
  "board status alone without PR/receipt truth",
] as const;

export interface Phase1Cohort {
  window_days: number;
  run_count_in_sample: number;
  status_counts: Record<string, number>;
  succeeded: number;
  failed: number;
  cancelled: number;
  success_rate_ex_cancel: number | null;
  tokens_in: number;
  tokens_out: number;
  providers: Record<string, number>;
  routing_reasons: Record<string, number>;
  sample_note: string;
}

export interface Phase1IssueIntake {
  issue_ref: string;
  run_count: number;
  status_counts: Record<string, number>;
  succeeded: number;
  failed: number;
  tokens_in: number;
  tokens_out: number;
  providers: Record<string, number>;
  cost_summary: unknown | null;
  cost_summary_error?: string;
}

export interface Phase1IntakeSourceTrace {
  url: string;
  ok: boolean;
  fetched_at: string;
  error?: string;
}

export interface Phase1Intake {
  schema_version: string;
  generated_at: string;
  company_id: string;
  sources: {
    heartbeat_runs: Phase1IntakeSourceTrace;
    costs_summary: Phase1IntakeSourceTrace;
    costs_by_provider: Phase1IntakeSourceTrace;
    costs_subscription_economics: Phase1IntakeSourceTrace;
    issue_runs: Phase1IntakeSourceTrace[];
    issue_cost_summary: Phase1IntakeSourceTrace[];
  };
  instruments_not_trusted: readonly string[];
  run_sample_size: number;
  oldest_run_in_sample: string | null;
  newest_run_in_sample: string | null;
  cohorts: Record<MeasurementWindow, Phase1Cohort>;
  costs_summary: unknown | null;
  costs_by_provider: unknown | null;
  subscription_economics: unknown | null;
  issue_intakes: Phase1IssueIntake[];
}

export interface RawHeartbeatRun {
  id?: string;
  status?: string;
  startedAt?: string | null;
  createdAt?: string | null;
  finishedAt?: string | null;
  agentId?: string;
  companyId?: string;
  issueId?: string | null;
  usageJson?: unknown;
}

export interface IssueRef {
  id: string;
}

export interface BuildPhase1IntakeInput {
  companyId: string;
  heartbeatRuns: RawHeartbeatRun[];
  costsSummary: unknown | null;
  costsByProvider: unknown | null;
  subscriptionEconomics: unknown | null;
  issues: IssueRef[];
  fetchIssueRuns: (issueId: string) => Promise<RawHeartbeatRun[]>;
  fetchIssueCostSummary: (
    issueId: string,
  ) => Promise<unknown>;
  generatedAt?: Date;
  sourceUrls?: Partial<Phase1Intake["sources"]>;
}

// ---------- Pure helpers (exported for unit tests + reuse) -------------------

export function parseIsoTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const iso = value.includes("Z") || value.includes("+") ? value : `${value}Z`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function normalizeHeartbeatUsage(usage: unknown): {
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  routingReason: string;
} {
  const empty = {
    provider: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    routingReason: "unset",
  };
  if (!usage || typeof usage !== "object") return empty;
  const raw = usage as Record<string, unknown>;
  const provider =
    (typeof raw.provider === "string" && raw.provider) ||
    (typeof raw.biller === "string" && raw.biller) ||
    "unknown";
  const num = (key: string) => {
    const value = Number(raw[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const er =
    raw.executionRoute && typeof raw.executionRoute === "object"
      ? (raw.executionRoute as Record<string, unknown>)
      : null;
  const routingReason = er
    ? String(
        er.routing_reason || er.routingReason || er.provider_id || er.providerId || "unset",
      )
    : typeof raw.routingReason === "string"
      ? raw.routingReason
      : "unset";
  return {
    provider,
    inputTokens: num("inputTokens") + num("rawInputTokens"),
    outputTokens: num("outputTokens"),
    cachedInputTokens: num("cachedInputTokens"),
    routingReason,
  };
}export function buildCohort(input: {
  runs: RawHeartbeatRun[];
  windowDays: number;
  now: Date;
}): Phase1Cohort {
  const cut = new Date(input.now.getTime() - input.windowDays * 24 * 60 * 60 * 1000);
  const filtered = input.runs.filter((r) => {
    const ts = parseIsoTimestamp(r.startedAt) ?? parseIsoTimestamp(r.createdAt);
    if (!ts) return false;
    return ts.getTime() >= cut.getTime();
  });
  const statusCounts: Record<string, number> = {};
  const providers: Record<string, number> = {};
  const routing: Record<string, number> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  for (const run of filtered) {
    const status = String(run.status ?? "unknown").toLowerCase();
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "succeeded" || status === "success" || status === "completed") {
      succeeded += 1;
    } else if (
      status === "failed" ||
      status === "error" ||
      status === "timed_out" ||
      status === "timeout"
    ) {
      failed += 1;
    } else if (status === "cancelled" || status === "canceled") {
      cancelled += 1;
    }
    const u = normalizeHeartbeatUsage(run.usageJson);
    providers[u.provider] = (providers[u.provider] ?? 0) + 1;
    tokensIn += u.inputTokens;
    tokensOut += u.outputTokens;
    routing[u.routingReason] = (routing[u.routingReason] ?? 0) + 1;
  }
  const denom = succeeded + failed;
  const successRate = denom > 0 ? succeeded / denom : null;
  // Order providers + routing for stable output
  const orderedProviders: Record<string, number> = {};
  for (const [k, v] of Object.entries(providers).sort((a, b) => b[1] - a[1])) {
    orderedProviders[k] = v;
  }
  const orderedRouting: Record<string, number> = {};
  for (const [k, v] of Object.entries(routing)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)) {
    orderedRouting[k] = v;
  }
  return {
    window_days: input.windowDays,
    run_count_in_sample: filtered.length,
    status_counts: statusCounts,
    succeeded,
    failed,
    cancelled,
    success_rate_ex_cancel: successRate,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    providers: orderedProviders,
    routing_reasons: orderedRouting,
    sample_note:
      "Heartbeat-run page sample; if n plateaus across windows, API returned a capped recent page only.",
  };
}

export function buildIssueIntake(input: {
  issueRef: string;
  runs: RawHeartbeatRun[];
  costSummary: unknown | null;
  costSummaryError?: string;
}): Phase1IssueIntake {
  const statusCounts: Record<string, number> = {};
  const providers: Record<string, number> = {};
  let tokensIn = 0;
  let tokensOut = 0;
  let succeeded = 0;
  let failed = 0;
  for (const run of input.runs) {
    const status = String(run.status ?? "unknown").toLowerCase();
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (status === "succeeded" || status === "success" || status === "completed") {
      succeeded += 1;
    } else if (
      status === "failed" ||
      status === "error" ||
      status === "timed_out" ||
      status === "timeout"
    ) {
      failed += 1;
    }
    const u = normalizeHeartbeatUsage(run.usageJson);
    providers[u.provider] = (providers[u.provider] ?? 0) + 1;
    tokensIn += u.inputTokens;
    tokensOut += u.outputTokens;
  }
  const orderedProviders: Record<string, number> = {};
  for (const [k, v] of Object.entries(providers).sort((a, b) => b[1] - a[1])) {
    orderedProviders[k] = v;
  }
  return {
    issue_ref: input.issueRef,
    run_count: input.runs.length,
    status_counts: statusCounts,
    succeeded,
    failed,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    providers: orderedProviders,
    cost_summary: input.costSummary,
    ...(input.costSummaryError
      ? { cost_summary_error: input.costSummaryError }
      : {}),
  };
}

function sourceTrace(
  url: string,
  ok: boolean,
  error?: string,
  fetchedAt?: string,
): Phase1IntakeSourceTrace {
  return {
    url,
    ok,
    fetched_at: fetchedAt ?? new Date().toISOString(),
    ...(error ? { error } : {}),
  };
}

function minMaxIso(runs: RawHeartbeatRun[]): { oldest: string | null; newest: string | null } {
  let oldest: Date | null = null;
  let newest: Date | null = null;
  for (const run of runs) {
    const ts = parseIsoTimestamp(run.startedAt) ?? parseIsoTimestamp(run.createdAt);
    if (!ts) continue;
    if (!oldest || ts.getTime() < oldest.getTime()) oldest = ts;
    if (!newest || ts.getTime() > newest.getTime()) newest = ts;
  }
  return {
    oldest: oldest ? oldest.toISOString() : null,
    newest: newest ? newest.toISOString() : null,
  };
}

export async function buildPhase1Intake(input: BuildPhase1IntakeInput): Promise<Phase1Intake> {
  const now = input.generatedAt ?? new Date();
  const generatedAt = now.toISOString();
  const cohorts: Record<MeasurementWindow, Phase1Cohort> = {} as Record<
    MeasurementWindow,
    Phase1Cohort
  >;
  for (const w of MEASUREMENT_PHASE1_WINDOWS) {
    cohorts[w] = buildCohort({
      runs: input.heartbeatRuns,
      windowDays: MEASUREMENT_PHASE1_WINDOW_DAYS[w],
      now,
    });
  }

  const issueIntakes: Phase1IssueIntake[] = [];
  const issueRunsSources: Phase1IntakeSourceTrace[] = [];
  const issueCostSources: Phase1IntakeSourceTrace[] = [];
  for (const issue of input.issues) {
    const runsUrl = apiPath`/api/issues/${issue.id}/runs`;
    const costUrl = apiPath`/api/issues/${issue.id}/cost-summary`;
    let runs: RawHeartbeatRun[] = [];
    let costSummary: unknown = null;
    let runsErr: string | undefined;
    let costErr: string | undefined;
    try {
      runs = await input.fetchIssueRuns(issue.id);
    } catch (err) {
      runsErr = err instanceof Error ? err.message : String(err);
    }
    try {
      costSummary = await input.fetchIssueCostSummary(issue.id);
    } catch (err) {
      costErr = err instanceof Error ? err.message : String(err);
    }
    issueRunsSources.push(sourceTrace(runsUrl, !runsErr, runsErr));
    issueCostSources.push(sourceTrace(costUrl, !costErr, costErr));
    issueIntakes.push(
      buildIssueIntake({
        issueRef: issue.id,
        runs,
        costSummary,
        costSummaryError: costErr,
      }),
    );
  }

  const { oldest, newest } = minMaxIso(input.heartbeatRuns);
  const urls = input.sourceUrls ?? {};
  return {
    schema_version: MEASUREMENT_INTAKE_SCHEMA_VERSION,
    generated_at: generatedAt,
    company_id: input.companyId,
    sources: {
      heartbeat_runs:
        urls.heartbeat_runs ??
        sourceTrace(
          apiPath`/api/companies/${input.companyId}/heartbeat-runs?limit=500`,
          true,
        ),
      costs_summary:
        urls.costs_summary ??
        sourceTrace(apiPath`/api/companies/${input.companyId}/costs/summary`, true),
      costs_by_provider:
        urls.costs_by_provider ??
        sourceTrace(
          apiPath`/api/companies/${input.companyId}/costs/by-provider`,
          true,
        ),
      costs_subscription_economics:
        urls.costs_subscription_economics ??
        sourceTrace(
          apiPath`/api/companies/${input.companyId}/costs/subscription-economics`,
          true,
        ),
      issue_runs: issueRunsSources,
      issue_cost_summary: issueCostSources,
    },
    instruments_not_trusted: MEASUREMENT_INSTRUMENTS_NOT_TRUSTED,
    run_sample_size: input.heartbeatRuns.length,
    oldest_run_in_sample: oldest,
    newest_run_in_sample: newest,
    cohorts,
    costs_summary: input.costsSummary,
    costs_by_provider: input.costsByProvider,
    subscription_economics: input.subscriptionEconomics,
    issue_intakes: issueIntakes,
  };
}

// ---------- Display -------------------------------------------------------

export function formatPercent(fraction: number | null): string {
  if (fraction === null || fraction === undefined) return "n/a";
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatTopProviders(
  providers: Record<string, number>,
  max = 4,
): string {
  const entries = Object.entries(providers)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  if (entries.length === 0) return "(none)";
  return entries.map(([k, v]) => `${k}:${v}`).join(", ");
}

export function renderPhase1Display(intake: Phase1Intake): string {
  const lines: string[] = [];
  lines.push(pc.bold(`Phase-1 measurement intake — ${intake.company_id}`));
  lines.push(`Generated: ${pc.dim(intake.generated_at)}`);
  lines.push(`Sample: ${intake.run_sample_size} heartbeat-runs`);
  if (intake.oldest_run_in_sample || intake.newest_run_in_sample) {
    lines.push(
      `Oldest: ${intake.oldest_run_in_sample ?? "(n/a)"}  Newest: ${
        intake.newest_run_in_sample ?? "(n/a)"
      }`,
    );
  }
  lines.push("");
  lines.push(pc.bold("Cohorts (runs only — cancels excluded from success-rate)"));
  lines.push("");
  lines.push(
    [
      "window".padEnd(6),
      "n".padStart(5),
      "ok".padStart(5),
      "fail".padStart(5),
      "cancel".padStart(7),
      "success%".padStart(10),
      "tokens_in".padStart(12),
      "top_providers".padStart(36),
    ].join(" "),
  );
  for (const w of MEASUREMENT_PHASE1_WINDOWS) {
    const c = intake.cohorts[w];
    lines.push(
      [
        w.padEnd(6),
        String(c.run_count_in_sample).padStart(5),
        String(c.succeeded).padStart(5),
        String(c.failed).padStart(5),
        String(c.cancelled).padStart(7),
        formatPercent(c.success_rate_ex_cancel).padStart(10),
        String(c.tokens_in).padStart(12),
        formatTopProviders(c.providers).padStart(36),
      ].join(" "),
    );
  }
  if (intake.issue_intakes.length > 0) {
    lines.push("");
    lines.push(pc.bold(`Issue intakes (${intake.issue_intakes.length})`));
    for (const ii of intake.issue_intakes) {
      lines.push(
        `  ${ii.issue_ref}  runs=${ii.run_count}  ok=${ii.succeeded}  fail=${ii.failed}  tokens_in=${ii.tokens_in}  top=${formatTopProviders(ii.providers, 3)}`,
      );
      if (ii.cost_summary_error) {
        lines.push(`    cost-summary error: ${pc.red(ii.cost_summary_error)}`);
      }
    }
  }
  lines.push("");
  lines.push(pc.dim("Do not cite spentMonthlyCents / agent self-report done-counts."));
  lines.push(pc.dim("Trust: subscription-economics usageTruth + provider token counts above."));
  return lines.join("\n");
}

// ---------- IO ------------------------------------------------------------

export async function writePhase1Intake(intake: Phase1Intake, outputPath: string): Promise<string> {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, JSON.stringify(intake, null, 2), "utf8");
  return resolved;
}

export async function readPhase1Intake(inputPath: string): Promise<Phase1Intake> {
  const raw = await readFile(inputPath, "utf8");
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schema_version?: string }).schema_version !== MEASUREMENT_INTAKE_SCHEMA_VERSION
  ) {
    throw new Error(
      `Phase-1 intake at ${inputPath} is not schema ${MEASUREMENT_INTAKE_SCHEMA_VERSION}`,
    );
  }
  return parsed as Phase1Intake;
}

// ---------- Adapter helpers ------------------------------------------------

async function fetchTyped<T>(ctx: ResolvedClientContext, path: string): Promise<T> {
  const result = await ctx.api.get<T>(path);
  return result;
}

export async function collectCompanyPhase1Intake(
  ctx: ResolvedClientContext,
  options: {
    companyId: string;
    issueRefs?: IssueRef[];
    heartbeatRunLimit?: number;
  },
): Promise<Phase1Intake> {
  const limit = options.heartbeatRunLimit ?? 500;
  const issueRefs = options.issueRefs ?? [];
  const heartbeatRuns = await fetchTyped<RawHeartbeatRun[]>(
    ctx,
    apiPath`/api/companies/${options.companyId}/heartbeat-runs?limit=${limit}`,
  );
  let costsSummary: unknown = null;
  let costsByProvider: unknown = null;
  let subscriptionEconomics: unknown = null;
  try {
    costsSummary = await fetchTyped<unknown>(
      ctx,
      apiPath`/api/companies/${options.companyId}/costs/summary`,
    );
  } catch {
    costsSummary = null;
  }
  try {
    costsByProvider = await fetchTyped<unknown>(
      ctx,
      apiPath`/api/companies/${options.companyId}/costs/by-provider`,
    );
  } catch {
    costsByProvider = null;
  }
  try {
    subscriptionEconomics = await fetchTyped<unknown>(
      ctx,
      apiPath`/api/companies/${options.companyId}/costs/subscription-economics`,
    );
  } catch {
    subscriptionEconomics = null;
  }
  return buildPhase1Intake({
    companyId: options.companyId,
    heartbeatRuns,
    costsSummary,
    costsByProvider,
    subscriptionEconomics,
    issues: issueRefs,
    fetchIssueRuns: async (issueId: string) => {
      try {
        return await fetchTyped<RawHeartbeatRun[]>(
          ctx,
          apiPath`/api/issues/${issueId}/runs`,
        );
      } catch {
        return [];
      }
    },
    fetchIssueCostSummary: async (issueId: string) => {
      try {
        return await fetchTyped<unknown>(
          ctx,
          apiPath`/api/issues/${issueId}/cost-summary`,
        );
      } catch {
        return null;
      }
    },
  });
}

// ---------- CLI registration ----------------------------------------------

interface IntakeOptions extends BaseClientOptions {
  out?: string;
  issue?: string[];
  runLimit?: string;
}

interface DisplayOptions extends BaseClientOptions {
  intake: string;
}

interface CohortShowOptions extends BaseClientOptions {
  intake: string;
  window?: string;
}

function parseIssueRefs(values: string[] | undefined): IssueRef[] {
  if (!values) return [];
  return values
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .map((id) => ({ id }));
}

export function registerMeasurementCommands(program: Command): void {
  const measurement = program
    .command("measurement")
    .description("Phase-1 measurement spine: consume heartbeat + cost APIs and render intake/display");

  addCommonClientOptions(
    measurement
      .command("intake")
      .description("Pull heartbeat-runs + cost summaries and write a Phase-1 intake JSON file")
      .option("-C, --company-id <id>", "Company ID (overrides context default)")
      .option(
        "--out <path>",
        "Output path for the intake JSON (default: ./measurement-intake-<UTC-DAY>.json)",
      )
      .option(
        "--issue <id>",
        "Optional issue id (UUID or PAP-style identifier). Repeatable for multiple issues.",
        (value: string, prev: string[]) => {
          const list = Array.isArray(prev) ? prev : [];
          list.push(value);
          return list;
        },
      )
      .option("--run-limit <n>", "Heartbeat run sample cap (default 500)")
      .action(async (opts: IntakeOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const companyId = ctx.companyId!;
          const issueRefs = parseIssueRefs(opts.issue);
          const limit = opts.runLimit ? Number.parseInt(opts.runLimit, 10) : 500;
          const intake = await collectCompanyPhase1Intake(ctx, {
            companyId,
            issueRefs,
            heartbeatRunLimit: limit,
          });
          const stamp = intake.generated_at.slice(0, 10);
          const outPath = path.resolve(opts.out ?? `measurement-intake-${stamp}.json`);
          const written = await writePhase1Intake(intake, outPath);
          printOutput(
            { ok: true, written, schema_version: intake.schema_version, company_id: companyId },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    measurement
      .command("display")
      .description("Render a Phase-1 intake JSON file as a human-readable terminal report")
      .requiredOption("--intake <path>", "Path to a Phase-1 intake JSON file")
      .action(async (opts: DisplayOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const intake = await readPhase1Intake(opts.intake);
          if (ctx.json) {
            printOutput(intake, { json: true });
            return;
          }
          console.log(renderPhase1Display(intake));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  addCommonClientOptions(
    measurement
      .command("cohort-show")
      .description("Show one cohort window from a Phase-1 intake JSON as JSON")
      .requiredOption("--intake <path>", "Path to a Phase-1 intake JSON file")
      .option(
        "--window <window>",
        `Cohort window (one of: ${MEASUREMENT_PHASE1_WINDOWS.join(", ")})`,
        (value: string) => value,
      )
      .action(async (opts: CohortShowOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const intake = await readPhase1Intake(opts.intake);
          if (opts.window && !MEASUREMENT_PHASE1_WINDOWS.includes(opts.window as MeasurementWindow)) {
            throw new Error(
              `Unknown --window ${opts.window}; expected one of ${MEASUREMENT_PHASE1_WINDOWS.join(", ")}`,
            );
          }
          const window = (opts.window ?? "7d") as MeasurementWindow;
          printOutput(
            {
              company_id: intake.company_id,
              generated_at: intake.generated_at,
              window,
              cohort: intake.cohorts[window],
              instruments_not_trusted: intake.instruments_not_trusted,
            },
            { json: ctx.json },
          );
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
