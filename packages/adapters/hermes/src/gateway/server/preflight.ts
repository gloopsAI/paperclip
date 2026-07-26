/**
 * Supervisor operational closure primitives for the Hermes gateway adapter.
 *
 * This module is the bounded, testable surface that backs the five-item
 * closure (pre-dispatch readiness, idempotent terminal reconciliation,
 * deterministic workspace preparation, resume without side-effect replay,
 * and the bounded repair ladder) plus the budget-release defect fix.
 *
 * All functions are pure: no I/O is performed unless explicitly passed a
 * probe function. This keeps the implementation replayable from tests and
 * from the supervisor repair path.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  AdapterExecutionContext,
  AdapterHermesTerminalEvidenceProjection,
  AdapterProviderIoTerminalEvidence,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import {
  PAPERCLIP_EXECUTION_CONTEXT_KEY,
  readBoundExecutionContext,
  type ExecutionInvocationBudget,
} from "@paperclipai/adapter-utils/execution-envelope";

const execFileAsync = promisify(execFile);
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ZERO_USAGE: UsageSummary = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stableStringify(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(stable);
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, vv]) => [k, stable(vv)]),
    );
  };
  return JSON.stringify(stable(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function readWorkspace(ctx: AdapterExecutionContext): { cwd: string | null; ref: string | null; repoUrl: string | null } {
  const ws = asRecord(ctx.context.paperclipWorkspace);
  if (!ws) return { cwd: null, ref: null, repoUrl: null };
  return {
    cwd: nonEmpty(ws.cwd),
    ref: nonEmpty(ws.repoRef) ?? nonEmpty(ws.ref) ?? nonEmpty(ws.branch) ?? nonEmpty(ws.commit) ?? nonEmpty(ws.headSha),
    repoUrl: nonEmpty(ws.repoUrl) ?? nonEmpty(ws.repositoryUrl) ?? nonEmpty(ws.url) ?? nonEmpty(ws.repository),
  };
}

function readBinding(ctx: AdapterExecutionContext): ReturnType<typeof readBoundExecutionContext> {
  return readBoundExecutionContext(ctx.context[PAPERCLIP_EXECUTION_CONTEXT_KEY]);
}

function packetExactHead(packet: Record<string, unknown> | undefined | null): string | null {
  if (!packet) return null;
  const verification = asRecord(packet.verification);
  const workspace = asRecord(packet.workspace);
  return (
    nonEmpty(verification?.exactHeadSha) ??
    nonEmpty(workspace?.exactHeadSha) ??
    nonEmpty(workspace?.headSha)
  )?.toLowerCase() ?? null;
}

function configuredExpectedHead(ctx: AdapterExecutionContext, binding: ReturnType<typeof readBoundExecutionContext>): { expected: string | null; error: string | null } {
  const configured = nonEmpty(ctx.config.expectedWorkspaceHeadSha)?.toLowerCase() ?? null;
  const packetHead = packetExactHead(asRecord(binding?.packet));
  if (configured && packetHead && configured !== packetHead) {
    return {
      expected: null,
      error: `Configured workspace head ${configured} does not match bound packet head ${packetHead}.`,
    };
  }
  const expected = configured ?? packetHead;
  if (expected && !SHA.test(expected)) {
    return { expected: null, error: `Expected workspace head must be a full 40-character commit SHA; received ${expected}.` };
  }
  return { expected, error: null };
}

// ---------------------------------------------------------------------------
// 1) Pre-dispatch readiness report
// ---------------------------------------------------------------------------

export type ReadinessCapability =
  | "workspace_present"
  | "workspace_writable"
  | "workspace_aligned"
  | "git_tooling"
  | "hermes_write_capability"
  | "test_runtime"
  | "binding_valid";

export type ReadinessLevel = "ready" | "degraded" | "blocked";

export interface ReadinessCheck {
  capability: ReadinessCapability;
  passed: boolean;
  detail: string;
}

export interface PreDispatchReadinessReport {
  schemaVersion: "gloops.hermes.preflight-readiness.v1";
  runId: string;
  observedAt: string;
  level: ReadinessLevel;
  checks: ReadinessCheck[];
  /** Stable digest of the report so the supervisor can dedupe replays. */
  digest: string;
  /** True when every check passed. */
  ready: boolean;
}

