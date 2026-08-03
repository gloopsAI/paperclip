/**
 * Dispatch hard assignment policy (P2).
 *
 * Soft optimize lives in Dispatch agent instructions. This module is the
 * platform belt: when the actor is a Dispatch-class agent, enforce allowlisted
 * assignees + implement packet shape so thrash cannot ignore prompts.
 *
 * Mode: PAPERCLIP_DISPATCH_ASSIGN_POLICY=enforce|observe|off
 * - enforce (default outside tests): deny with stable error codes
 * - observe: allow but return would-deny codes for logging
 * - off: no-op
 */

const FULL_SHA_RE = /\b[0-9a-f]{40}\b/i;
const EXACT_HEAD_LINE_RE =
  /(?:^|\n)\s*(?:exact\s*head|head\s*sha|headsha|base\s*sha|commit\s*sha)\s*[:=]?\s*`?([0-9a-f]{40})`?/i;

export const DISPATCH_ASSIGN_ENV = "PAPERCLIP_DISPATCH_ASSIGN_POLICY";

export const DISPATCH_ASSIGN_REASON = {
  ASSIGNEE_NOT_ALLOWLISTED: "dispatch.assignee_not_allowlisted",
  MISSING_PROJECT_WORKSPACE: "dispatch.missing_project_workspace",
  MISSING_EXACT_HEAD: "dispatch.missing_exact_head",
  THRASH_COOLDOWN: "dispatch.thrash_cooldown",
  ISSUE_UNBOUND_WAKE: "dispatch.issue_unbound_wake",
  OK: "dispatch.ok",
} as const;

export type DispatchAssignReasonCode =
  (typeof DISPATCH_ASSIGN_REASON)[keyof typeof DISPATCH_ASSIGN_REASON];

export type DispatchAssignMode = "off" | "observe" | "enforce";

export type DispatchAssignDecision = {
  allowed: boolean;
  mode: DispatchAssignMode;
  reasonCodes: DispatchAssignReasonCode[];
  details: string;
  actorIsDispatch: boolean;
};

/** Default live agent names for Gloops company; overridable via env UUID lists. */
export const DEFAULT_DISPATCH_NAMES = new Set(["dispatch"]);
export const DEFAULT_IMPLEMENT_NAMES = new Set(["wren", "mason"]);
export const DEFAULT_REVIEW_NAMES = new Set(["argus"]);

export function getDispatchAssignMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): DispatchAssignMode {
  const raw = env[DISPATCH_ASSIGN_ENV];
  if (raw === undefined || raw.trim() === "") {
    const vitest = String(env.VITEST ?? "").trim().toLowerCase();
    const nodeEnv = String(env.NODE_ENV ?? "").trim().toLowerCase();
    if (vitest === "true" || nodeEnv === "test") return "off";
    return "enforce";
  }
  const n = raw.trim().toLowerCase();
  if (n === "off" || n === "observe" || n === "enforce") return n;
  return "enforce";
}

