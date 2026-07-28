/**
 * Typed discovery handoff (OK-08).
 *
 * Discovery is schema-driven with deterministic project routing and fingerprint
 * dedupe — not free-form agent memory ("remember BACKLOG at turn 80").
 *
 * Pure evaluation: no DB, no issue creation. Callers (plan route, future
 * create-on-admit hooks) supply projects + existing fingerprints and receive a
 * routing/dedupe plan receipt.
 */

import { createHash } from "node:crypto";

export const DISCOVERY_RECEIPT_SCHEMA = "gloops.discovery-receipt.v1" as const;

/** Canonical discovery project keys. */
export const DISCOVERY_PROJECT_KEYS = {
  BACKLOG: "BACKLOG",
  WO_PR: "WO-PR",
} as const;

export type KnownDiscoveryProjectKey =
  (typeof DISCOVERY_PROJECT_KEYS)[keyof typeof DISCOVERY_PROJECT_KEYS];

/** Default when `projectKey` is omitted. */
export const DEFAULT_DISCOVERY_PROJECT_KEY: KnownDiscoveryProjectKey =
  DISCOVERY_PROJECT_KEYS.BACKLOG;

/**
 * Project routing table.
 * Keys BACKLOG, WO-PR; default BACKLOG.
 * Matchers are compared case-insensitively against project names
 * (exact match or substring).
 */
export type DiscoveryProjectRoute = {
  key: string;
  nameMatchers: readonly string[];
};

export const DISCOVERY_PROJECT_ROUTING: Readonly<
  Record<string, DiscoveryProjectRoute>
> = {
  BACKLOG: {
    key: DISCOVERY_PROJECT_KEYS.BACKLOG,
    nameMatchers: ["backlog"],
  },
  "WO-PR": {
    key: DISCOVERY_PROJECT_KEYS.WO_PR,
    nameMatchers: ["wo-pr", "wopr", "work-order", "work order"],
  },
};

