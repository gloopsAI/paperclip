/**
 * Review Path SLO (OK-05)
 *
 * Makes the Argus (independent reviewer) path measurable and availability-aware
 * without widening the trust substrate. Pure metric math is exported for unit
 * tests; the DB service loads reviewer agents + recent runs and delegates to
 * `buildReviewPathSlo`.
 *
 * Non-goals: App B publisher changes, live publisher wiring, substrate changes.
 */
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, heartbeatRuns, issues } from "@paperclipai/db";
import { notFound } from "../errors.js";

export const REVIEW_PATH_SLO_DEFAULT_WINDOW_DAYS = 14;
export const REVIEW_PATH_SLO_MAX_RUNS = 5000;
export const REVIEW_PATH_SLO_MAX_AGENTS = 200;

/** Canonical Argus name match (case-insensitive). */
export const ARGUS_REVIEWER_NAME = "argus";

export interface ReviewPathSloWindow {
  since: string | null;
  until: string | null;
}

export interface ReviewPathSloReport {
  window: ReviewPathSloWindow;
  companyId: string;
  reviewerAgents: Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  metrics: {
    reviewRuns: number;
    acceptedVerdicts: number;
    rejectedVerdicts: number;
    escalations: number;
    /** Median latency in ms (createdAt → updatedAt), null if no samples. */
    medianLatencyMs: number | null;
    /** p95 latency in ms (createdAt → updatedAt), null if no samples. */
    p95LatencyMs: number | null;
    /** Failed review runs / total review runs, null if no runs. */
    errorRate: number | null;
    /**
     * True when ≥1 reviewer agent is present and every reviewer agent is in a
     * healthy operational state (idle or running, not error/paused/etc).
     */
    idleHealthy: boolean;
    /**
     * Review runs where the implementer agent id equals the reviewer agent id
     * on the same issue (self-review / independence violation), when detectable.
     */
    independenceViolations: number;
  };
}

export interface ReviewPathSloAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

export interface ReviewPathSloIssue {
  id: string;
  status?: string | null;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  executionState?: Record<string, unknown> | null;
  executionPolicy?: Record<string, unknown> | null;
}

export interface ReviewPathSloRun {
  id: string;
  agentId: string;
  status: string;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  startedAt?: Date | string | null;
  error?: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  contextSnapshot?: Record<string, unknown> | null;
  /** Resolved issue id when known (from contextSnapshot or join). */
  issueId?: string | null;
}

export interface BuildReviewPathSloInput {
  companyId: string;
  since: Date;
  until: Date;
  reviewerAgents: ReviewPathSloAgent[];
  runs: ReviewPathSloRun[];
  issues?: ReviewPathSloIssue[];
  /**
   * Optional peer runs on the same issues by non-reviewer agents — used only
   * for implementer detection when independence can be checked.
   */
  peerRuns?: ReviewPathSloRun[];
}

export type ReviewVerdict = "accepted" | "rejected" | "escalated" | "unknown";

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