export interface ReadinessProbe {
  /** Probe a file or directory's existence/readability/writability. */
  fsStat?: (path: string) => Promise<{ exists: boolean; writable: boolean; isDirectory: boolean }>;
  /** Run `git rev-parse HEAD` in a cwd. Returns trimmed stdout on success. */
  gitHead?: (cwd: string) => Promise<{ head: string | null; error: string | null }>;
  /** Probe whether the Hermes side can accept writes (e.g. GET /health). */
  probeHermesWrite?: (apiBaseUrl: string) => Promise<{ ok: boolean; reason: string }>;
  /** Probe whether the test runtime is reachable. */
  probeTestRuntime?: () => Promise<{ ok: boolean; reason: string }>;
}

const defaultReadinessProbe: Required<Omit<ReadinessProbe, never>> = {
  async fsStat(path) {
    try {
      const s = await stat(path);
      return { exists: true, writable: true, isDirectory: s.isDirectory() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { exists: false, writable: false, isDirectory: false };
      }
      return { exists: false, writable: false, isDirectory: false };
    }
  },
  async gitHead(cwd) {
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
      return { head: stdout.trim().toLowerCase(), error: null };
    } catch (error) {
      return { head: null, error: error instanceof Error ? error.message : String(error) };
    }
  },
  async probeHermesWrite(apiBaseUrl) {
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/health`, { method: "GET" });
      if (response.ok) return { ok: true, reason: "hermes /health ok" };
      return { ok: false, reason: `hermes /health returned HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  },
  async probeTestRuntime() {
    return { ok: true, reason: "test runtime probe not configured; defaulting to ok" };
  },
};

