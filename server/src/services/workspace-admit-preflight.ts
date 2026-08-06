/**
 * C1 — Workspace admit preflight.
 *
 * Pure + DB-aware admit gate so product work never wakes into a wrong/stale/dirty
 * lease. Failures return stable reason codes shared by checkout, heartbeat claim,
 * and the board/API surface (C4-ready).
 *
 * Checklist (Track C):
 * - explicit project workspace for implement profiles
 * - repoUrl / cwd / readable path
 * - expected head is full 40-char SHA
 * - HEAD matches expected SHA
 * - clean porcelain (no dirty/untracked)
 * - optional scope-file smoke existence
 * - packet DoR (delegates to issue-packet-readiness)
 *
 * Mode: PAPERCLIP_WORKSPACE_ADMIT=enforce|observe|off (default enforce).
 * Create mode: PAPERCLIP_WORKSPACE_ADMIT_CREATE (defaults to WORKSPACE_ADMIT).
 *
 * START_ONLY_ADMIT_V1 (in runWorkspaceAdmitPreflight): once an issue has
 * legitimately started — in_progress/in_review status, a realized execution
 * workspace, or a bound checkout run — the clean-tree and expected-head
 * checks are skipped, since the agent's own first commit legitimately moves
 * HEAD off the pre-start expected base. See the START_ONLY_ADMIT_V1 markers
 * below for the exact bypass conditions.
 */

import { existsSync, accessSync, constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, projectWorkspaces, type Db } from "@paperclipai/db";
import {
  evaluateIssuePacketReadiness,
  extractMarkdownSection,
  findExactHeadSha,
  ISSUE_PACKET_REASON,
  type IssuePacketReadinessInput,
} from "./issue-packet-readiness.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export const WORKSPACE_ADMIT_ENV = "PAPERCLIP_WORKSPACE_ADMIT";
export const WORKSPACE_ADMIT_CREATE_ENV = "PAPERCLIP_WORKSPACE_ADMIT_CREATE";

export type WorkspaceAdmitMode = "off" | "observe" | "enforce";

export const WORKSPACE_ADMIT_REASON = {
  MISSING_PROJECT_WORKSPACE: "workspace_admit.missing_project_workspace",
  WORKSPACE_NOT_FOUND: "workspace_admit.workspace_not_found",
  CWD_MISSING: "workspace_admit.cwd_missing",
  CWD_NOT_GIT: "workspace_admit.cwd_not_git",
  CWD_NOT_READABLE: "workspace_admit.cwd_not_readable",
  EXPECTED_HEAD_NOT_FULL_SHA: "workspace_admit.expected_head_not_full_sha",
  HEAD_MISMATCH: "workspace_admit.head_mismatch",
  DIRTY_TREE: "workspace_admit.dirty_tree",
  SCOPE_PATH_MISSING: "workspace_admit.scope_path_missing",
  PACKET_NOT_READY: ISSUE_PACKET_REASON.NOT_READY,
  CROSS_REPO_INHERITANCE_BLOCKED: "workspace_admit.cross_repo_inheritance_blocked",
  MISSING_EXPLICIT_WORKSPACE: "workspace_admit.missing_explicit_workspace",
  MISSING_BASE_REF_SHA: "workspace_admit.missing_base_ref_sha",
  NOT_READY: "workspace_admit.not_ready",
  OK: "workspace_admit.ok",
} as const;

export type WorkspaceAdmitReasonCode =
  (typeof WORKSPACE_ADMIT_REASON)[keyof typeof WORKSPACE_ADMIT_REASON];

export type WorkspaceAdmitCheck = {
  id: string;
  ok: boolean;
  reasonCode?: WorkspaceAdmitReasonCode;
  detail?: string;
};

export type WorkspaceAdmitPreflightResult = {
  admitted: boolean;
  checks: WorkspaceAdmitCheck[];
  reasonCodes: WorkspaceAdmitReasonCode[];
  expectedHeadSha: string | null;
  observedHeadSha: string | null;
  projectWorkspaceId: string | null;
  cwd: string | null;
  repoUrl: string | null;
  details: string;
};