function toTime(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

function inWindow(value: Date | string, sinceMs: number, untilMs: number): boolean {
  const t = toTime(value);
  if (t == null) return false;
  return t >= sinceMs && t <= untilMs;
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Identify reviewer agents: name matches Argus (case-insensitive) OR role is
 * exactly "reviewer" (case-insensitive).
 */
export function isReviewerAgent(agent: Pick<ReviewPathSloAgent, "name" | "role">): boolean {
  const name = agent.name.trim().toLowerCase();
  const role = agent.role.trim().toLowerCase();
  if (name === ARGUS_REVIEWER_NAME) return true;
  if (role === "reviewer") return true;
  return false;
}

/**
 * Healthy idle path: agent is operationally available (idle or running) and
 * not in an error/paused terminal state.
 */
export function isIdleHealthyStatus(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "idle" || normalized === "running";
}

export function resolveIssueIdFromRun(run: Pick<ReviewPathSloRun, "issueId" | "contextSnapshot">): string | null {
  if (run.issueId) return run.issueId;
  const context = asRecord(run.contextSnapshot);
  if (!context) return null;
  return (
    readNonEmptyString(context.issueId) ??
    readNonEmptyString(context.taskId) ??
    null
  );
}

function readAgentIdFromPrincipal(value: unknown): string | null {
  if (typeof value === "string") return readNonEmptyString(value);
  const record = asRecord(value);
  if (!record) return null;
  const type = readNonEmptyString(record.type)?.toLowerCase();
  if (type && type !== "agent") return null;
  return (
    readNonEmptyString(record.agentId) ??
    readNonEmptyString(record.agent_id) ??
    readNonEmptyString(record.id)
  );
}

/**
 * Best-effort implementer agent id for independence checks.
 * Returns null when not detectable (does not invent a default).
 */
export function resolveImplementerAgentId(input: {
  run: ReviewPathSloRun;
  issue?: ReviewPathSloIssue | null;
  peerRunsOnIssue?: ReviewPathSloRun[];
  reviewerAgentIds: ReadonlySet<string>;
}): string | null {
  const context = asRecord(input.run.contextSnapshot) ?? {};
  const fromContext =
    readNonEmptyString(context.implementerAgentId) ??
    readNonEmptyString(context.implementer_agent_id) ??
    readNonEmptyString(context.executorAgentId) ??
    readNonEmptyString(context.executor_agent_id) ??
    readNonEmptyString(context.returnAssigneeAgentId) ??
    readNonEmptyString(context.return_assignee_agent_id) ??
    readAgentIdFromPrincipal(context.returnAssignee) ??
    readAgentIdFromPrincipal(context.return_assignee) ??
    readAgentIdFromPrincipal(context.implementer) ??
    readAgentIdFromPrincipal(context.executor);
  if (fromContext) return fromContext;

  const executionState = asRecord(input.issue?.executionState);
  if (executionState) {
    const fromState =
      readAgentIdFromPrincipal(executionState.returnAssignee) ??
      readAgentIdFromPrincipal(executionState.return_assignee) ??
      readNonEmptyString(executionState.implementerAgentId) ??
      readNonEmptyString(executionState.executorAgentId);
    if (fromState) return fromState;
  }

  // Peer runs on the same issue by non-reviewer agents are a weak implementer signal.
  const peerAgentIds = new Set<string>();
  for (const peer of input.peerRunsOnIssue ?? []) {
    if (input.reviewerAgentIds.has(peer.agentId)) continue;
    if (peer.agentId) peerAgentIds.add(peer.agentId);
  }
  if (peerAgentIds.size === 1) {
    return [...peerAgentIds][0] ?? null;
  }

  // Fall back to issue.createdByAgentId when it is not a known reviewer.
  const createdBy = readNonEmptyString(input.issue?.createdByAgentId);
  if (createdBy && !input.reviewerAgentIds.has(createdBy)) {
    return createdBy;
  }

  return null;
}

function flattenVerdictText(resultJson: unknown, error?: string | null, errorCode?: string | null): string {
  const parts: string[] = [];
  if (errorCode) parts.push(String(errorCode));
  if (error) parts.push(String(error));
  const result = asRecord(resultJson);
  if (result) {
    for (const key of [
      "reviewStatus",
      "review_status",
      "verdict",
      "outcome",
      "outcomeGrade",
      "terminalGrade",
      "decision",
      "status",
      "summary",
      "result",
      "message",
      "error",
      "reason",
    ] as const) {
      const value = readNonEmptyString(result[key]);
      if (value) parts.push(value);
    }
    const nestedReview = asRecord(result.review);
    if (nestedReview) {
      for (const key of ["status", "verdict", "outcome", "decision"] as const) {
        const value = readNonEmptyString(nestedReview[key]);
        if (value) parts.push(value);
      }
    }
    const nestedDecision = asRecord(result.decision);
    if (nestedDecision) {
      for (const key of ["outcome", "status", "verdict"] as const) {
        const value = readNonEmptyString(nestedDecision[key]);
        if (value) parts.push(value);
      }
    }
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Classify a review-run result into accepted / rejected / escalated / unknown.
 * Escalation takes precedence when markers conflict so fail-closed paths surface.
 */
export function classifyReviewVerdict(
  resultJson: unknown,
  opts: { error?: string | null; errorCode?: string | null; status?: string | null } = {},
): ReviewVerdict {
  const result = asRecord(resultJson);

  // Explicit structured markers first.
  if (result) {
    if (result.escalated === true || result.escalate === true || result.escalateToBoard === true) {
      return "escalated";
    }
    if (result.reviewAccepted === true || result.review_accepted === true) return "accepted";
    if (result.reviewRejected === true || result.review_rejected === true) return "rejected";
    if (result.accepted === true && (result.review === true || result.reviewStatus != null || result.review_status != null)) {
      return "accepted";
    }
    if (result.rejected === true && (result.review === true || result.reviewStatus != null || result.review_status != null)) {
      return "rejected";
    }

    const reviewStatus = readNonEmptyString(result.reviewStatus ?? result.review_status)?.toLowerCase();
    if (reviewStatus) {
      if (isEscalationToken(reviewStatus)) return "escalated";
      if (isAcceptedToken(reviewStatus)) return "accepted";
      if (isRejectedToken(reviewStatus)) return "rejected";
    }

    const outcome = readNonEmptyString(
      result.outcome ?? result.outcomeGrade ?? result.terminalGrade ?? result.verdict,
    )?.toLowerCase();
    if (outcome) {
      if (isEscalationToken(outcome)) return "escalated";
      if (isAcceptedToken(outcome)) return "accepted";
      if (isRejectedToken(outcome)) return "rejected";
    }

    const nestedReview = asRecord(result.review);
    if (nestedReview) {
      if (nestedReview.accepted === true || nestedReview.approved === true) return "accepted";
      if (nestedReview.rejected === true || nestedReview.changesRequested === true) return "rejected";
      if (nestedReview.escalated === true) return "escalated";
      const status = readNonEmptyString(nestedReview.status ?? nestedReview.verdict)?.toLowerCase();
      if (status) {
        if (isEscalationToken(status)) return "escalated";
        if (isAcceptedToken(status)) return "accepted";
        if (isRejectedToken(status)) return "rejected";
      }
    }

    const nestedDecision = asRecord(result.decision);
    if (nestedDecision) {
      const decisionOutcome = readNonEmptyString(
        nestedDecision.outcome ?? nestedDecision.status ?? nestedDecision.verdict,
      )?.toLowerCase();
      if (decisionOutcome) {
        if (isEscalationToken(decisionOutcome)) return "escalated";
        // Execution-policy decisions use approved / changes_requested.
        if (isAcceptedToken(decisionOutcome) || decisionOutcome === "approved") return "accepted";
        if (isRejectedToken(decisionOutcome) || decisionOutcome === "changes_requested") return "rejected";
      }
    }
  }

  const text = flattenVerdictText(resultJson, opts.error, opts.errorCode);
  if (text) {
    if (
      text.includes("escalate") ||
      text.includes("escalated") ||
      text.includes("escalate_to_board") ||
      text.includes("escalate to board")
    ) {
      return "escalated";
    }
    if (
      text.includes("changes_requested") ||
      text.includes("changes requested") ||
      text.includes("rejected") ||
      text.includes("request changes")
    ) {
      return "rejected";
    }
    if (
      text.includes("accepted") ||
      text.includes("approved") ||
      text.includes("lgtm") ||
      text.includes("exact-head accept")
    ) {
      return "accepted";
    }
  }

  return "unknown";
}

function isAcceptedToken(value: string): boolean {
  return (
    value === "accepted" ||
    value === "approved" ||
    value === "accept" ||
    value === "approve" ||
    value === "done_accepted" ||
    value === "pass" ||
    value === "passed"
  );
}

function isRejectedToken(value: string): boolean {
  return (
    value === "rejected" ||
    value === "reject" ||
    value === "changes_requested" ||
    value === "changes-requested" ||
    value === "request_changes" ||
    value === "request-changes" ||
    value === "denied" ||
    value === "failed_review" ||
    value === "fail"
  );
}

function isEscalationToken(value: string): boolean {
  return (
    value === "escalated" ||
    value === "escalate" ||
    value === "escalate_to_board" ||
    value === "escalate-to-board" ||
    value === "board_escalation"
  );
}

/**
 * Latency sample in ms from createdAt → updatedAt (falls back to finishedAt).
 * Returns null when timestamps are missing or non-positive.
 */
export function reviewRunLatencyMs(run: Pick<ReviewPathSloRun, "createdAt" | "updatedAt" | "finishedAt">): number | null {
  const start = toTime(run.createdAt);
  const end = toTime(run.updatedAt) ?? toTime(run.finishedAt);
  if (start == null || end == null) return null;
  const delta = end - start;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta;
}

/**
 * Percentile of a sorted numeric sample (nearest-rank, 0-based clamp).
 * `percentile` is in (0, 1], e.g. 0.5 for median, 0.95 for p95.
 */
export function percentileNearestRank(sortedAscending: number[], percentile: number): number | null {
  if (sortedAscending.length === 0) return null;
  if (percentile <= 0) return sortedAscending[0] ?? null;
  if (percentile >= 1) return sortedAscending[sortedAscending.length - 1] ?? null;
  const rank = Math.ceil(percentile * sortedAscending.length) - 1;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank));
  return sortedAscending[index] ?? null;
}

export function isReviewRunFailed(status: string): boolean {
  const normalized = status.trim().toLowerCase();
  return normalized === "failed" || normalized === "timed_out" || normalized === "timeout";
}

/**
 * Pure review-path SLO builder — free of DB so unit tests can drive fixtures.
 */
export function buildReviewPathSlo(input: BuildReviewPathSloInput): ReviewPathSloReport {
  const sinceMs = input.since.getTime();
  const untilMs = input.until.getTime();
  const reviewerAgentIds = new Set(input.reviewerAgents.map((agent) => agent.id));
  const issueById = new Map((input.issues ?? []).map((issue) => [issue.id, issue]));

  const reviewRuns = input.runs.filter(
    (run) => reviewerAgentIds.has(run.agentId) && inWindow(run.createdAt, sinceMs, untilMs),
  );

  const peerRunsByIssue = new Map<string, ReviewPathSloRun[]>();
  for (const peer of input.peerRuns ?? []) {
    const issueId = resolveIssueIdFromRun(peer);
    if (!issueId) continue;
    if (reviewerAgentIds.has(peer.agentId)) continue;
    const list = peerRunsByIssue.get(issueId) ?? [];
    list.push(peer);
    peerRunsByIssue.set(issueId, list);
  }

  let acceptedVerdicts = 0;
  let rejectedVerdicts = 0;
  let escalations = 0;
  let failedRuns = 0;
  let independenceViolations = 0;
  const latencies: number[] = [];

  for (const run of reviewRuns) {
    if (isReviewRunFailed(run.status)) failedRuns += 1;

    const verdict = classifyReviewVerdict(run.resultJson, {
      error: run.error,
      errorCode: run.errorCode,
      status: run.status,
    });
    if (verdict === "accepted") acceptedVerdicts += 1;
    else if (verdict === "rejected") rejectedVerdicts += 1;
    else if (verdict === "escalated") escalations += 1;

    const latency = reviewRunLatencyMs(run);
    if (latency != null) latencies.push(latency);

    const issueId = resolveIssueIdFromRun(run);
    const issue = issueId ? issueById.get(issueId) ?? null : null;
    const implementerAgentId = resolveImplementerAgentId({
      run,
      issue,
      peerRunsOnIssue: issueId ? peerRunsByIssue.get(issueId) : undefined,
      reviewerAgentIds,
    });
    if (implementerAgentId && implementerAgentId === run.agentId) {
      independenceViolations += 1;
    }
  }

  latencies.sort((a, b) => a - b);

  const idleHealthy =
    input.reviewerAgents.length > 0 &&
    input.reviewerAgents.every((agent) => isIdleHealthyStatus(agent.status));

  return {
    window: {
      since: input.since.toISOString(),
      until: input.until.toISOString(),
    },
    companyId: input.companyId,
    reviewerAgents: input.reviewerAgents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      status: agent.status,
    })),
    metrics: {
      reviewRuns: reviewRuns.length,
      acceptedVerdicts,
      rejectedVerdicts,
      escalations,
      medianLatencyMs: percentileNearestRank(latencies, 0.5),
      p95LatencyMs: percentileNearestRank(latencies, 0.95),
      errorRate: safeRatio(failedRuns, reviewRuns.length),
      idleHealthy,
      independenceViolations,
    },
  };
}

