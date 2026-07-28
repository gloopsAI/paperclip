/**
 * Outcome Scorecard (OK-01)
 *
 * Distinguishes runtime success (heartbeat run terminal status) from accepted
 * organizational outcomes (issues actually done with non-infra evidence).
 *
 * Pure scoring helpers are exported for unit tests; the DB service loads rows
 * and delegates to `buildOutcomeScorecard`.
 */
import { and, desc, eq, gte, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";

export const OUTCOME_SCORECARD_DEFAULT_WINDOW_DAYS = 14;
export const OUTCOME_SCORECARD_MAX_RUNS = 5000;

export type FailureClass = "infrastructure" | "reasoning";

export interface OutcomeScorecardWindow {
  since: string | null;
  until: string | null;
}

export interface OutcomeScorecard {
  window: OutcomeScorecardWindow;
  companyId: string;
  runs: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    other: number;
  };
  outcomes: {
    admitted: number;
    acceptedOutcomes: number;
    /** Done probe-lane issues (skill_test / ask) — not product accepted outcomes. */
    probeOutcomes: number;
    runtimeSuccessNotDone: number;
    doneWithoutSuccessRun: number;
  };
  failures: {
    infrastructure: number;
    reasoning: number;
    infraFailureShare: number | null;
  };
  economics: {
    totalInputTokens: number;
    totalCachedInputTokens: number;
    totalUncachedInputTokens: number;
    totalOutputTokens: number;
    uncachedInputTokensPerAcceptedOutcome: number | null;
  };
  rates: {
    runtimeSuccessRate: number | null;
    admittedToAcceptedRate: number | null;
    terminalMismatchRate: number | null;
  };
}

export interface ScorecardIssue {
  id: string;
  status: string;
  createdAt: Date | string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  /** Issue work mode — probe modes (skill_test, ask) are excluded from acceptedOutcomes. */
  workMode?: string | null;
}

export interface ScorecardRun {
  id: string;
  status: string;
  createdAt: Date | string;
  error?: string | null;
  errorCode?: string | null;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
  /** Resolved issue id when known (from contextSnapshot or join). */
  issueId?: string | null;
}

export interface BuildOutcomeScorecardInput {
  companyId: string;
  since: Date;
  until: Date;
  runs: ScorecardRun[];
  issues: ScorecardIssue[];
}

const INFRA_KEYWORDS = [
  "workspace",
  "gateway",
  "hermes connection",
  "authorization",
  "authz",
  "admission",
  "publication",
  "preparation",
  "setgid",
  "safe.directory",
  "eacces",
  "connect",
  "enotfound",
  "execution_admission",
  "provider transport",
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function firstNonNegativeInt(...values: Array<unknown>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.floor(value));
    }
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
    }
  }
  return 0;
}