/** Issue statuses treated as terminal for dedupe (re-create allowed). */
export const DISCOVERY_TERMINAL_STATUSES = new Set(["done", "cancelled"]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveryProvenance = {
  /** Where the discovery originated (agent, watchdog, human, adapter, …). */
  source: string;
  agentId?: string | null;
  runId?: string | null;
  companyId?: string | null;
  discoveredAt?: string | null;
  notes?: string | null;
};

export type DiscoveryRequest = {
  title: string;
  summary: string;
  provenance: DiscoveryProvenance;
  sourceIssueId?: string | null;
  /** Optional caller-supplied fingerprint; otherwise derived from title+summary. */
  fingerprint?: string | null;
  /**
   * Target project key. Known keys: BACKLOG, WO-PR.
   * Defaults to BACKLOG when omitted.
   */
  projectKey?: string | null;
};

export type DiscoveryProject = {
  id: string;
  name: string;
};

export type DiscoveryExistingIssue = {
  fingerprint: string;
  projectId: string;
  status: string;
  issueId?: string | null;
};

export type RouteDiscoveryOk = {
  ok: true;
  projectKey: string;
  projectId: string;
  projectName: string;
};

export type RouteDiscoveryError = {
  ok: false;
  error: string;
  code:
    | "discovery.project_not_found"
    | "discovery.project_list_empty"
    | "discovery.invalid_project_key";
  projectKey: string;
};

export type RouteDiscoveryResult = RouteDiscoveryOk | RouteDiscoveryError;

export type DedupeCreate = {
  action: "create";
  fingerprint: string;
  reason: "no_existing_fingerprint" | "no_open_duplicate";
};

export type DedupeSkip = {
  action: "skip";
  fingerprint: string;
  reason: "duplicate_open_fingerprint";
  existingProjectId: string;
  existingStatus: string;
  existingIssueId: string | null;
};

export type DedupeResult = DedupeCreate | DedupeSkip;

export type DiscoveryDecision = "create" | "skip" | "error";

export type DiscoveryReceipt = {
  schemaVersion: typeof DISCOVERY_RECEIPT_SCHEMA;
  companyId: string;
  title: string;
  summary: string;
  fingerprint: string;
  projectKey: string;
  projectId: string | null;
  routing: RouteDiscoveryResult;
  dedupe: DedupeResult;
  decision: DiscoveryDecision;
  provenance: DiscoveryProvenance;
  sourceIssueId: string | null;
  plannedAt: string;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeTitleSummary(title: string, summary: string): string {
  return `${collapseWhitespace(title).toLowerCase()}\n${collapseWhitespace(summary).toLowerCase()}`;
}

function hashFingerprintPayload(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the effective discovery project key.
 * - empty / missing → BACKLOG
 * - known aliases (wopr, wo_pr, …) → WO-PR
 * - otherwise the trimmed key as provided
 */
export function resolveDiscoveryProjectKey(
  req: Pick<DiscoveryRequest, "projectKey">,
): string {
  const raw = typeof req.projectKey === "string" ? req.projectKey.trim() : "";
  if (!raw) return DEFAULT_DISCOVERY_PROJECT_KEY;

  const normalized = raw.toUpperCase().replace(/_/g, "-");
  if (normalized === "BACKLOG") return DISCOVERY_PROJECT_KEYS.BACKLOG;
  if (normalized === "WO-PR" || normalized === "WOPR") {
    return DISCOVERY_PROJECT_KEYS.WO_PR;
  }
  return raw;
}

/**
 * Normalize a discovery fingerprint.
 * Prefer a provided non-empty fingerprint (trimmed, lowercased); otherwise
 * derive a stable sha256 from normalized title + summary.
 */
export function normalizeFingerprint(
  req: Pick<DiscoveryRequest, "title" | "summary" | "fingerprint">,
): string {
  if (typeof req.fingerprint === "string") {
    const provided = req.fingerprint.trim().toLowerCase();
    if (provided.length > 0) return provided;
  }
  return hashFingerprintPayload(normalizeTitleSummary(req.title ?? "", req.summary ?? ""));
}

function projectMatchesKey(project: DiscoveryProject, projectKey: string): boolean {
  const name = collapseWhitespace(project.name).toLowerCase();
  if (!name) return false;

  const routing = DISCOVERY_PROJECT_ROUTING[projectKey];
  const matchers = routing?.nameMatchers ?? [projectKey];

  return matchers.some((matcher) => {
    const needle = collapseWhitespace(matcher).toLowerCase();
    if (!needle) return false;
    return name === needle || name.includes(needle);
  });
}

/**
 * Deterministically route a discovery request to a project id.
 * Uses the routing table for known keys; falls back to name matchers
 * derived from the key itself for unknown keys.
 */
export function routeDiscovery(
  req: Pick<DiscoveryRequest, "projectKey">,
  projects: DiscoveryProject[],
): RouteDiscoveryResult {
  const projectKey = resolveDiscoveryProjectKey(req);

  if (!projectKey) {
    return {
      ok: false,
      error: "Discovery project key is empty",
      code: "discovery.invalid_project_key",
      projectKey: "",
    };
  }

  if (!Array.isArray(projects) || projects.length === 0) {
    return {
      ok: false,
      error: "No projects supplied for discovery routing",
      code: "discovery.project_list_empty",
      projectKey,
    };
  }

  const match = projects.find((project) => projectMatchesKey(project, projectKey));
  if (!match) {
    return {
      ok: false,
      error: `No project matched discovery key ${projectKey}`,
      code: "discovery.project_not_found",
      projectKey,
    };
  }

  return {
    ok: true,
    projectKey,
    projectId: match.id,
    projectName: match.name,
  };
}

/**
 * Dedupe a discovery against existing fingerprint records.
 *
 * - skip when an open (non-terminal) issue shares the fingerprint
 * - create when no open match exists (terminal-only history is allowed to re-open)
 */
export function dedupeDiscovery(
  req: Pick<DiscoveryRequest, "title" | "summary" | "fingerprint">,
  existing: DiscoveryExistingIssue[],
  options: { projectId?: string | null } = {},
): DedupeResult {
  const fingerprint = normalizeFingerprint(req);
  const records = Array.isArray(existing) ? existing : [];

  const matches = records.filter((entry) => {
    if (typeof entry.fingerprint !== "string") return false;
    return entry.fingerprint.trim().toLowerCase() === fingerprint;
  });

  const openMatches = matches.filter(
    (entry) => !DISCOVERY_TERMINAL_STATUSES.has(String(entry.status ?? "").toLowerCase()),
  );

  let candidate: DiscoveryExistingIssue | undefined;
  if (options.projectId) {
    candidate =
      openMatches.find((entry) => entry.projectId === options.projectId) ??
      openMatches[0];
  } else {
    candidate = openMatches[0];
  }

  if (candidate) {
    return {
      action: "skip",
      fingerprint,
      reason: "duplicate_open_fingerprint",
      existingProjectId: candidate.projectId,
      existingStatus: candidate.status,
      existingIssueId: candidate.issueId ?? null,
    };
  }

  return {
    action: "create",
    fingerprint,
    reason: matches.length > 0 ? "no_open_duplicate" : "no_existing_fingerprint",
  };
}

/**
 * Build a plan-only discovery receipt (routing + dedupe, no issue create).
 */
export function buildDiscoveryReceipt(input: {
  companyId: string;
  request: DiscoveryRequest;
  projects: DiscoveryProject[];
  existing?: DiscoveryExistingIssue[];
  plannedAt?: string;
}): DiscoveryReceipt {
  const title = collapseWhitespace(input.request.title ?? "");
  const summary = collapseWhitespace(input.request.summary ?? "");
  const fingerprint = normalizeFingerprint(input.request);
  const projectKey = resolveDiscoveryProjectKey(input.request);
  const routing = routeDiscovery(input.request, input.projects);
  const dedupe = dedupeDiscovery(input.request, input.existing ?? [], {
    projectId: routing.ok ? routing.projectId : null,
  });

  let decision: DiscoveryDecision;
  if (!routing.ok) {
    decision = "error";
  } else if (dedupe.action === "skip") {
    decision = "skip";
  } else {
    decision = "create";
  }

  return {
    schemaVersion: DISCOVERY_RECEIPT_SCHEMA,
    companyId: input.companyId,
    title,
    summary,
    fingerprint,
    projectKey,
    projectId: routing.ok ? routing.projectId : null,
    routing,
    dedupe,
    decision,
    provenance: input.request.provenance,
    sourceIssueId: input.request.sourceIssueId ?? null,
    plannedAt: input.plannedAt ?? new Date().toISOString(),
  };
}

/**
 * Plan a discovery handoff: validate required fields, route, dedupe, receipt.
 * Throws on missing title/summary/provenance.source (caller maps to 400).
 */
export function planDiscovery(input: {
  companyId: string;
  request: DiscoveryRequest;
  projects: DiscoveryProject[];
  existing?: DiscoveryExistingIssue[];
  plannedAt?: string;
}): DiscoveryReceipt {
  const title = collapseWhitespace(input.request.title ?? "");
  const summary = collapseWhitespace(input.request.summary ?? "");
  if (!title) {
    throw new Error("Discovery title is required");
  }
  if (!summary) {
    throw new Error("Discovery summary is required");
  }
  const source =
    typeof input.request.provenance?.source === "string"
      ? input.request.provenance.source.trim()
      : "";
  if (!source) {
    throw new Error("Discovery provenance.source is required");
  }

  return buildDiscoveryReceipt({
    companyId: input.companyId,
    request: {
      ...input.request,
      title,
      summary,
      provenance: {
        ...input.request.provenance,
        source,
      },
    },
    projects: input.projects,
    existing: input.existing,
    plannedAt: input.plannedAt,
  });
}