export interface ReviewPathSloQuery {
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

export function resolveReviewPathSloWindow(
  query: ReviewPathSloQuery = {},
): { since: Date; until: Date } {
  const now = query.now ?? new Date();
  const until = parseDateInput(query.until, "until") ?? now;
  const since =
    parseDateInput(query.since, "since") ??
    new Date(until.getTime() - REVIEW_PATH_SLO_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { since, until };
}

export function reviewPathSloService(db: Db) {
  return {
    /**
     * Load reviewer agent(s) + recent runs for the company window and compute
     * the Argus review-path SLO report.
     */
    forCompany: async (
      companyId: string,
      query: ReviewPathSloQuery = {},
    ): Promise<ReviewPathSloReport> => {
      const company = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows[0] ?? null);
      if (!company) throw notFound("Company not found");

      const { since, until } = resolveReviewPathSloWindow(query);

      // Reviewer agents: name Argus (case-insensitive) OR role = reviewer.
      const agentRows = await db
        .select({
          id: agents.id,
          name: agents.name,
          role: agents.role,
          status: agents.status,
        })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            or(
              sql`lower(${agents.name}) = ${ARGUS_REVIEWER_NAME}`,
              sql`lower(${agents.role}) = 'reviewer'`,
            ),
          ),
        )
        .limit(REVIEW_PATH_SLO_MAX_AGENTS);

      const reviewerAgents: ReviewPathSloAgent[] = agentRows.filter(isReviewerAgent);
      const reviewerAgentIds = reviewerAgents.map((agent) => agent.id);

      if (reviewerAgentIds.length === 0) {
        return buildReviewPathSlo({
          companyId,
          since,
          until,
          reviewerAgents: [],
          runs: [],
          issues: [],
          peerRuns: [],
        });
      }

      const runRows = await db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          createdAt: heartbeatRuns.createdAt,
          updatedAt: heartbeatRuns.updatedAt,
          finishedAt: heartbeatRuns.finishedAt,
          startedAt: heartbeatRuns.startedAt,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          resultJson: heartbeatRuns.resultJson,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          issueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            inArray(heartbeatRuns.agentId, reviewerAgentIds),
            gte(heartbeatRuns.createdAt, since),
            lte(heartbeatRuns.createdAt, until),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt))
        .limit(REVIEW_PATH_SLO_MAX_RUNS);

      const issueIds = new Set<string>();
      for (const row of runRows) {
        if (row.issueId) issueIds.add(row.issueId);
      }

      const issueIdList = [...issueIds];
      const issueRows =
        issueIdList.length === 0
          ? []
          : await db
              .select({
                id: issues.id,
                status: issues.status,
                assigneeAgentId: issues.assigneeAgentId,
                createdByAgentId: issues.createdByAgentId,
                executionState: issues.executionState,
                executionPolicy: issues.executionPolicy,
              })
              .from(issues)
              .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueIdList)));

      // Peer runs on the same issues (any agent) for implementer detection.
      // Cap to avoid unbounded scans; independence is best-effort scaffolding.
      let peerRunRows: typeof runRows = [];
      if (issueIdList.length > 0) {
        const issueIdMatch =
          issueIdList.length === 1
            ? sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueIdList[0]}`
            : sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' IN (${sql.join(
                issueIdList.map((id) => sql`${id}`),
                sql`, `,
              )})`;
        peerRunRows = await db
          .select({
            id: heartbeatRuns.id,
            agentId: heartbeatRuns.agentId,
            status: heartbeatRuns.status,
            createdAt: heartbeatRuns.createdAt,
            updatedAt: heartbeatRuns.updatedAt,
            finishedAt: heartbeatRuns.finishedAt,
            startedAt: heartbeatRuns.startedAt,
            error: heartbeatRuns.error,
            errorCode: heartbeatRuns.errorCode,
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
              issueIdMatch,
            ),
          )
          .orderBy(desc(heartbeatRuns.createdAt))
          .limit(REVIEW_PATH_SLO_MAX_RUNS);
      }

      const mapRun = (row: (typeof runRows)[number]): ReviewPathSloRun => ({
        id: row.id,
        agentId: row.agentId,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        finishedAt: row.finishedAt,
        startedAt: row.startedAt,
        error: row.error,
        errorCode: row.errorCode,
        resultJson: row.resultJson,
        contextSnapshot: row.contextSnapshot,
        issueId: row.issueId,
      });

      return buildReviewPathSlo({
        companyId,
        since,
        until,
        reviewerAgents,
        runs: runRows.map(mapRun),
        issues: issueRows.map((row) => ({
          id: row.id,
          status: row.status,
          assigneeAgentId: row.assigneeAgentId,
          createdByAgentId: row.createdByAgentId,
          executionState: row.executionState,
          executionPolicy: row.executionPolicy,
        })),
        peerRuns: peerRunRows.map(mapRun),
      });
    },
  };
}