export type WorkspaceAdmitIssueFields = {
  id?: string | null;
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  status?: string | null;
  projectWorkspaceId?: string | null;
  executionWorkspaceId?: string | null;
  projectId?: string | null;
  parentId?: string | null;
  /** START_ONLY_ADMIT_V1: bound checkout run id, when the caller has one. */
  checkoutRunId?: string | null;
};

export type WorkspaceAdmitAssigneeFields = {
  role?: string | null;
  name?: string | null;
};

/** Force profile resolution even when packet DoR env is off (vitest default). */
const FORCE_PACKET_PROFILE_ENV = { PAPERCLIP_ISSUE_PACKET_DOR: "enforce" } as const;

/**
 * Read PAPERCLIP_WORKSPACE_ADMIT.
 * - Production default: enforce (hard product gate).
 * - Vitest default when unset: off (legacy fixtures lack workspace leases).
 * - Explicit env always wins. Unknown values fall back to enforce.
 */
export function getWorkspaceAdmitMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WorkspaceAdmitMode {
  const raw = env[WORKSPACE_ADMIT_ENV];
  if (raw === undefined || raw.trim() === "") {
    const vitest = String(env.VITEST ?? "").trim().toLowerCase();
    const nodeEnv = String(env.NODE_ENV ?? "").trim().toLowerCase();
    if (vitest === "true" || nodeEnv === "test") {
      return "off";
    }
    return "enforce";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "observe" || normalized === "enforce") {
    return normalized;
  }
  return "enforce";
}

/**
 * Create-time gate mode. PAPERCLIP_WORKSPACE_ADMIT_CREATE overrides;
 * otherwise mirrors PAPERCLIP_WORKSPACE_ADMIT / same defaults.
 */
export function getWorkspaceAdmitCreateMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): WorkspaceAdmitMode {
  const raw = env[WORKSPACE_ADMIT_CREATE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return getWorkspaceAdmitMode(env);
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "off" || normalized === "observe" || normalized === "enforce") {
    return normalized;
  }
  return "enforce";
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function isFullSha(value: string | null | undefined): value is string {
  return typeof value === "string" && FULL_SHA_RE.test(value.trim());
}

function normalizeSha(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return FULL_SHA_RE.test(trimmed) ? trimmed : null;
}

function normalizeRepoUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\.git$/i, "").toLowerCase();
}

function reposMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/** Extract paths that look like repo-relative allowlist lines from Scope. */
export function extractScopePathHints(description: string | null | undefined): string[] {
  if (!description) return [];
  const scopeBody = extractMarkdownSection(description, "Scope");
  const body = scopeBody ?? description;
  const paths = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const cleaned = line.replace(/^[\s>*\-•]+/, "").trim();
    // backticks or bare path-like tokens under artifacts/ or src/
    for (const m of cleaned.matchAll(/`([^`]+)`/g)) {
      const p = m[1]?.trim();
      if (p && (p.includes("/") || p.endsWith(".tsx") || p.endsWith(".ts"))) {
        // strip globs for existence smoke
        const plain = p.replace(/\*\*.*$/, "").replace(/\*$/, "").replace(/\/$/, "");
        if (plain.length >= 4) paths.add(plain);
      }
    }
  }
  return [...paths].slice(0, 40);
}

function pathExistsUnder(root: string, rel: string): boolean {
  try {
    const full = path.resolve(root, rel);
    if (!full.startsWith(path.resolve(root))) return false;
    return existsSync(full);
  } catch {
    return false;
  }
}

/**
 * Pure filesystem/git checks against a resolved workspace path + expected SHA.
 * Safe to unit-test without DB.
 */
export function evaluateWorkspaceAdmitFilesystem(input: {
  cwd: string | null;
  expectedHeadSha: string | null;
  scopePathHints?: string[];
  requireCleanTree?: boolean;
  requireExpectedHead?: boolean;
}): { checks: WorkspaceAdmitCheck[]; observedHeadSha: string | null } {
  const checks: WorkspaceAdmitCheck[] = [];
  const requireClean = input.requireCleanTree !== false;
  const requireHead = input.requireExpectedHead !== false;
  let observedHeadSha: string | null = null;

  if (!input.cwd) {
    checks.push({
      id: "cwd",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.CWD_MISSING,
      detail: "No workspace cwd resolved",
    });
    return { checks, observedHeadSha };
  }

  if (!existsSync(input.cwd)) {
    checks.push({
      id: "cwd",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.CWD_MISSING,
      detail: `cwd does not exist: ${input.cwd}`,
    });
    return { checks, observedHeadSha };
  }

  try {
    accessSync(input.cwd, fsConstants.R_OK);
    checks.push({ id: "cwd_readable", ok: true });
  } catch {
    checks.push({
      id: "cwd_readable",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.CWD_NOT_READABLE,
      detail: `cwd not readable by process uid: ${input.cwd}`,
    });
  }

  const gitDir = runGit(["rev-parse", "--is-inside-work-tree"], input.cwd);
  if (!gitDir.ok || gitDir.stdout !== "true") {
    checks.push({
      id: "git",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.CWD_NOT_GIT,
      detail: `cwd is not a git worktree: ${input.cwd}`,
    });
    return { checks, observedHeadSha };
  }
  checks.push({ id: "git", ok: true });

  const head = runGit(["rev-parse", "HEAD"], input.cwd);
  observedHeadSha = normalizeSha(head.stdout);
  if (!observedHeadSha) {
    checks.push({
      id: "head",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.EXPECTED_HEAD_NOT_FULL_SHA,
      detail: `could not read full HEAD SHA from ${input.cwd}`,
    });
  } else {
    checks.push({ id: "head", ok: true, detail: observedHeadSha });
  }

  if (requireHead) {
    if (!isFullSha(input.expectedHeadSha)) {
      checks.push({
        id: "expected_head",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.EXPECTED_HEAD_NOT_FULL_SHA,
        detail: `expected head must be full 40-char SHA; received ${input.expectedHeadSha ?? "(null)"}`,
      });
    } else if (observedHeadSha && observedHeadSha !== input.expectedHeadSha!.toLowerCase()) {
      checks.push({
        id: "expected_head",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.HEAD_MISMATCH,
        detail: `HEAD ${observedHeadSha} != expected ${input.expectedHeadSha!.toLowerCase()}`,
      });
    } else if (observedHeadSha) {
      checks.push({ id: "expected_head", ok: true });
    }
  }

  if (requireClean) {
    const status = runGit(["status", "--porcelain=v1", "--untracked-files=all"], input.cwd);
    const dirty = status.ok && status.stdout.length > 0;
    if (dirty) {
      const lines = status.stdout.split(/\r?\n/).filter(Boolean).slice(0, 8);
      checks.push({
        id: "clean_tree",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.DIRTY_TREE,
        detail: `Workspace contains uncommitted or untracked changes. Sample: ${lines.join(" | ")}`,
      });
    } else if (status.ok) {
      checks.push({ id: "clean_tree", ok: true });
    } else {
      checks.push({
        id: "clean_tree",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.DIRTY_TREE,
        detail: `could not read git status: ${status.stderr || "unknown"}`,
      });
    }
  }

  const hints = input.scopePathHints ?? [];
  if (hints.length > 0 && existsSync(input.cwd)) {
    const missing = hints.filter((h) => !pathExistsUnder(input.cwd!, h));
    // Only fail if majority of concrete file paths missing (avoid false fail on optional dirs)
    const fileHints = hints.filter((h) => /\.(ts|tsx|js|jsx|md|html|css)$/i.test(h));
    const missingFiles = fileHints.filter((h) => !pathExistsUnder(input.cwd!, h));
    if (fileHints.length > 0 && missingFiles.length === fileHints.length) {
      checks.push({
        id: "scope_paths",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.SCOPE_PATH_MISSING,
        detail: `none of the Scope file paths exist on this head: ${missingFiles.slice(0, 5).join(", ")}`,
      });
    } else if (missingFiles.length > 0 && missingFiles.length >= Math.ceil(fileHints.length * 0.75)) {
      checks.push({
        id: "scope_paths",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.SCOPE_PATH_MISSING,
        detail: `most Scope file paths missing (${missingFiles.length}/${fileHints.length}): ${missingFiles.slice(0, 5).join(", ")}`,
      });
    } else {
      checks.push({
        id: "scope_paths",
        ok: true,
        detail: missing.length
          ? `optional missing: ${missing.slice(0, 3).join(", ")}`
          : "scope path smoke ok",
      });
    }
  }

  return { checks, observedHeadSha };
}

/**
 * START_ONLY_ADMIT_V1: once an issue has legitimately moved past "not yet
 * started" — status is in_progress/in_review, an execution workspace has
 * been realized, or a checkout run is bound — the worktree HEAD legitimately
 * diverges from the pre-start expected base (the agent's own first commit
 * moves it), and the tree legitimately carries that commit's changes before
 * the next wake observes it as clean. Without this, re-admit after that
 * commit spuriously fails with workspace_admit.head_mismatch / dirty_tree.
 *
 * Skips only the clean-tree and expected-head checks in that case; every
 * other check (cwd, git, scope paths, packet DoR) still applies
 * unconditionally, and a genuinely dirty or wrong-base tree at the
 * *pre-start* state (status not yet in_progress/in_review, no realized
 * workspace, no checkout run) is still rejected — this only widens *when*
 * the checks run, never *what* they accept.
 *
 * Pure by design so it is unit-testable without a DB (mirrors
 * evaluateWorkspaceAdmitFilesystem / shouldInheritProjectWorkspace above).
 */
export function resolveStartOnlyAdmitRequirements(
  issue: Pick<WorkspaceAdmitIssueFields, "status" | "executionWorkspaceId" | "checkoutRunId">,
  base: {
    /** When true, skip dirty-tree check (observe-only repair). Default enforce clean. */
    allowDirty?: boolean;
    /** When false, skip HEAD==expected (not recommended). Default true for implement. */
    requireExpectedHead?: boolean;
  } = {},
): { requireCleanTree: boolean; requireExpectedHead: boolean } {
  const status = String(issue.status || "").toLowerCase();
  const workspaceRealized = Boolean(issue.executionWorkspaceId);
  const inProgress = status === "in_progress";
  const inReview = status === "in_review";
  const hasCheckoutRun = Boolean(issue.checkoutRunId);

  return {
    requireCleanTree: !base.allowDirty && !(inProgress || workspaceRealized),
    requireExpectedHead:
      base.requireExpectedHead !== false &&
      !(inProgress || inReview || workspaceRealized || hasCheckoutRun),
  };
}

export function resolveExpectedHeadFromIssueAndWorkspace(input: {
  description?: string | null;
  workspaceRepoRef?: string | null;
  workspaceDefaultRef?: string | null;
  executionBaseRef?: string | null;
}): string | null {
  const fromDesc = findExactHeadSha(input.description ?? null);
  if (fromDesc) return fromDesc;
  for (const candidate of [input.executionBaseRef, input.workspaceRepoRef, input.workspaceDefaultRef]) {
    const sha = normalizeSha(candidate);
    if (sha) return sha;
  }
  // Reject branch names like "main"
  return null;
}

/**
 * Whether an implement-profile issue must pass full workspace admit (C1/C2).
 * Profile resolution always uses force-enforce so vitest packet-DoR=off does not
 * collapse implement packets into "exempt".
 */
export function issueRequiresWorkspaceAdmit(
  packetInput: IssuePacketReadinessInput,
): boolean {
  const readiness = evaluateIssuePacketReadiness(packetInput, FORCE_PACKET_PROFILE_ENV);
  return (
    readiness.profile === "standard_implement" ||
    readiness.profile === "standard_review" ||
    readiness.profile === "standard_release"
  );
}

/** Primary stable error code for runs / comments (C4). */
export function primaryWorkspaceAdmitErrorCode(
  result: Pick<WorkspaceAdmitPreflightResult, "reasonCodes">,
): string {
  return result.reasonCodes[0] ?? WORKSPACE_ADMIT_REASON.NOT_READY;
}

export async function runWorkspaceAdmitPreflight(
  db: Db,
  input: {
    companyId: string;
    issue: WorkspaceAdmitIssueFields;
    assignee?: WorkspaceAdmitAssigneeFields | null;
    /** When true, skip dirty-tree check (observe-only repair). Default enforce clean. */
    allowDirty?: boolean;
    /** When false, skip HEAD==expected (not recommended). Default true for implement. */
    requireExpectedHead?: boolean;
  },
): Promise<WorkspaceAdmitPreflightResult> {
  const checks: WorkspaceAdmitCheck[] = [];
  const packetInput: IssuePacketReadinessInput = {
    title: input.issue.title ?? null,
    description: input.issue.description ?? null,
    workMode: input.issue.workMode ?? null,
    status: input.issue.status ?? null,
    assigneeRole: input.assignee?.role ?? null,
    assigneeName: input.assignee?.name ?? null,
    repositoryBacked: Boolean(input.issue.projectWorkspaceId || input.issue.executionWorkspaceId),
  };
  const packet = evaluateIssuePacketReadiness(packetInput);
  if (packet.mode === "enforce" && !packet.ready) {
    checks.push({
      id: "packet_dor",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.PACKET_NOT_READY,
      detail: packet.details,
    });
  } else {
    checks.push({ id: "packet_dor", ok: true, detail: `profile=${packet.profile}` });
  }

  const requiresWorkspace = issueRequiresWorkspaceAdmit(packetInput);
  let projectWorkspaceId = input.issue.projectWorkspaceId ?? null;
  let cwd: string | null = null;
  let repoUrl: string | null = null;
  let workspaceRepoRef: string | null = null;
  let workspaceDefaultRef: string | null = null;

  if (requiresWorkspace && !projectWorkspaceId && !input.issue.executionWorkspaceId) {
    checks.push({
      id: "project_workspace",
      ok: false,
      reasonCode: WORKSPACE_ADMIT_REASON.MISSING_PROJECT_WORKSPACE,
      detail:
        "Implement issues require an explicit projectWorkspaceId (do not rely on parent inheritance across repos)",
    });
  }

  if (projectWorkspaceId) {
    const pws = await db
      .select()
      .from(projectWorkspaces)
      .where(
        and(eq(projectWorkspaces.id, projectWorkspaceId), eq(projectWorkspaces.companyId, input.companyId)),
      )
      .then((rows) => rows[0] ?? null);
    if (!pws) {
      checks.push({
        id: "project_workspace",
        ok: false,
        reasonCode: WORKSPACE_ADMIT_REASON.WORKSPACE_NOT_FOUND,
        detail: `projectWorkspaceId not found: ${projectWorkspaceId}`,
      });
    } else {
      checks.push({ id: "project_workspace", ok: true });
      cwd = pws.cwd ?? null;
      repoUrl = pws.repoUrl ?? null;
      workspaceRepoRef = pws.repoRef ?? null;
      workspaceDefaultRef = pws.defaultRef ?? null;
    }
  }

  // Prefer realized execution workspace cwd when present
  if (input.issue.executionWorkspaceId) {
    const ews = await db
      .select()
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.id, input.issue.executionWorkspaceId),
          eq(executionWorkspaces.companyId, input.companyId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (ews) {
      cwd = ews.cwd ?? ews.providerRef ?? cwd;
      if (ews.repoUrl) repoUrl = ews.repoUrl;
      if (ews.baseRef && isFullSha(ews.baseRef)) {
        workspaceRepoRef = ews.baseRef;
      }
    }
  }

  const expectedHeadSha = resolveExpectedHeadFromIssueAndWorkspace({
    description: input.issue.description,
    workspaceRepoRef,
    workspaceDefaultRef,
  });

  const startOnlyAdmit = resolveStartOnlyAdmitRequirements(input.issue, {
    allowDirty: input.allowDirty,
    requireExpectedHead: input.requireExpectedHead,
  });

  const fsResult = requiresWorkspace
    ? evaluateWorkspaceAdmitFilesystem({
        cwd,
        expectedHeadSha,
        scopePathHints: extractScopePathHints(input.issue.description),
        requireCleanTree: startOnlyAdmit.requireCleanTree,
        requireExpectedHead: startOnlyAdmit.requireExpectedHead,
      })
    : { checks: [] as WorkspaceAdmitCheck[], observedHeadSha: null as string | null };

  checks.push(...fsResult.checks);

  const failed = checks.filter((c) => !c.ok);
  const reasonCodes = failed
    .map((c) => c.reasonCode)
    .filter((c): c is WorkspaceAdmitReasonCode => Boolean(c));

  const details =
    failed.length === 0
      ? "Workspace admit preflight passed."
      : failed.map((c) => `${c.id}: ${c.detail ?? c.reasonCode}`).join("; ");

  return {
    admitted: failed.length === 0,
    checks,
    reasonCodes,
    expectedHeadSha,
    observedHeadSha: fsResult.observedHeadSha,
    projectWorkspaceId,
    cwd,
    repoUrl,
    details,
  };
}

/**
 * C3 helper: whether inheriting source.projectWorkspaceId onto a child/create
 * is safe. Fail-closed product rule — never auto-inherit across projects or
 * unknown/mismatched repos.
 */
export function shouldInheritProjectWorkspace(input: {
  sourceRepoUrl?: string | null | undefined;
  explicitProjectWorkspaceId?: string | null | undefined;
  sourceProjectWorkspaceId?: string | null | undefined;
  /** Caller already knows parent and child share projectId. */
  sameProjectId?: boolean;
  intendedRepoUrl?: string | null | undefined;
}): boolean {
  if (input.explicitProjectWorkspaceId) return false; // caller sets explicit
  if (!input.sourceProjectWorkspaceId) return false;
  // Hard block across projects (the paperclip-gym → gloops-ui thrash path).
  if (input.sameProjectId === false) return false;

  const sourceRepo = normalizeRepoUrl(input.sourceRepoUrl);
  const intended = normalizeRepoUrl(input.intendedRepoUrl);
  if (intended && sourceRepo && !reposMatch(intended, sourceRepo)) {
    return false;
  }

  // Same project: allow inherit (project default PWS is still preferred upstream).
  if (input.sameProjectId === true) return true;

  // Unknown sameProjectId: only inherit when both repo URLs are known and match.
  if (sourceRepo && intended && reposMatch(sourceRepo, intended)) return true;

  // Fail-closed when we cannot prove same-repo / same-project.
  return false;
}

/**
 * C3: block inheritance when source and intended workspace repoUrls differ.
 */
export async function resolveProjectWorkspaceInheritance(
  db: Db,
  input: {
    companyId: string;
    explicitProjectWorkspaceId?: string | null;
    sourceIssueProjectWorkspaceId?: string | null;
    /** Optional intended repo URL from packet (best-effort). */
    intendedRepoUrl?: string | null;
    sameProjectId?: boolean;
  },
): Promise<{ projectWorkspaceId: string | null; blockedCrossRepo: boolean; detail?: string }> {
  if (input.explicitProjectWorkspaceId) {
    return { projectWorkspaceId: input.explicitProjectWorkspaceId, blockedCrossRepo: false };
  }
  const sourceId = input.sourceIssueProjectWorkspaceId ?? null;
  if (!sourceId) return { projectWorkspaceId: null, blockedCrossRepo: false };

  if (input.sameProjectId === false) {
    return {
      projectWorkspaceId: null,
      blockedCrossRepo: true,
      detail:
        "Refusing to inherit projectWorkspaceId across projects. Supply explicit projectWorkspaceId.",
    };
  }

  const source = await db
    .select()
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.id, sourceId), eq(projectWorkspaces.companyId, input.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!source) return { projectWorkspaceId: null, blockedCrossRepo: false };

  const sourceRepo = normalizeRepoUrl(source.repoUrl);
  const intended = normalizeRepoUrl(input.intendedRepoUrl);
  if (intended && sourceRepo && !reposMatch(intended, sourceRepo)) {
    return {
      projectWorkspaceId: null,
      blockedCrossRepo: true,
      detail: `Refusing to inherit projectWorkspaceId across repos (source=${source.repoUrl}, intended=${input.intendedRepoUrl}). Supply explicit projectWorkspaceId.`,
    };
  }

  // Fail-closed without same-project certainty when intended repo is unknown.
  if (input.sameProjectId !== true && !intended) {
    return {
      projectWorkspaceId: null,
      blockedCrossRepo: true,
      detail:
        "Refusing to auto-inherit projectWorkspaceId without same-project proof or intended repo. Supply explicit projectWorkspaceId.",
    };
  }

  if (
    !shouldInheritProjectWorkspace({
      sourceRepoUrl: source.repoUrl,
      sourceProjectWorkspaceId: sourceId,
      sameProjectId: input.sameProjectId,
      intendedRepoUrl: input.intendedRepoUrl,
    })
  ) {
    return {
      projectWorkspaceId: null,
      blockedCrossRepo: true,
      detail: "Refusing to inherit projectWorkspaceId (C3 fail-closed).",
    };
  }

  return { projectWorkspaceId: sourceId, blockedCrossRepo: false };
}

/**
 * C2 pure create-time checks (no DB). Callers supply whether workspace ids were
 * explicitly provided and any full SHA available from description / PWS refs.
 */
export function evaluateWorkspaceAdmitCreateRequirements(input: {
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  status?: string | null;
  assigneeRole?: string | null;
  assigneeName?: string | null;
  /** True only when caller set projectWorkspaceId on the create payload. */
  explicitProjectWorkspaceId: boolean;
  /** True only when caller set executionWorkspaceId on the create payload. */
  explicitExecutionWorkspaceId: boolean;
  /** Full 40-char SHA from description Exact head OR assigned PWS repoRef/defaultRef. */
  resolvedBaseRefSha?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): {
  mode: WorkspaceAdmitMode;
  required: boolean;
  ok: boolean;
  reasonCodes: WorkspaceAdmitReasonCode[];
  details: string;
} {
  const mode = getWorkspaceAdmitCreateMode(input.env);
  const packetInput: IssuePacketReadinessInput = {
    title: input.title ?? null,
    description: input.description ?? null,
    workMode: input.workMode ?? null,
    status: input.status ?? null,
    assigneeRole: input.assigneeRole ?? null,
    assigneeName: input.assigneeName ?? null,
    repositoryBacked: input.explicitProjectWorkspaceId || input.explicitExecutionWorkspaceId,
  };
  const required = issueRequiresWorkspaceAdmit(packetInput);
  if (!required || mode === "off") {
    return { mode, required: false, ok: true, reasonCodes: [], details: "Workspace admit create gate not required." };
  }

  const reasonCodes: WorkspaceAdmitReasonCode[] = [];
  if (!input.explicitProjectWorkspaceId && !input.explicitExecutionWorkspaceId) {
    reasonCodes.push(WORKSPACE_ADMIT_REASON.MISSING_EXPLICIT_WORKSPACE);
  }
  const baseSha =
    normalizeSha(input.resolvedBaseRefSha) ?? findExactHeadSha(input.description ?? null);
  if (!baseSha) {
    reasonCodes.push(WORKSPACE_ADMIT_REASON.MISSING_BASE_REF_SHA);
  }

  const structurallyOk = reasonCodes.length === 0;
  const ok = mode === "observe" ? true : structurallyOk;
  const details = structurallyOk
    ? "Workspace admit create requirements satisfied."
    : `Implement create requires explicit projectWorkspaceId or executionWorkspaceId and a 40-char baseRef SHA. Missing: ${reasonCodes.join(", ")}`;

  return { mode, required: true, ok, reasonCodes, details };
}

/** Format for system comments — always include stable error codes (C4). */
export function formatWorkspaceAdmitFailureComment(result: WorkspaceAdmitPreflightResult): string {
  const primary = primaryWorkspaceAdmitErrorCode(result);
  const allCodes = result.reasonCodes.length
    ? result.reasonCodes.join(", ")
    : WORKSPACE_ADMIT_REASON.NOT_READY;
  return [
    "Paperclip blocked execution at **workspace admit preflight** (C1).",
    "",
    `- errorCode: \`${primary}\``,
    `- reasonCodes: ${allCodes}`,
    `- expectedHead: \`${result.expectedHeadSha ?? "null"}\``,
    `- observedHead: \`${result.observedHeadSha ?? "null"}\``,
    `- projectWorkspaceId: \`${result.projectWorkspaceId ?? "null"}\``,
    `- cwd: \`${result.cwd ?? "null"}\``,
    `- repoUrl: \`${result.repoUrl ?? "null"}\``,
    "",
    result.details,
    "",
    "Fix the lease (workspace/SHA/clean tree/packet) before re-waking. Do not thrash wakeup.",
  ].join("\n");
}
