/**
 * Board-authorized Induct work-item intake.
 *
 * This is deliberately narrower than general issue creation: it selects only a
 * configured, already-managed Induct project workspace, proves that it belongs
 * to the requested project and repository, and probes the container-visible
 * lease before the caller can emit an issue/assignment wakeup.
 */
import {
  DEFAULT_INDUCT_PROJECT_WORKSPACE_ID,
  getInductProjectWorkspaceIds,
} from "./sdlc-preflight.js";
import { evaluateWorkspaceAdmitFilesystem } from "./workspace-admit-preflight.js";
import { findDeclaredExactHeadShas } from "./issue-packet-readiness.js";

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export const AUTHORIZED_INDUCT_INTAKE_REASON = {
  UNAUTHORIZED: "induct_intake.unauthorized",
  INVALID_TARGET: "induct_intake.invalid_target",
  PROJECT_WORKSPACE_NOT_FOUND: "induct_intake.project_workspace_not_found",
  PROJECT_WORKSPACE_MISMATCH: "induct_intake.project_workspace_mismatch",
  REPOSITORY_MISMATCH: "induct_intake.repository_mismatch",
  EXACT_HEAD_MISMATCH: "induct_intake.exact_head_mismatch",
  LEASE_NOT_ADMITTED: "induct_intake.lease_not_admitted",
} as const;

export type AuthorizedInductIntakeReason =
  (typeof AUTHORIZED_INDUCT_INTAKE_REASON)[keyof typeof AUTHORIZED_INDUCT_INTAKE_REASON];

export type ManagedProjectWorkspaceCandidate = {
  id: string;
  companyId: string;
  projectId: string;
  name?: string | null;
  cwd?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  defaultRef?: string | null;
};

export type AuthorizedInductIntakeResult = {
  ok: boolean;
  reasonCodes: AuthorizedInductIntakeReason[];
  details: string;
  workspace: ManagedProjectWorkspaceCandidate | null;
  exactHeadSha: string | null;
};

function normalizeRepo(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
}

export function isInductRepository(value: string | null | undefined): boolean {
  const repo = normalizeRepo(value);
  return repo === "inductai/induct" || repo === "https://github.com/inductai/induct";
}

function exactHead(workspace: ManagedProjectWorkspaceCandidate): string | null {
  for (const candidate of [workspace.repoRef, workspace.defaultRef]) {
    const normalized = candidate?.trim().toLowerCase() ?? "";
    if (FULL_SHA_RE.test(normalized)) return normalized;
  }
  return null;
}

/**
 * Select and probe a managed Induct lease without touching the network or DB.
 * The route supplies only company-scoped workspace rows, making tenant checks
 * explicit at the boundary and keeping this harness deterministic.
 */
export function evaluateAuthorizedInductWorkItemIntake(input: {
  boardAuthorized: boolean;
  companyId: string;
  projectId: string | null | undefined;
  requestedRepoUrl: string | null | undefined;
  description?: string | null;
  workspaceCandidates: ManagedProjectWorkspaceCandidate[];
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): AuthorizedInductIntakeResult {
  if (!input.boardAuthorized) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.UNAUTHORIZED],
      details: "Only a board-authorized actor may use Induct work-item intake.",
      workspace: null,
      exactHeadSha: null,
    };
  }
  if (!input.projectId || !isInductRepository(input.requestedRepoUrl)) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.INVALID_TARGET],
      details: "Induct intake requires a projectId and the canonical InductAI/induct repository.",
      workspace: null,
      exactHeadSha: null,
    };
  }

  const managedIds = getInductProjectWorkspaceIds(input.env);
  const managedCandidates = input.workspaceCandidates.filter(
    (candidate) => candidate.companyId === input.companyId && managedIds.has(candidate.id.toLowerCase()),
  );
  if (managedCandidates.length === 0) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.PROJECT_WORKSPACE_NOT_FOUND],
      details: `No configured managed Induct workspace was found (default ${DEFAULT_INDUCT_PROJECT_WORKSPACE_ID}).`,
      workspace: null,
      exactHeadSha: null,
    };
  }
  const workspace =
    managedCandidates.find((candidate) => candidate.projectId === input.projectId) ?? null;
  if (!workspace) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.PROJECT_WORKSPACE_MISMATCH],
      details: "The managed Induct workspace does not belong to the requested project.",
      workspace: managedCandidates[0] ?? null,
      exactHeadSha: null,
    };
  }
  if (!isInductRepository(workspace.repoUrl)) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.REPOSITORY_MISMATCH],
      details: "The configured managed Induct workspace has a non-Induct repository namespace.",
      workspace,
      exactHeadSha: null,
    };
  }

  const head = exactHead(workspace);
  const probe = evaluateWorkspaceAdmitFilesystem({
    cwd: workspace.cwd ?? null,
    expectedHeadSha: head,
    requireCleanTree: true,
    requireExpectedHead: true,
  });
  const failures = probe.checks.filter((check) => !check.ok);
  if (failures.length > 0) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.LEASE_NOT_ADMITTED],
      details: failures.map((check) => `${check.id}: ${check.detail ?? check.reasonCode}`).join("; "),
      workspace,
      exactHeadSha: head,
    };
  }
  const conflictingHeads = findDeclaredExactHeadShas(input.description).filter(
    (declaredHead) => declaredHead !== head,
  );
  if (conflictingHeads.length > 0) {
    return {
      ok: false,
      reasonCodes: [AUTHORIZED_INDUCT_INTAKE_REASON.EXACT_HEAD_MISMATCH],
      details: `Declared exact head ${conflictingHeads.join(", ")} does not match admitted lease head ${head}.`,
      workspace,
      exactHeadSha: head,
    };
  }
  return {
    ok: true,
    reasonCodes: [],
    details: "Managed Induct lease is admitted for authorized work-item intake.",
    workspace,
    exactHeadSha: head,
  };
}

export function appendExactHeadToIntakeDescription(
  description: string | null | undefined,
  exactHeadSha: string,
): string {
  if (new RegExp("Exact\\s+head\\s*:\\s*`?" + exactHeadSha + "`?", "i").test(description ?? "")) {
    return description ?? "";
  }
  return `${(description ?? "").trimEnd()}\n\n## Exact Head\nExact head: \`${exactHeadSha}\`\n`;
}