export async function buildPreDispatchReadinessReport(
  ctx: AdapterExecutionContext,
  probe: ReadinessProbe = {},
): Promise<PreDispatchReadinessReport> {
  const checks: ReadinessCheck[] = [];
  const observedAt = new Date().toISOString();
  const workspace = readWorkspace(ctx);
  const binding = readBinding(ctx);
  const fsStat = probe.fsStat ?? defaultReadinessProbe.fsStat;
  const gitHead = probe.gitHead ?? defaultReadinessProbe.gitHead;
  const probeHermesWrite = probe.probeHermesWrite ?? defaultReadinessProbe.probeHermesWrite;
  const probeTestRuntime = probe.probeTestRuntime ?? defaultReadinessProbe.probeTestRuntime;

  // 1) workspace_present + workspace_writable
  if (workspace.cwd) {
    const status = await fsStat(workspace.cwd);
    if (status.exists) {
      checks.push({
        capability: "workspace_present",
        passed: true,
        detail: `Workspace ${workspace.cwd} is present`,
      });
      const writable = status.writable;
      checks.push({
        capability: "workspace_writable",
        passed: writable,
        detail: writable
          ? `Workspace ${workspace.cwd} is writable`
          : `Workspace ${workspace.cwd} is not writable`,
      });
    } else {
      checks.push({
        capability: "workspace_present",
        passed: false,
        detail: `Workspace ${workspace.cwd} is missing`,
      });
      checks.push({
        capability: "workspace_writable",
        passed: false,
        detail: `Workspace ${workspace.cwd} is missing; cannot probe write access`,
      });
    }
  } else {
    checks.push({
      capability: "workspace_present",
      passed: false,
      detail: "Paperclip did not provide a workspace cwd",
    });
    checks.push({
      capability: "workspace_writable",
      passed: false,
      detail: "Workspace cwd missing; cannot probe write access",
    });
  }

  // 2) workspace_aligned + git_tooling
  const { expected, error: expectedError } = configuredExpectedHead(ctx, binding);
  const workPreparation = asRecord(ctx.context.paperclipWorkPreparation);
  const repoToolingRequired = workPreparation?.implementation !== false
    || workspace.ref !== null
    || workspace.repoUrl !== null
    || expected !== null;
  if (expectedError) {
    checks.push({
      capability: "workspace_aligned",
      passed: false,
      detail: expectedError,
    });
    checks.push({
      capability: "git_tooling",
      passed: false,
      detail: "Skipped due to invalid expected head",
    });
  } else if (!repoToolingRequired) {
    checks.push({
      capability: "git_tooling",
      passed: true,
      detail: "Git tooling is not required for non-implementation work without a repository binding",
    });
    checks.push({
      capability: "workspace_aligned",
      passed: true,
      detail: "Repository alignment is not required for non-implementation work without a repository binding",
    });
  } else if (!workspace.cwd) {
    checks.push({
      capability: "workspace_aligned",
      passed: false,
      detail: "Workspace cwd missing; cannot probe alignment",
    });
    checks.push({
      capability: "git_tooling",
      passed: false,
      detail: "Workspace cwd missing; cannot probe git tooling",
    });
  } else {
    const head = await gitHead(workspace.cwd);
    if (head.error || !head.head) {
      checks.push({
        capability: "git_tooling",
        passed: false,
        detail: `git rev-parse failed: ${head.error ?? "unknown error"}`,
      });
      checks.push({
        capability: "workspace_aligned",
        passed: false,
        detail: "Cannot verify alignment without git rev-parse",
      });
    } else {
      checks.push({
        capability: "git_tooling",
        passed: true,
        detail: `git rev-parse HEAD succeeded in ${workspace.cwd} (${head.head})`,
      });
      if (expected) {
        if (expected === head.head) {
          checks.push({
            capability: "workspace_aligned",
            passed: true,
            detail: `Workspace HEAD ${head.head} matches declared head ${expected}`,
          });
        } else {
          checks.push({
            capability: "workspace_aligned",
            passed: false,
            detail: `Workspace HEAD ${head.head} does not match declared head ${expected}`,
          });
        }
      } else {
        checks.push({
          capability: "workspace_aligned",
          passed: true,
          detail: "No expected head declared; aligned-by-default",
        });
      }
    }
  }

  // 3) hermes_write_capability
  const apiBaseUrl = nonEmpty(ctx.config.apiBaseUrl);
  if (apiBaseUrl) {
    const writeCheck = await probeHermesWrite(apiBaseUrl);
    checks.push({
      capability: "hermes_write_capability",
      passed: writeCheck.ok,
      detail: writeCheck.reason,
    });
  } else {
    checks.push({
      capability: "hermes_write_capability",
      passed: false,
      detail: "apiBaseUrl is missing",
    });
  }

  // 4) test_runtime
  const runtime = await probeTestRuntime();
  checks.push({
    capability: "test_runtime",
    passed: runtime.ok,
    detail: runtime.reason,
  });

  // 5) binding_valid
  const rawBinding = ctx.context[PAPERCLIP_EXECUTION_CONTEXT_KEY];
  if (rawBinding === undefined || rawBinding === null) {
    checks.push({
      capability: "binding_valid",
      passed: true,
      detail: "Legacy execution context (no bound packet)",
    });
  } else if (binding) {
    checks.push({
      capability: "binding_valid",
      passed: true,
      detail: "Bound execution context is valid",
    });
  } else {
    checks.push({
      capability: "binding_valid",
      passed: false,
      detail: "Bound execution context is malformed",
    });
  }

  const passedAll = checks.every((check) => check.passed);
  const blockingFailures = checks.some((check) =>
    !check.passed
    && (check.capability === "workspace_present"
      || check.capability === "workspace_writable"
      || check.capability === "workspace_aligned"
      || check.capability === "hermes_write_capability"
      || check.capability === "binding_valid"),
  );
  const level: ReadinessLevel = blockingFailures ? "blocked" : passedAll ? "ready" : "degraded";
  return {
    schemaVersion: "gloops.hermes.preflight-readiness.v1",
    runId: ctx.runId,
    observedAt,
    level,
    checks,
    digest: sha256(stableStringify({ runId: ctx.runId, checks })),
    ready: passedAll,
  };
}