function flattenFailureText(
  errorCode: string | null | undefined,
  message: string | null | undefined,
  resultJson: unknown,
): string {
  const parts: string[] = [];
  if (errorCode) parts.push(String(errorCode));
  if (message) parts.push(String(message));
  const result = asRecord(resultJson);
  if (result) {
    for (const key of [
      "errorCode",
      "error_code",
      "code",
      "error",
      "message",
      "reason",
      "stopReason",
      "failureClass",
      "class",
    ] as const) {
      const value = readNonEmptyString(result[key]);
      if (value) parts.push(value);
    }
    // Nested error objects are common in adapter result payloads.
    const nestedError = asRecord(result.error);
    if (nestedError) {
      for (const key of ["code", "message", "name", "errorCode"] as const) {
        const value = readNonEmptyString(nestedError[key]);
        if (value) parts.push(value);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Classify a failure as infrastructure vs reasoning.
 * Infrastructure covers workspace/gateway/auth/admission/publication classes.
 */
export function classifyFailureClass(
  errorCodeOrMessageOrResult:
    | string
    | null
    | undefined
    | Record<string, unknown>
    | {
        errorCode?: string | null;
        error?: string | null;
        message?: string | null;
        resultJson?: unknown;
      },
  message?: string | null,
  resultJson?: unknown,
): FailureClass {
  let errorCode: string | null | undefined;
  let errMessage: string | null | undefined = message;
  let result: unknown = resultJson;

  if (typeof errorCodeOrMessageOrResult === "string" || errorCodeOrMessageOrResult == null) {
    errorCode = errorCodeOrMessageOrResult;
  } else if (
    "errorCode" in errorCodeOrMessageOrResult ||
    "error" in errorCodeOrMessageOrResult ||
    "resultJson" in errorCodeOrMessageOrResult ||
    "message" in errorCodeOrMessageOrResult
  ) {
    const bag = errorCodeOrMessageOrResult as {
      errorCode?: string | null;
      error?: string | null;
      message?: string | null;
      resultJson?: unknown;
    };
    // Prefer structured fields; fall through to treating the whole object as resultJson.
    if (
      bag.errorCode != null ||
      bag.error != null ||
      bag.message != null ||
      bag.resultJson != null
    ) {
      errorCode = bag.errorCode;
      errMessage = bag.error ?? bag.message ?? message;
      result = bag.resultJson ?? resultJson ?? bag;
    } else {
      result = errorCodeOrMessageOrResult;
    }
  } else {
    result = errorCodeOrMessageOrResult;
  }

  const text = flattenFailureText(errorCode, errMessage, result);
  if (!text) return "reasoning";

  for (const keyword of INFRA_KEYWORDS) {
    if (text.includes(keyword)) return "infrastructure";
  }
  return "reasoning";
}

export interface UsageTokens {
  input: number;
  cached: number;
  output: number;
  uncached: number;
}

/**
 * Extract token usage from a run's usageJson, tolerating common key aliases.
 */
export function extractUsageTokens(usageJson: unknown): UsageTokens {
  const usage = asRecord(usageJson) ?? {};
  const nested = asRecord(usage.usage) ?? {};

  const input = firstNonNegativeInt(
    usage.inputTokens,
    usage.input_tokens,
    usage.rawInputTokens,
    nested.inputTokens,
    nested.input_tokens,
  );
  const cached = firstNonNegativeInt(
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    usage.rawCachedInputTokens,
    nested.cachedInputTokens,
    nested.cached_input_tokens,
    nested.cache_read_input_tokens,
  );
  const output = firstNonNegativeInt(
    usage.outputTokens,
    usage.output_tokens,
    usage.rawOutputTokens,
    nested.outputTokens,
    nested.output_tokens,
  );
  const uncached = Math.max(0, input - cached);
  return { input, cached, output, uncached };
}

function hasExplicitReviewAcceptMarker(resultJson: unknown): boolean {
  const result = asRecord(resultJson);
  if (!result) return false;

  if (result.reviewAccepted === true || result.review_accepted === true) return true;
  if (result.accepted === true && (result.review === true || result.reviewStatus != null || result.review_status != null)) {
    return true;
  }

  const reviewStatus = readNonEmptyString(result.reviewStatus ?? result.review_status)?.toLowerCase();
  if (reviewStatus === "accepted" || reviewStatus === "approved") return true;

  const outcome = readNonEmptyString(result.outcome ?? result.outcomeGrade ?? result.terminalGrade)?.toLowerCase();
  if (outcome === "accepted" || outcome === "approved" || outcome === "done_accepted") return true;

  const nestedReview = asRecord(result.review);
  if (nestedReview) {
    if (nestedReview.accepted === true || nestedReview.approved === true) return true;
    const status = readNonEmptyString(nestedReview.status)?.toLowerCase();
    if (status === "accepted" || status === "approved") return true;
  }

  return false;
}

function readResultSummaryText(resultJson: unknown): string | null {
  const result = asRecord(resultJson);
  if (!result) return null;

  for (const key of ["summary", "result", "message", "output", "content"] as const) {
    const value = result[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function isInfraOnlySuccessResult(resultJson: unknown): boolean {
  const result = asRecord(resultJson);
  if (!result) return false;
  if (result.infraOnly === true || result.infrastructureOnly === true) return true;
  const kind = readNonEmptyString(result.kind ?? result.resultKind ?? result.class)?.toLowerCase();
  if (kind === "infrastructure" || kind === "infra" || kind === "infra_only") return true;
  // If the only content classifies as infrastructure failure language, treat as infra-only.
  const text = readResultSummaryText(resultJson);
  if (text && classifyFailureClass(null, text, resultJson) === "infrastructure") {
    // Only treat as infra-only when there is no explicit organizational outcome marker.
    if (!hasExplicitReviewAcceptMarker(resultJson)) return true;
  }
  return false;
}

function hasNonEmptyNonInfraSuccessEvidence(run: ScorecardRun): boolean {
  if (run.status !== "succeeded") return false;
  if (hasExplicitReviewAcceptMarker(run.resultJson)) return true;
  const text = readResultSummaryText(run.resultJson);
  if (!text) return false;
  if (isInfraOnlySuccessResult(run.resultJson)) return false;
  return true;
}

/** Probe work modes never count as accepted product outcomes (MAW loop lanes). */
export function isProbeScorecardIssue(issue: Pick<ScorecardIssue, "workMode">): boolean {
  const mode = typeof issue.workMode === "string" ? issue.workMode.trim().toLowerCase() : "";
  return mode === "skill_test" || mode === "ask";
}

/**
 * An issue is an accepted organizational outcome when it is done and either:
 * - has an explicit review-accept marker on a linked run result, or
 * - has at least one succeeded run with non-empty non-infra result/summary.
 *
 * Probe lanes (skill_test / ask) are excluded — they surface as probeOutcomes.
 */
export function isAcceptedOrganizationalOutcome(
  issue: Pick<ScorecardIssue, "status" | "workMode">,
  runs: ScorecardRun[],
): boolean {
  if (issue.status !== "done") return false;
  if (isProbeScorecardIssue(issue)) return false;
  if (runs.some((run) => hasExplicitReviewAcceptMarker(run.resultJson))) return true;
  return runs.some((run) => hasNonEmptyNonInfraSuccessEvidence(run));
}

export function isProbeOrganizationalOutcome(
  issue: Pick<ScorecardIssue, "status" | "workMode">,
): boolean {
  return issue.status === "done" && isProbeScorecardIssue(issue);
}

/**
 * Runtime success that did not land as a terminal organizational state.
 */
export function isTerminalMismatch(
  run: Pick<ScorecardRun, "status">,
  issue: Pick<ScorecardIssue, "status"> | null | undefined,
): boolean {
  if (run.status !== "succeeded") return false;
  if (!issue) return false;
  return issue.status !== "done" && issue.status !== "cancelled";
}

export function resolveIssueIdFromRun(run: ScorecardRun): string | null {
  if (run.issueId) return run.issueId;
  const context = asRecord(run.contextSnapshot);
  if (!context) return null;
  return (
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(context.taskId) ??
    null
  );
}

function isAssigned(issue: ScorecardIssue): boolean {
  return Boolean(readNonEmptyString(issue.assigneeAgentId) || readNonEmptyString(issue.assigneeUserId));
}

function toTime(value: Date | string): number {
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

function inWindow(value: Date | string, sinceMs: number, untilMs: number): boolean {
  const t = toTime(value);
  return t >= sinceMs && t <= untilMs;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Pure scorecard builder — free of DB so unit tests can drive it with fixtures.
 */
export function buildOutcomeScorecard(input: BuildOutcomeScorecardInput): OutcomeScorecard {
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  const issueById = new Map(input.issues.map((issue) => [issue.id, issue]));

  const runsInWindow = input.runs.filter((run) => inWindow(run.createdAt, sinceMs, untilMs));

  let succeeded = 0;
  let failed = 0;
  let cancelled = 0;
  let other = 0;
  let infrastructureFailures = 0;
  let reasoningFailures = 0;
  let totalInputTokens = 0;
  let totalCachedInputTokens = 0;
  let totalUncachedInputTokens = 0;
  let totalOutputTokens = 0;
  let runtimeSuccessNotDone = 0;

  const runsByIssueId = new Map<string, ScorecardRun[]>();
  const issuesWithRunInWindow = new Set<string>();

  for (const run of runsInWindow) {
    switch (run.status) {
      case "succeeded":
        succeeded += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
      default:
        other += 1;
        break;
    }

    if (run.status === "failed") {
      const failureClass = classifyFailureClass({
        errorCode: run.errorCode,
        error: run.error,
        resultJson: run.resultJson,
      });
      if (failureClass === "infrastructure") infrastructureFailures += 1;
      else reasoningFailures += 1;
    }

    const tokens = extractUsageTokens(run.usageJson);
    totalInputTokens += tokens.input;
    totalCachedInputTokens += tokens.cached;
    totalUncachedInputTokens += tokens.uncached;
    totalOutputTokens += tokens.output;

    const issueId = resolveIssueIdFromRun(run);
    if (issueId) {
      issuesWithRunInWindow.add(issueId);
      const list = runsByIssueId.get(issueId) ?? [];
      list.push(run);
      runsByIssueId.set(issueId, list);

      const issue = issueById.get(issueId);
      if (isTerminalMismatch(run, issue ?? null)) {
        runtimeSuccessNotDone += 1;
      }
    }
  }

  // Admitted: issues with ≥1 run in window OR created+assigned in window.
  const admittedIssueIds = new Set<string>(issuesWithRunInWindow);
  for (const issue of input.issues) {
    if (inWindow(issue.createdAt, sinceMs, untilMs) && isAssigned(issue)) {
      admittedIssueIds.add(issue.id);
    }
  }

  let acceptedOutcomes = 0;
  let probeOutcomes = 0;
  let doneWithoutSuccessRun = 0;

  for (const issueId of admittedIssueIds) {
    const issue = issueById.get(issueId);
    if (!issue) continue;
    const linkedRuns = runsByIssueId.get(issueId) ?? [];

    if (isAcceptedOrganizationalOutcome(issue, linkedRuns)) {
      acceptedOutcomes += 1;
    }
    if (isProbeOrganizationalOutcome(issue)) {
      probeOutcomes += 1;
    }

    if (issue.status === "done") {
      const hasSuccessRun = linkedRuns.some((run) => run.status === "succeeded");
      if (!hasSuccessRun) doneWithoutSuccessRun += 1;
    }
  }

  // Also count done-without-success for done issues that were not admitted via
  // run/assignment but appear in the issue set (e.g. completed earlier, no run
  // in window). Spec scopes to admitted outcomes primarily; keep the metric as
  // "done issues in the considered set without a success run in window".
  // The loop above already covers admitted issues.

  const totalRuns = runsInWindow.length;
  const totalFailures = infrastructureFailures + reasoningFailures;
  const admitted = admittedIssueIds.size;

  return {
    window: {
      since: input.since.toISOString(),
      until: input.until.toISOString(),
    },
    companyId: input.companyId,
    runs: {
      total: totalRuns,
      succeeded,
      failed,
      cancelled,
      other,
    },
    outcomes: {
      admitted,
      acceptedOutcomes,
      probeOutcomes,
      runtimeSuccessNotDone,
      doneWithoutSuccessRun,
    },
    failures: {
      infrastructure: infrastructureFailures,
      reasoning: reasoningFailures,
      infraFailureShare: safeRatio(infrastructureFailures, totalFailures),
    },
    economics: {
      totalInputTokens,
      totalCachedInputTokens,
      totalUncachedInputTokens,
      totalOutputTokens,
      uncachedInputTokensPerAcceptedOutcome: safeRatio(
        totalUncachedInputTokens,
        acceptedOutcomes,
      ),
    },
    rates: {
      runtimeSuccessRate: safeRatio(succeeded, totalRuns),
      admittedToAcceptedRate: safeRatio(acceptedOutcomes, admitted),
      // Spec: runtimeSuccessNotDone / max(1, succeeded runs)
      terminalMismatchRate: succeeded > 0
        ? runtimeSuccessNotDone / succeeded
        : runtimeSuccessNotDone > 0
          ? runtimeSuccessNotDone / 1
          : null,
    },
  };
}

export interface OutcomeScorecardQuery {
  since?: Date | string | null;
  until?: Date | string | null;
  now?: Date;
}

function parseDateInput(value: Date | string | null | undefined, label: string): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`invalid '${label}' date`);
    }
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid '${label}' date`);
  }
  return parsed;
}

export function resolveScorecardWindow(
  query: OutcomeScorecardQuery = {},
): { since: Date; until: Date } {
  const now = query.now ?? new Date();
  const until = parseDateInput(query.until, "until") ?? now;
  const since =
    parseDateInput(query.since, "since") ??
    new Date(until.getTime() - OUTCOME_SCORECARD_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { since, until };
}

export function outcomeScorecardService(db: Db) {
  return {
    /**
     * Load runs/issues for the company window and compute the outcome scorecard.
     */
    forCompany: async (
      companyId: string,
      query: OutcomeScorecardQuery = {},
    ): Promise<OutcomeScorecard> => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const { since, until } = resolveScorecardWindow(query);

      const runRows = await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            gte(heartbeatRuns.createdAt, since),
            lte(heartbeatRuns.createdAt, until),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(OUTCOME_SCORECARD_MAX_RUNS);

      const issueIdsFromRuns = new Set<string>();
      for (const row of runRows) {
        if (row.issueId) issueIdsFromRuns.add(row.issueId);
      }

      // Issues created+assigned in the window (admitted without a run yet).
      const createdAssignedRows = await db
        .select({
          id: issues.id,
          status: issues.status,
          createdAt: issues.createdAt,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          workMode: issues.workMode,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            gte(issues.createdAt, since),
            lte(issues.createdAt, until),
            or(isNotNull(issues.assigneeAgentId), isNotNull(issues.assigneeUserId)),
          ),
        )
        .limit(OUTCOME_SCORECARD_MAX_RUNS);

      for (const row of createdAssignedRows) {
        issueIdsFromRuns.add(row.id);
      }

      const allIssueIds = [...issueIdsFromRuns];
      const issueRows =
        allIssueIds.length === 0
          ? []
          : await db
              .select({
                id: issues.id,
                status: issues.status,
                createdAt: issues.createdAt,
                assigneeAgentId: issues.assigneeAgentId,
                assigneeUserId: issues.assigneeUserId,
                workMode: issues.workMode,
              })
              .from(issues)
              .where(and(eq(issues.companyId, companyId), inArray(issues.id, allIssueIds)));

      // Merge so created+assigned issues missing from the second query still appear
      // (they won't — second query covers all ids — but keep createdAssigned as base).
      const issueMap = new Map<string, ScorecardIssue>();
      for (const row of issueRows) {
        issueMap.set(row.id, row);
      }
      for (const row of createdAssignedRows) {
        if (!issueMap.has(row.id)) issueMap.set(row.id, row);
      }

      return buildOutcomeScorecard({
        companyId,
        since,
        until,
        runs: runRows.map((row) => ({
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          error: row.error,
          errorCode: row.errorCode,
          usageJson: row.usageJson,
          resultJson: row.resultJson,
          contextSnapshot: row.contextSnapshot,
          issueId: row.issueId,
        })),
        issues: [...issueMap.values()],
      });
    },
  };
}
