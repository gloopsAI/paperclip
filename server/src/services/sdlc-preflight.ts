/**
 * S1 — Induct SDLC preflight plane status + create/assign gate (pure).
 *
 * Fail-closed platform law for Induct product implement work:
 * - plane status from env (campaign deadline, scheduler, commission, pin)
 * - induct implement targeting (PWS allowlist / InductAI text + implement shape)
 * - create/assign gate requiring PWS + exact head + plane not critically failing
 *
 * Host S0 fills lease/health/epoch filesystem probes; this module evaluates what
 * the Paperclip process can see via env without hostctl or campaign open.
 *
 * Mode: PAPERCLIP_SDLC_PREFLIGHT=enforce|observe|off
 * - enforce (default outside tests): deny with stable error codes
 * - observe: allow but return would-deny codes for logging
 * - off: no-op
 */

import { findExactHeadSha } from "./dispatch-assignment-policy.js";

export const SDLC_PREFLIGHT_ENV = "PAPERCLIP_SDLC_PREFLIGHT";
export const SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS_ENV = "SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS";
export const SDLC_PREFLIGHT_WARN_CAMPAIGN_HOURS_ENV = "SDLC_PREFLIGHT_WARN_CAMPAIGN_HOURS";
export const INDUCT_PROJECT_WORKSPACE_IDS_ENV = "PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS";

/** Default Induct main project workspace on hermes. */
export const DEFAULT_INDUCT_PROJECT_WORKSPACE_ID = "452c8800-8270-4ca1-b384-8a677a39b826";

export const DEFAULT_MIN_CAMPAIGN_HOURS = 6;
export const DEFAULT_WARN_CAMPAIGN_HOURS = 12;

/** Reason codes aligned with host S0 where possible. */
export const SDLC_PREFLIGHT_REASON = {
  CAMPAIGN_DEADLINE_LT_6H: "campaign.deadline_lt_6h",
  CAMPAIGN_DEADLINE_LT_12H: "campaign.deadline_lt_12h",
  CAMPAIGN_MISSING_EPOCH: "campaign.missing_epoch",
  SCHEDULER_TRUE: "scheduler.true",
  COMMISSIONED_FALSE: "commissioned.false",
  HERMES_UNHEALTHY: "hermes.unhealthy",
  PAPERCLIP_UNHEALTHY: "paperclip.unhealthy",
  INDUCT_APP_NOT_OK: "induct_app.not_ok",
  LEASE_DIRTY_OR_MISSING: "lease.dirty_or_missing",
  PIN_MISMATCH: "pin.mismatch",
  MISSING_PROJECT_WORKSPACE: "sdlc.missing_project_workspace",
  MISSING_EXACT_HEAD: "sdlc.missing_exact_head",
  PLANE_NOT_OK: "sdlc.plane_not_ok",
  OK: "sdlc.ok",
} as const;

export type SdlcPreflightReasonCode =
  (typeof SDLC_PREFLIGHT_REASON)[keyof typeof SDLC_PREFLIGHT_REASON];

export type SdlcPreflightMode = "off" | "observe" | "enforce";

export type PlaneStatusResult = {
  ok: boolean;
  codes: SdlcPreflightReasonCode[];
  criticalCodes: SdlcPreflightReasonCode[];
  warningCodes: SdlcPreflightReasonCode[];
  campaign: {
    id: string | null;
    deadlineAt: string | null;
    hoursRemaining: number | null;
  };
  commissioned: boolean;
  schedulerEnabled: boolean;
  pinImage: string | null;
  approvedImage: string | null;
  hoursRemaining: number | null;
  /** Host S0 is authoritative for lease/health/epoch files. */
  hostPreflight: null;
  hostPreflightNote: string;
};

export type InductSdlcGateDecision = {
  allowed: boolean;
  mode: SdlcPreflightMode;
  required: boolean;
  reasonCodes: SdlcPreflightReasonCode[];
  details: string;
  plane: PlaneStatusResult;
  isInductImplement: boolean;
};