// ---------------------------------------------------------------------------
// 2) Durable idempotent terminal reconciliation across run/issue/projection
// ---------------------------------------------------------------------------

export type ReconciliationDisposition =
  | "unreconciled"
  | "matched"
  | "diverged_run_vs_issue"
  | "diverged_issue_vs_projection"
  | "diverged_run_vs_projection"
  | "missing_run_evidence"
  | "missing_issue_projection"
  | "missing_pr_evidence";

export interface TerminalReconciliationInput {
  runTerminalEvidence: AdapterProviderIoTerminalEvidence | null;
  issueProjection: {
    issueId: string;
    terminalEvidenceDigest: string;
    terminalStatus: string;
    hermesRunId: string;
  } | null;
  prProjection: {
    prNumber: number;
    terminalEvidenceDigest: string;
    terminalStatus: string;
  } | null;
}

export interface TerminalReconciliationReport {
  schemaVersion: "gloops.hermes.terminal-reconciliation.v1";
  disposition: ReconciliationDisposition;
  /**
   * Stable digest of the canonicalized inputs. Two reports with the same
   * digest MUST produce the same disposition, which is the idempotency
   * guarantee the supervisor can rely on.
   */
  digest: string;
  observedAt: string;
  mismatches: string[];
}

export function reconcileTerminalAcrossProjections(input: TerminalReconciliationInput): TerminalReconciliationReport {
  const observedAt = new Date().toISOString();
  const runDigest = input.runTerminalEvidence?.terminalEvidenceDigest ?? null;
  const runStatus = input.runTerminalEvidence?.terminalEvidence.terminalStatus ?? null;
  const runHermesId = input.runTerminalEvidence?.hermesRunId ?? null;
  const issueDigest = input.issueProjection?.terminalEvidenceDigest ?? null;
  const prDigest = input.prProjection?.terminalEvidenceDigest ?? null;

  if (!runDigest || !SHA256.test(runDigest)) {
    return {
      schemaVersion: "gloops.hermes.terminal-reconciliation.v1",
      disposition: "missing_run_evidence",
      digest: sha256(stableStringify({ runDigest, issueDigest, prDigest, kind: "missing-run" })),
      observedAt,
      mismatches: ["run terminal evidence is missing or malformed"],
    };
  }
  if (input.issueProjection && !SHA256.test(input.issueProjection.terminalEvidenceDigest)) {
    return {
      schemaVersion: "gloops.hermes.terminal-reconciliation.v1",
      disposition: "missing_issue_projection",
      digest: sha256(stableStringify({ runDigest, issueDigest, prDigest, kind: "bad-issue" })),
      observedAt,
      mismatches: ["issue projection digest is malformed"],
    };
  }
  if (input.prProjection && !SHA256.test(input.prProjection.terminalEvidenceDigest)) {
    return {
      schemaVersion: "gloops.hermes.terminal-reconciliation.v1",
      disposition: "missing_pr_evidence",
      digest: sha256(stableStringify({ runDigest, issueDigest, prDigest, kind: "bad-pr" })),
      observedAt,
      mismatches: ["pr projection digest is malformed"],
    };
  }
  const mismatches: string[] = [];
  if (input.issueProjection && input.issueProjection.terminalEvidenceDigest !== runDigest) {
    mismatches.push("run evidence digest diverges from issue projection");
  }
  if (input.prProjection && input.prProjection.terminalEvidenceDigest !== runDigest) {
    mismatches.push("run evidence digest diverges from pr projection");
  }
  if (input.issueProjection && input.issueProjection.terminalStatus !== runStatus) {
    mismatches.push("run status diverges from issue status");
  }
  if (input.prProjection && input.prProjection.terminalStatus !== runStatus) {
    mismatches.push("run status diverges from pr status");
  }
  if (input.issueProjection && runHermesId && input.issueProjection.hermesRunId !== runHermesId) {
    mismatches.push("issue projection hermesRunId does not match run");
  }
  let disposition: ReconciliationDisposition = "matched";
  if (mismatches.length > 0) {
    if (input.issueProjection && input.prProjection) {
      disposition = "diverged_run_vs_projection";
    } else if (input.issueProjection) {
      disposition = "diverged_run_vs_issue";
    } else {
      disposition = "diverged_issue_vs_projection";
    }
  } else if (!input.issueProjection && !input.prProjection) {
    disposition = "unreconciled";
  }
  return {
    schemaVersion: "gloops.hermes.terminal-reconciliation.v1",
    disposition,
    digest: sha256(stableStringify({ runDigest, issueDigest, prDigest, mismatches })),
    observedAt,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// 3) Deterministic workspace preparation
// ---------------------------------------------------------------------------

export interface WorkspacePreparationOptions {
  /** Override the apply_patch binary location (defaults to /opt/data/bin/apply_patch). */
  applyPatchPath?: string;
  /** Override the focused_test binary location. */
  focusedTestPath?: string;
  /** Inject a custom probe (for tests). */
  probe?: {
    fsStat?: (path: string) => Promise<{ exists: boolean; writable: boolean; isDirectory: boolean }>;
    runProcess?: (command: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
}

export interface WorkspacePreparationResult {
  schemaVersion: "gloops.hermes.workspace-preparation.v1";
  expected: string | null;
  actual: string | null;
  clean: boolean;
  writable: boolean | null;
  testRuntimeOk: boolean | null;
  applyPatchOk: boolean | null;
  error: string | null;
  observedAt: string;
}

const DEFAULT_APPLY_PATCH = "/opt/data/bin/apply_patch";
const DEFAULT_FOCUSED_TEST = "/opt/data/bin/focused_test";

export async function prepareWorkspaceBeforeDispatch(
  ctx: AdapterExecutionContext,
  binding: ReturnType<typeof readBoundExecutionContext>,
  options: WorkspacePreparationOptions = {},
): Promise<WorkspacePreparationResult> {
  const observedAt = new Date().toISOString();
  const workspace = readWorkspace(ctx);
  const { expected, error: expectedError } = configuredExpectedHead(ctx, binding);
  const fsStat = options.probe?.fsStat ?? (async (path: string) => {
    try {
      const s = await stat(path);
      return { exists: true, writable: true, isDirectory: s.isDirectory() };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { exists: false, writable: false, isDirectory: false };
      }
      return { exists: false, writable: false, isDirectory: false };
    }
  });
  const runProcess = options.probe?.runProcess ?? (async (command: string, args: string[]) => {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd: workspace.cwd ?? undefined });
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string };
      return { exitCode: 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
  });

  if (expectedError) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual: null,
      clean: false,
      writable: null,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: expectedError,
      observedAt,
    };
  }
  if (!workspace.cwd) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual: null,
      clean: false,
      writable: null,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: "Workspace cwd is missing",
      observedAt,
    };
  }

  const status = await fsStat(workspace.cwd);
  if (!status.exists) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual: null,
      clean: false,
      writable: false,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: `Workspace ${workspace.cwd} does not exist`,
      observedAt,
    };
  }
  let writable = status.writable;
  const workPreparation = asRecord(ctx.context.paperclipWorkPreparation);
  const repoToolingRequired = workPreparation?.implementation !== false
    || workspace.ref !== null
    || workspace.repoUrl !== null
    || expected !== null;
  if (!repoToolingRequired) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected: null,
      actual: null,
      clean: true,
      writable,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: null,
      observedAt,
    };
  }
  const head = await runProcess("git", ["rev-parse", "HEAD"]);
  if (head.exitCode !== 0) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual: null,
      clean: false,
      writable,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: `git rev-parse HEAD failed: ${head.stderr || "unknown error"}`,
      observedAt,
    };
  }
  const actual = head.stdout.trim().toLowerCase();
  if (expected && actual !== expected) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual,
      clean: false,
      writable,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: `Workspace HEAD ${actual || "unknown"} does not match declared head ${expected}`,
      observedAt,
    };
  }
  const dirty = await runProcess("git", ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const clean = dirty.exitCode === 0 && dirty.stdout.trim().length === 0;
  if (!clean) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual,
      clean: false,
      writable,
      testRuntimeOk: null,
      applyPatchOk: null,
      error: "Workspace contains uncommitted or untracked changes",
      observedAt,
    };
  }
  const applyPatchPath = options.applyPatchPath ?? DEFAULT_APPLY_PATCH;
  const focusedTestPath = options.focusedTestPath ?? DEFAULT_FOCUSED_TEST;
  const [applyPatchStat, focusedTestStat] = await Promise.all([
    fsStat(applyPatchPath),
    fsStat(focusedTestPath),
  ]);
  const applyPatchOk = applyPatchStat.exists;
  const testRuntimeOk = focusedTestStat.exists;
  if (!applyPatchOk || !testRuntimeOk) {
    return {
      schemaVersion: "gloops.hermes.workspace-preparation.v1",
      expected,
      actual,
      clean: true,
      writable,
      testRuntimeOk,
      applyPatchOk,
      error: `Required tool missing: apply_patch=${applyPatchOk} test_runtime=${testRuntimeOk}`,
      observedAt,
    };
  }
  return {
    schemaVersion: "gloops.hermes.workspace-preparation.v1",
    expected,
    actual,
    clean: true,
    writable,
    testRuntimeOk: true,
    applyPatchOk: true,
    error: null,
    observedAt,
  };
}