function parseIdList(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseNameList(raw: string | undefined, fallback: Set<string>): Set<string> {
  if (!raw?.trim()) return fallback;
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDispatchActor(input: {
  actorType?: string | null;
  actorAgentId?: string | null;
  actorAgentName?: string | null;
  actorAgentRole?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): boolean {
  if (input.actorType !== "agent") return false;
  const env = input.env ?? process.env;
  const idAllow = parseIdList(env.PAPERCLIP_DISPATCH_AGENT_IDS);
  if (input.actorAgentId && idAllow.has(input.actorAgentId.toLowerCase())) return true;
  const names = parseNameList(env.PAPERCLIP_DISPATCH_AGENT_NAMES, DEFAULT_DISPATCH_NAMES);
  const name = (input.actorAgentName ?? "").trim().toLowerCase();
  if (name && names.has(name)) return true;
  // role=pm alone is NOT enough (Northstar is also pm)
  return false;
}

export function findExactHeadSha(description: string | null | undefined): string | null {
  if (!description) return null;
  const line = description.match(EXACT_HEAD_LINE_RE);
  if (line?.[1]) return line[1].toLowerCase();
  const any = description.match(FULL_SHA_RE);
  return any ? any[0].toLowerCase() : null;
}

function looksImplement(input: {
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  assigneeRole?: string | null;
}): boolean {
  const role = (input.assigneeRole ?? "").toLowerCase();
  if (role === "qa" || role === "devops") return false;
  if (role === "engineer") return true;
  const text = `${input.title ?? ""}\n${input.description ?? ""}`.toLowerCase();
  if (/\breview\b/.test(text) && !/\bimplement\b/.test(text)) return false;
  return Boolean(input.description && /##\s*scope/i.test(input.description));
}

function looksReview(input: { title?: string | null; description?: string | null; assigneeRole?: string | null }): boolean {
  const role = (input.assigneeRole ?? "").toLowerCase();
  if (role === "qa") return true;
  const text = `${input.title ?? ""}\n${input.description ?? ""}`.toLowerCase();
  return /\breview\b/.test(text) || /implementation\s+review/i.test(text);
}

/**
 * Pure evaluator for Dispatch-driven assignee changes.
 */
export function evaluateDispatchAssignment(input: {
  actorType?: string | null;
  actorAgentId?: string | null;
  actorAgentName?: string | null;
  actorAgentRole?: string | null;
  assigneeAgentId?: string | null;
  assigneeAgentName?: string | null;
  assigneeAgentRole?: string | null;
  issueTitle?: string | null;
  issueDescription?: string | null;
  issueWorkMode?: string | null;
  projectWorkspaceId?: string | null;
  /** Optional: full SHA from PWS repoRef when loaded by caller */
  workspaceRepoRef?: string | null;
  thrashBlocked?: boolean;
  thrashDetail?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): DispatchAssignDecision {
  const env = input.env ?? process.env;
  const mode = getDispatchAssignMode(env);
  const actorIsDispatch = isDispatchActor({ ...input, env });
  if (mode === "off" || !actorIsDispatch) {
    return {
      allowed: true,
      mode,
      reasonCodes: [],
      details: actorIsDispatch ? "policy off" : "actor is not Dispatch",
      actorIsDispatch,
    };
  }

  const reasonCodes: DispatchAssignReasonCode[] = [];
  const implementIds = parseIdList(env.PAPERCLIP_DISPATCH_IMPLEMENT_AGENT_IDS);
  const reviewIds = parseIdList(env.PAPERCLIP_DISPATCH_REVIEW_AGENT_IDS);
  const implementNames = parseNameList(env.PAPERCLIP_DISPATCH_IMPLEMENT_AGENT_NAMES, DEFAULT_IMPLEMENT_NAMES);
  const reviewNames = parseNameList(env.PAPERCLIP_DISPATCH_REVIEW_AGENT_NAMES, DEFAULT_REVIEW_NAMES);

  const assigneeId = (input.assigneeAgentId ?? "").toLowerCase();
  const assigneeName = (input.assigneeAgentName ?? "").trim().toLowerCase();
  const assigneeRole = (input.assigneeAgentRole ?? "").trim().toLowerCase();

  const isImplementAssignee =
    (assigneeId && implementIds.has(assigneeId)) ||
    (assigneeName && implementNames.has(assigneeName)) ||
    assigneeRole === "engineer";
  const isReviewAssignee =
    (assigneeId && reviewIds.has(assigneeId)) ||
    (assigneeName && reviewNames.has(assigneeName)) ||
    assigneeRole === "qa";

  // When explicit UUID lists set, require UUID match for engineer path
  const strictImplement =
    implementIds.size > 0
      ? Boolean(assigneeId && implementIds.has(assigneeId))
      : Boolean(assigneeName && implementNames.has(assigneeName));
  const strictReview =
    reviewIds.size > 0
      ? Boolean(assigneeId && reviewIds.has(assigneeId))
      : Boolean(assigneeName && reviewNames.has(assigneeName));

  const allowAssignee =
    (implementIds.size > 0 || reviewIds.size > 0
      ? strictImplement || strictReview
      : (assigneeName && (implementNames.has(assigneeName) || reviewNames.has(assigneeName))) ||
        // fallback: role engineer/qa only if names missing
        (!assigneeName && (assigneeRole === "engineer" || assigneeRole === "qa")));

  // Prefer name allowlist always when name present
  const nameOk =
    !assigneeName ||
    implementNames.has(assigneeName) ||
    reviewNames.has(assigneeName) ||
    (implementIds.size > 0 && implementIds.has(assigneeId)) ||
    (reviewIds.size > 0 && reviewIds.has(assigneeId));

  if (!nameOk || (!strictImplement && !strictReview && implementIds.size + reviewIds.size > 0)) {
    // if UUID lists configured and neither matches
    if (implementIds.size + reviewIds.size > 0 && !strictImplement && !strictReview) {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED);
    } else if (assigneeName && !implementNames.has(assigneeName) && !reviewNames.has(assigneeName)) {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED);
    } else if (!allowAssignee && !assigneeName && assigneeRole && assigneeRole !== "engineer" && assigneeRole !== "qa") {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED);
    }
  }

  // Re-check pure name allowlist for common case (Wren/Mason/Argus by name)
  if (
    assigneeName &&
    !implementNames.has(assigneeName) &&
    !reviewNames.has(assigneeName) &&
    !(implementIds.has(assigneeId) || reviewIds.has(assigneeId))
  ) {
    if (!reasonCodes.includes(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED)) {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.ASSIGNEE_NOT_ALLOWLISTED);
    }
  }

  const implement = looksImplement({
    title: input.issueTitle,
    description: input.issueDescription,
    workMode: input.issueWorkMode,
    assigneeRole: input.assigneeAgentRole,
  });
  const review = looksReview({
    title: input.issueTitle,
    description: input.issueDescription,
    assigneeRole: input.assigneeAgentRole,
  });

  if (implement && !review) {
    if (!input.projectWorkspaceId) {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.MISSING_PROJECT_WORKSPACE);
    }
    const head =
      findExactHeadSha(input.issueDescription) ||
      (input.workspaceRepoRef && FULL_SHA_RE.test(input.workspaceRepoRef.trim())
        ? input.workspaceRepoRef.trim().toLowerCase()
        : null);
    if (!head) {
      reasonCodes.push(DISPATCH_ASSIGN_REASON.MISSING_EXACT_HEAD);
    }
  }

  if (input.thrashBlocked) {
    reasonCodes.push(DISPATCH_ASSIGN_REASON.THRASH_COOLDOWN);
  }

  // dedupe
  const unique = [...new Set(reasonCodes)];
  const deny = unique.length > 0;
  const allowed = mode === "observe" ? true : !deny;
  const details = deny
    ? unique.join(", ") + (input.thrashDetail ? `; ${input.thrashDetail}` : "")
    : "Dispatch assignment policy passed";

  return {
    allowed,
    mode,
    reasonCodes: unique,
    details,
    actorIsDispatch,
  };
}

export function evaluateDispatchWake(input: {
  actorType?: string | null;
  actorAgentId?: string | null;
  actorAgentName?: string | null;
  payloadIssueId?: string | null;
  contextIssueId?: string | null;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}): DispatchAssignDecision {
  const env = input.env ?? process.env;
  const mode = getDispatchAssignMode(env);
  const actorIsDispatch = isDispatchActor({ ...input, env });
  if (mode === "off" || !actorIsDispatch) {
    return {
      allowed: true,
      mode,
      reasonCodes: [],
      details: "not dispatch wake policy",
      actorIsDispatch,
    };
  }
  const issueId = (input.payloadIssueId || input.contextIssueId || "").trim();
  if (!issueId) {
    const deny = true;
    return {
      allowed: mode === "observe" ? true : !deny,
      mode,
      reasonCodes: [DISPATCH_ASSIGN_REASON.ISSUE_UNBOUND_WAKE],
      details: "Dispatch-originated wake requires payload.issueId / context.issueId",
      actorIsDispatch,
    };
  }
  return {
    allowed: true,
    mode,
    reasonCodes: [],
    details: "issue-bound wake ok",
    actorIsDispatch,
  };
}