type EnvMap = NodeJS.ProcessEnv | Record<string, string | undefined>;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

const CRITICAL_PLANE_CODES = new Set<SdlcPreflightReasonCode>([
  SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H,
  SDLC_PREFLIGHT_REASON.CAMPAIGN_MISSING_EPOCH,
  SDLC_PREFLIGHT_REASON.SCHEDULER_TRUE,
  SDLC_PREFLIGHT_REASON.COMMISSIONED_FALSE,
  SDLC_PREFLIGHT_REASON.HERMES_UNHEALTHY,
  SDLC_PREFLIGHT_REASON.PAPERCLIP_UNHEALTHY,
  SDLC_PREFLIGHT_REASON.INDUCT_APP_NOT_OK,
  SDLC_PREFLIGHT_REASON.LEASE_DIRTY_OR_MISSING,
  SDLC_PREFLIGHT_REASON.PIN_MISMATCH,
]);

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function isTruthy(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const n = raw.trim().toLowerCase();
  return n === "true" || n === "1" || n === "yes";
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

export function getSdlcPreflightMode(env: EnvMap = process.env): SdlcPreflightMode {
  const raw = env[SDLC_PREFLIGHT_ENV];
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

export function getInductProjectWorkspaceIds(env: EnvMap = process.env): Set<string> {
  const raw = env[INDUCT_PROJECT_WORKSPACE_IDS_ENV];
  if (raw === undefined || raw.trim() === "") {
    return new Set([DEFAULT_INDUCT_PROJECT_WORKSPACE_ID.toLowerCase()]);
  }
  const ids = parseIdList(raw);
  return ids.size > 0 ? ids : new Set([DEFAULT_INDUCT_PROJECT_WORKSPACE_ID.toLowerCase()]);
}

/**
 * Lightweight implement shape (aligned with dispatch looksImplement, no assignee role required).
 */
export function looksImplementPacket(input: {
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
  if (input.description && /##\s*scope/i.test(input.description)) return true;
  if (/\bimplement\b/.test(text)) return true;
  return false;
}

function mentionsInduct(title?: string | null, description?: string | null): boolean {
  const text = `${title ?? ""}\n${description ?? ""}`;
  return /inductai\/induct|\binductai\b|\binduct\b/i.test(text);
}

/**
 * True when the issue targets Induct implement work.
 * - projectWorkspaceId in PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS (default induct-main PWS), OR
 * - title/description mentions InductAI/induct AND packet looks implement-shaped
 */
export function isInductImplementTarget(input: {
  projectWorkspaceId?: string | null;
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  assigneeRole?: string | null;
  env?: EnvMap;
}): boolean {
  const env = input.env ?? process.env;
  const pws = (input.projectWorkspaceId ?? "").trim().toLowerCase();
  const inductIds = getInductProjectWorkspaceIds(env);
  const onInductPws = Boolean(pws && inductIds.has(pws));
  const implement = looksImplementPacket({
    title: input.title,
    description: input.description,
    workMode: input.workMode,
    assigneeRole: input.assigneeRole,
  });
  if (onInductPws && implement) return true;
  if (onInductPws && !input.assigneeRole) {
    // PWS alone with any implement-ish text / scope counts when role unknown
    if (implement || mentionsInduct(input.title, input.description)) return true;
    // bare induct PWS with empty description is still an induct target if workMode implement-like
    const wm = (input.workMode ?? "").toLowerCase();
    if (wm === "implement" || wm === "build" || wm === "code") return true;
  }
  if (mentionsInduct(input.title, input.description) && implement) return true;
  return false;
}

function hoursUntilIso(deadlineAt: string, now: Date): number | null {
  try {
    const dt = new Date(deadlineAt);
    if (Number.isNaN(dt.getTime())) return null;
    return (dt.getTime() - now.getTime()) / (3600 * 1000);
  } catch {
    return null;
  }
}

/**
 * Pure plane-status evaluation from process env.
 * Campaign deadline uses PAPERCLIP_CAMPAIGN_DEADLINE_AT only (host S0 fills epoch files).
 */
export function evaluatePlaneStatusFromEnv(
  env: EnvMap = process.env,
  opts?: { now?: Date },
): PlaneStatusResult {
  const now = opts?.now ?? new Date();
  const criticalCodes: SdlcPreflightReasonCode[] = [];
  const warningCodes: SdlcPreflightReasonCode[] = [];

  const campaignId = (env.PAPERCLIP_CAMPAIGN_ID ?? "").trim() || null;
  const deadlineAt = (env.PAPERCLIP_CAMPAIGN_DEADLINE_AT ?? "").trim() || null;
  const commissioned = isTruthy(env.PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED);
  const schedulerEnabled =
    isTruthy(env.HEARTBEAT_SCHEDULER_ENABLED) ||
    isTruthy(env.PAPERCLIP_CONTROLLED_SWARM_SCHEDULER_ENABLED);
  const pinImage = (env.PAPERCLIP_IMAGE ?? "").trim() || null;
  const approvedImage =
    (env.PAPERCLIP_APPROVED_IMAGE ?? env.PAPERCLIP_HOSTCTL_APPROVED_IMAGE_VALUE ?? "").trim() ||
    null;

  const minHours = parsePositiveNumber(
    env[SDLC_PREFLIGHT_MIN_CAMPAIGN_HOURS_ENV],
    DEFAULT_MIN_CAMPAIGN_HOURS,
  );
  const warnHours = parsePositiveNumber(
    env[SDLC_PREFLIGHT_WARN_CAMPAIGN_HOURS_ENV],
    DEFAULT_WARN_CAMPAIGN_HOURS,
  );

  let hoursRemaining: number | null = null;
  if (deadlineAt) {
    hoursRemaining = hoursUntilIso(deadlineAt, now);
    if (hoursRemaining === null) {
      // Unparseable deadline is not treated as missing epoch on server; host owns epoch file.
      // Surface as critical deadline failure so gates stay fail-closed.
      criticalCodes.push(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H);
    } else if (hoursRemaining < minHours) {
      criticalCodes.push(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H);
    } else if (hoursRemaining < warnHours) {
      warningCodes.push(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_12H);
    }
  }
  // If no PAPERCLIP_CAMPAIGN_DEADLINE_AT: codes empty for deadline (host fills S0).
  // Optional: when commissioned and explicit PAPERCLIP_SDLC_REQUIRE_DEADLINE_AT=true,
  // require the env deadline (server cannot read epoch files).
  if (
    !deadlineAt &&
    commissioned &&
    isTruthy(env.PAPERCLIP_SDLC_REQUIRE_DEADLINE_AT)
  ) {
    criticalCodes.push(SDLC_PREFLIGHT_REASON.CAMPAIGN_MISSING_EPOCH);
  }

  if (schedulerEnabled) {
    criticalCodes.push(SDLC_PREFLIGHT_REASON.SCHEDULER_TRUE);
  }

  // Controlled swarm expected when campaign id set or explicit expected flag.
  const expectSwarm =
    Boolean(campaignId) || isTruthy(env.PAPERCLIP_CONTROLLED_SWARM_EXPECTED);
  if (expectSwarm && !commissioned) {
    criticalCodes.push(SDLC_PREFLIGHT_REASON.COMMISSIONED_FALSE);
  }

  if (pinImage && approvedImage && pinImage !== approvedImage) {
    criticalCodes.push(SDLC_PREFLIGHT_REASON.PIN_MISMATCH);
  }

  const uniqueCritical = [...new Set(criticalCodes)];
  const uniqueWarning = [...new Set(warningCodes)].filter((c) => !uniqueCritical.includes(c));
  const codes = [...uniqueCritical, ...uniqueWarning];
  const ok = uniqueCritical.length === 0;

  return {
    ok,
    codes,
    criticalCodes: uniqueCritical,
    warningCodes: uniqueWarning,
    campaign: {
      id: campaignId,
      deadlineAt,
      hoursRemaining,
    },
    commissioned,
    schedulerEnabled,
    pinImage,
    approvedImage,
    hoursRemaining,
    hostPreflight: null,
    hostPreflightNote:
      "Host S0 verify-induct-sdlc-preflight.sh is authoritative for lease, health curl, epoch files, induct-app status",
  };
}

export function isCriticalPlaneCode(code: string): boolean {
  return CRITICAL_PLANE_CODES.has(code as SdlcPreflightReasonCode);
}

/**
 * Gate for Induct implement create/assign.
 * Non-Induct targets always allowed (required=false).
 */
export function evaluateInductSdlcGate(input: {
  projectWorkspaceId?: string | null;
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  assigneeRole?: string | null;
  workspaceRepoRef?: string | null;
  /** Optional precomputed plane status; else evaluated from env. */
  plane?: PlaneStatusResult;
  env?: EnvMap;
  now?: Date;
}): InductSdlcGateDecision {
  const env = input.env ?? process.env;
  const mode = getSdlcPreflightMode(env);
  const plane =
    input.plane ??
    evaluatePlaneStatusFromEnv(env, input.now ? { now: input.now } : undefined);

  const isInductImplement = isInductImplementTarget({
    projectWorkspaceId: input.projectWorkspaceId,
    title: input.title,
    description: input.description,
    workMode: input.workMode,
    assigneeRole: input.assigneeRole,
    env,
  });

  if (mode === "off" || !isInductImplement) {
    return {
      allowed: true,
      mode,
      required: false,
      reasonCodes: [],
      details: mode === "off" ? "sdlc preflight off" : "not an Induct implement target",
      plane,
      isInductImplement,
    };
  }

  const reasonCodes: SdlcPreflightReasonCode[] = [];

  if (!input.projectWorkspaceId?.trim()) {
    reasonCodes.push(SDLC_PREFLIGHT_REASON.MISSING_PROJECT_WORKSPACE);
  }

  const headFromDesc = findExactHeadSha(input.description);
  const headFromRef =
    input.workspaceRepoRef && FULL_SHA_RE.test(input.workspaceRepoRef.trim())
      ? input.workspaceRepoRef.trim().toLowerCase()
      : null;
  if (!headFromDesc && !headFromRef) {
    reasonCodes.push(SDLC_PREFLIGHT_REASON.MISSING_EXACT_HEAD);
  }

  if (!plane.ok) {
    reasonCodes.push(SDLC_PREFLIGHT_REASON.PLANE_NOT_OK);
    for (const code of plane.criticalCodes) {
      if (!reasonCodes.includes(code)) reasonCodes.push(code);
    }
  }

  const unique = [...new Set(reasonCodes)];
  const deny = unique.length > 0;
  const allowed = mode === "observe" ? true : !deny;
  const details = deny
    ? `Induct SDLC gate: ${unique.join(", ")}${plane.criticalCodes.length ? ` (plane: ${plane.criticalCodes.join(",")})` : ""}`
    : "Induct SDLC preflight passed";

  return {
    allowed,
    mode,
    required: true,
    reasonCodes: unique,
    details,
    plane,
    isInductImplement,
  };
}

/** Map workspace_admit codes to plane-steward recipe ids (logging only; no hostctl). */
export function recommendedRecipesForAdmitCodes(codes: string[]): string[] {
  const recipes = new Set<string>();
  for (const code of codes) {
    const c = code.toLowerCase();
    if (c.includes("dirty_tree")) {
      recipes.add("dirty-tree-clean");
    }
    if (c.includes("head_mismatch") || c.includes("expected_head")) {
      recipes.add("wrong-head-rebase");
      recipes.add("induct-lease-refresh");
    }
    if (c.includes("cwd_not_readable") || c.includes("acl")) {
      recipes.add("acl-fix");
    }
    if (c.includes("lease") || c.includes("dirty_or_missing")) {
      recipes.add("induct-lease-refresh");
    }
    if (c.includes("deadline") || c.includes("campaign.")) {
      recipes.add("campaign-deadline-alert");
      recipes.add("sdlc-preflight-check");
    }
  }
  return [...recipes];
}