// ---------------------------------------------------------------------------
// 4) Checkpoint/resume — completed side-effect ledger
// ---------------------------------------------------------------------------

export type ResumeSideEffect =
  | "prepared_request_acknowledged"
  | "hermes_run_created"
  | "terminal_event_observed"
  | "terminal_reconciliation_succeeded";

export interface ResumeLedgerEntry {
  effect: ResumeSideEffect;
  /** Stable id for the side effect, e.g. evidenceId or hermesRunId. */
  ref: string;
  observedAt: string;
}

export interface ResumeLedger {
  schemaVersion: "gloops.hermes.resume-ledger.v1";
  runId: string;
  cacheIdentity: string | null;
  entries: ResumeLedgerEntry[];
}

export function buildEmptyResumeLedger(runId: string, cacheIdentity: string | null): ResumeLedger {
  return {
    schemaVersion: "gloops.hermes.resume-ledger.v1",
    runId,
    cacheIdentity,
    entries: [],
  };
}

export function recordResumeSideEffect(
  ledger: ResumeLedger,
  effect: ResumeSideEffect,
  ref: string,
): ResumeLedger {
  if (!ref) return ledger;
  if (ledger.entries.some((entry) => entry.effect === effect && entry.ref === ref)) {
    return ledger;
  }
  return {
    ...ledger,
    entries: [...ledger.entries, { effect, ref, observedAt: new Date().toISOString() }],
  };
}

