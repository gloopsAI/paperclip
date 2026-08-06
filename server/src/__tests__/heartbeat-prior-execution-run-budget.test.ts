import { describe, expect, it } from "vitest";
import { priorExecutionRun } from "../services/heartbeat.js";
import {
  EXECUTION_ADMISSION_CONTEXT_KEY,
  buildExecutionAdmissionEnvelope,
  evaluateExecutionAdmission,
  isBudgetExemptPreflightFailure,
  parseExecutionAdmissionPolicy,
} from "../services/execution-admission.js";

// Colocated with heartbeat.ts (not execution-admission.test.ts): priorExecutionRun
// is defined and exported from heartbeat.ts (WG-PLAT-005 extraction pattern, see
// runLifecycleContextCoordinates / heartbeat-run-lifecycle-context.test.ts for
// precedent). execution-admission.ts's own exports (summarizePriorExecution,
// evaluateExecutionAdmission, isBudgetExemptPreflightFailure, etc.) are unchanged
// by this fix and stay covered by execution-admission.test.ts. No DB is touched
// here, matching heartbeat-run-lifecycle-context.test.ts / heartbeat-execution-*
// pure-function tests rather than the embedded-postgres-backed
// heartbeat-execution-admission.test.ts.

const FOUR_HOUR_WALL_MS = 14_400_000;

function fullTaskReservationPolicy() {
  const parsed = parseExecutionAdmissionPolicy({
    PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
    PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "3",
    PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "2",
    PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "1000000",
    PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "200000",
    PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: String(FOUR_HOUR_WALL_MS),
    PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "400000",
    PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "100000",
    PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "6",
    PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "24",
  });
  if (!parsed.enabled) throw new Error("expected enabled policy");
  return parsed;
}

/**
 * Builds a valid, fully-populated execution-admission context snapshot whose
 * reservation.maxWallMs equals the entire remaining task wall budget
 * (FOUR_HOUR_WALL_MS) — mirroring a task's first invocation, exactly the
 * scenario production bricking reports describe.
 */
function contextSnapshotWithFullReservation() {
  const policy = fullTaskReservationPolicy();
  const envelope = buildExecutionAdmissionEnvelope({
    identity: { budgetId: "issue:budget-accounting-test:default", epoch: "default" },
    policy,
    decision: evaluateExecutionAdmission(policy, []),
    evaluatedAt: new Date("2026-08-01T00:00:00Z"),
  });
  expect(envelope.reservation?.maxWallMs).toBe(FOUR_HOUR_WALL_MS);
  return { [EXECUTION_ADMISSION_CONTEXT_KEY]: envelope };
}

describe("priorExecutionRun task-budget accounting for terminal runs", () => {
  it("charges elapsed wall time, not the full reservation, for a cancelled run that never wrote usageJson", () => {
    // startedAt -> finishedAt is 1000ms; usageJson is null (no adapter usage
    // was ever persisted) because the run was cancelled before/without
    // reaching adapter completion.
    const startedAt = new Date("2026-08-01T10:00:00.000Z");
    const finishedAt = new Date("2026-08-01T10:00:01.000Z");

    const result = priorExecutionRun(
      {
        retryOfRunId: null,
        usageJson: null,
        resultJson: {},
        contextSnapshot: contextSnapshotWithFullReservation(),
        errorCode: "cancelled",
        startedAt,
        finishedAt,
      },
      new Date("2026-08-01T10:05:00.000Z"),
    );

    expect(result.wallMs).toBe(1000);
    expect(result.wallMs).not.toBe(FOUR_HOUR_WALL_MS);
  });

  it("charges zero wall time for a run that was cancelled before it ever started (402/500 production class)", () => {
    // startedAt is null: the run never actually began executing. usageJson is
    // null for the same reason. Prior to the fix, useReservation was true
    // here (finishedAt !== null OR usageJson == null short-circuited on the
    // usageJson clause), charging the entire reservation for work that never
    // happened at all.
    const finishedAt = new Date("2026-08-01T10:00:00.000Z");

    const result = priorExecutionRun(
      {
        retryOfRunId: null,
        usageJson: null,
        resultJson: {},
        contextSnapshot: contextSnapshotWithFullReservation(),
        errorCode: "cancelled",
        startedAt: null,
        finishedAt,
      },
      new Date("2026-08-01T10:05:00.000Z"),
    );

    expect(result.wallMs).toBe(0);
  });

  it("regression guard: an in-flight run still holds its full reservation, even with no processPid (must NOT be gated on PID liveness)", () => {
    // finishedAt === null: the run is genuinely still in flight. Note this
    // row shape (the actual priorExecutionRun parameter type) carries no
    // processPid field at all — there is no PID to probe, by construction.
    // In this deployment processPid is null on live 500/500 runs, so a
    // PID-liveness gate (`finishedAt === null && isProcessLive(row)`) would
    // misclassify every in-flight run as dead and drop the reservation hold,
    // which is the inverse of the bug this fix addresses. This test fails if
    // that formulation is reintroduced.
    const startedAt = new Date("2026-08-01T10:00:00.000Z");

    const result = priorExecutionRun(
      {
        retryOfRunId: null,
        usageJson: null,
        resultJson: {},
        contextSnapshot: contextSnapshotWithFullReservation(),
        errorCode: null,
        startedAt,
        finishedAt: null,
      },
      // Well past the reservation's wall budget if elapsed time were
      // (incorrectly) used instead of the reservation.
      new Date("2026-08-01T20:00:00.000Z"),
    );

    expect(result.wallMs).toBe(FOUR_HOUR_WALL_MS);
  });

  it("Part 2: a cancelled-before-adapter run is budget-exempt outright via resultJson.provider_invocation.attempted = false", () => {
    // This is exactly the resultJson shape cancelRunStatusUpdate now
    // persists on a pre-adapter cancel (see heartbeat.ts cancelRunInternal /
    // cancelActiveForAgentInternal). isBudgetExemptPreflightFailure already
    // keys off providerInvocationAttempted === false; this pins that
    // contract so a regression in either side is caught here without a DB.
    const finishedAt = new Date("2026-08-01T10:00:00.000Z");

    const result = priorExecutionRun(
      {
        retryOfRunId: null,
        usageJson: null,
        resultJson: { provider_invocation: { attempted: false } },
        contextSnapshot: contextSnapshotWithFullReservation(),
        errorCode: "cancelled",
        startedAt: null,
        finishedAt,
      },
      new Date("2026-08-01T10:05:00.000Z"),
    );

    expect(result.countsTowardTaskBudget).toBe(false);
    expect(
      isBudgetExemptPreflightFailure({ providerInvocationAttempted: false, errorCode: "cancelled" }),
    ).toBe(true);
  });
});