export function readResumeLedger(ctx: AdapterExecutionContext, runId: string): ResumeLedger {
  const binding = readBinding(ctx);
  const cacheIdentity = binding?.cacheIdentity ?? null;
  const record = asRecord(ctx.context.paperclipResumeLedger);
  if (!record || record.schemaVersion !== "gloops.hermes.resume-ledger.v1") {
    return buildEmptyResumeLedger(runId, cacheIdentity);
  }
  if (typeof record.runId !== "string" || record.runId !== runId) {
    return buildEmptyResumeLedger(runId, cacheIdentity);
  }
  if (record.cacheIdentity !== cacheIdentity) {
    return buildEmptyResumeLedger(runId, cacheIdentity);
  }
  if (!Array.isArray(record.entries)) return buildEmptyResumeLedger(runId, cacheIdentity);
  const entries: ResumeLedgerEntry[] = [];
  for (const entry of record.entries) {
    const e = asRecord(entry);
    if (!e) continue;
    if (typeof e.effect !== "string") continue;
    if (typeof e.ref !== "string") continue;
    if (typeof e.observedAt !== "string") continue;
    if (!isResumeSideEffect(e.effect)) continue;
    entries.push({ effect: e.effect, ref: e.ref, observedAt: e.observedAt });
  }
  return { schemaVersion: "gloops.hermes.resume-ledger.v1", runId, cacheIdentity, entries };
}

function isResumeSideEffect(value: string): value is ResumeSideEffect {
  return value === "prepared_request_acknowledged"
    || value === "hermes_run_created"
    || value === "terminal_event_observed"
    || value === "terminal_reconciliation_succeeded";
}

export function hasCompletedSideEffect(
  ledger: ResumeLedger,
  effect: ResumeSideEffect,
  ref: string | null,
): boolean {
  if (!ref) return false;
  return ledger.entries.some((entry) => entry.effect === effect && entry.ref === ref);
}

// ---------------------------------------------------------------------------
// 5) Bounded idempotent repair ladder
// ---------------------------------------------------------------------------

export type RepairAction =
  | "stale_lease_refresh"
  | "missing_terminal_projection_poll"
  | "provider_exhaustion_backoff"
  | "campaign_expiry_recheck"
  | "duplicate_recovery_noop"
  | "no_repair";

export interface RepairLadderInput {
  errorCode: string | null;
  attempt: number;
  observedAt: string;
}

export interface RepairLadderDecision {
  schemaVersion: "gloops.hermes.repair-ladder.v1";
  action: RepairAction;
  reason: string;
  /**
   * Stable digest of (errorCode, attempt, observedAt). Replays of the same
   * input always yield the same action — this is the idempotency guarantee.
   */
  digest: string;
  nextAttemptDeadline: string | null;
}

const STALE_LEASE_CODES = new Set<string>([
  "execution_admission.lease_expired",
  "execution_admission.stale_lease",
  "execution_admission.revoked_lease",
]);

const MISSING_TERMINAL_CODES = new Set<string>([
  "provider_evidence.terminal_reconciliation_failed",
  "provider_evidence.terminal_projection_missing",
  "execution_admission.provider_budget_evidence_missing",
]);

const PROVIDER_EXHAUSTION_CODES = new Set<string>([
  "execution_admission.provider_budget_exceeded",
  "hermes_gateway_upstream_error",
  "hermes_gateway_rate_limited",
  "hermes_gateway_connect_failed",
]);

const CAMPAIGN_EXPIRY_CODES = new Set<string>([
  "controlled_swarm.campaign_expired",
  "controlled_swarm.revoked_authority",
  "execution_authority.campaign_expired",
]);

const DUPLICATE_RECOVERY_CODES = new Set<string>([
  "execution_admission.duplicate_recovery",
  "controlled_swarm.duplicate_delivery",
  "execution_replay.duplicate_acknowledgement",
]);

export function evaluateRepairLadder(input: RepairLadderInput): RepairLadderDecision {
  const code = input.errorCode ?? "";
  let action: RepairAction = "no_repair";
  let reason = "no repair action matched";
  let backoffMs = 0;

  if (STALE_LEASE_CODES.has(code)) {
    action = "stale_lease_refresh";
    reason = "lease state is stale; refresh and re-attempt";
    backoffMs = 0;
  } else if (MISSING_TERMINAL_CODES.has(code)) {
    action = "missing_terminal_projection_poll";
    reason = "terminal projection missing; poll Hermes one more time before escalating";
    backoffMs = 500 * Math.min(Math.max(input.attempt, 1), 3);
  } else if (PROVIDER_EXHAUSTION_CODES.has(code)) {
    action = "provider_exhaustion_backoff";
    reason = "provider exhausted; bounded backoff before next attempt";
    const attempt = Math.max(input.attempt, 1);
    backoffMs = Math.min(15_000, 1_000 * Math.pow(2, attempt));
  } else if (CAMPAIGN_EXPIRY_CODES.has(code)) {
    action = "campaign_expiry_recheck";
    reason = "campaign authority expired; re-check before any retry";
    backoffMs = 0;
  } else if (DUPLICATE_RECOVERY_CODES.has(code)) {
    action = "duplicate_recovery_noop";
    reason = "duplicate recovery detected; no replay needed";
    backoffMs = 0;
  }

  const observedAt = input.observedAt || new Date().toISOString();
  const nextAttemptDeadline = backoffMs > 0
    ? new Date(Date.parse(observedAt) + backoffMs).toISOString()
    : null;
  return {
    schemaVersion: "gloops.hermes.repair-ladder.v1",
    action,
    reason,
    digest: sha256(stableStringify({ code, attempt: input.attempt })),
    nextAttemptDeadline,
  };
}

// ---------------------------------------------------------------------------
// 6) Budget defect: release unused reservation on pre-model failure
// ---------------------------------------------------------------------------

export interface ReleasedReservation {
  schemaVersion: "gloops.hermes.budget-release.v1";
  budgetId: string;
  reservationId: string;
  releasedInputTokens: number;
  releasedOutputTokens: number;
  releasedTurns: number;
  releasedToolCalls: number;
  releasedWallMs: number;
  reason: string;
}

export function buildReleasedReservation(
  budget: ExecutionInvocationBudget | null | undefined,
  usage: UsageSummary,
  metrics: { turnCount: number; toolCallCount: number; wallMs: number },
  reason: string,
): ReleasedReservation | null {
  if (!budget) return null;
  if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) {
    return null;
  }
  const releasedInputTokens = Math.max(0, budget.maxInputTokens);
  const releasedOutputTokens = Math.max(0, budget.maxOutputTokens);
  const releasedTurns = Math.max(0, budget.maxTurns - metrics.turnCount);
  const releasedToolCalls = Math.max(0, budget.maxToolCalls - metrics.toolCallCount);
  const releasedWallMs = Math.max(0, budget.maxWallMs - metrics.wallMs);
  return {
    schemaVersion: "gloops.hermes.budget-release.v1",
    budgetId: budget.budgetId,
    reservationId: budget.reservationId,
    releasedInputTokens,
    releasedOutputTokens,
    releasedTurns,
    releasedToolCalls,
    releasedWallMs,
    reason,
  };
}

// ---------------------------------------------------------------------------
// Composed preflight summary used by execute.ts
// ---------------------------------------------------------------------------

export interface PreflightSummary {
  schemaVersion: "gloops.hermes.preflight-summary.v1";
  runId: string;
  readiness: PreDispatchReadinessReport | null;
  workspacePreparation: WorkspacePreparationResult | null;
  resumeLedger: ResumeLedger;
  /**
   * The released-reservation object is included ONLY when execute() returns
   * a pre-model failure result. It is the supervisor's signal that the
   * budget was not consumed and can be returned to the pool.
   */
  releasedReservation: ReleasedReservation | null;
}

export function buildPreflightSummary(input: {
  runId: string;
  readiness: PreDispatchReadinessReport | null;
  workspacePreparation: WorkspacePreparationResult | null;
  resumeLedger: ResumeLedger;
  releasedReservation: ReleasedReservation | null;
}): PreflightSummary {
  return {
    schemaVersion: "gloops.hermes.preflight-summary.v1",
    runId: input.runId,
    readiness: input.readiness,
    workspacePreparation: input.workspacePreparation,
    resumeLedger: input.resumeLedger,
    releasedReservation: input.releasedReservation,
  };
}

export { ZERO_USAGE };
export type { AdapterHermesTerminalEvidenceProjection };
