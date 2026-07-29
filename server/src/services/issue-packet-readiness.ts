/**
 * Issue packet Definition of Ready (DoR) preflight.
 *
 * Pure evaluator: no DB, no heartbeat side effects. Callers supply normalized
 * issue fields and receive a ready/deny decision with stable reason codes.
 *
 * Wire points:
 * - POST /issues/:id/checkout (enforce → 422)
 * - heartbeat claimQueuedRun (enforce → cancel with issue_packet.not_ready)
 * - POST packet-readiness read API (always computes; never mutates)
 *
 * Mode: PAPERCLIP_ISSUE_PACKET_DOR=enforce|observe|off (default enforce).
 */

export const ISSUE_PACKET_DOR_ENV = "PAPERCLIP_ISSUE_PACKET_DOR";

export const ISSUE_PACKET_REASON = {
  MISSING_SCOPE: "issue_packet.missing_scope",
  MISSING_ACCEPTANCE: "issue_packet.missing_acceptance",
  MISSING_EXACT_HEAD: "issue_packet.missing_exact_head",
  MISSING_OBJECTIVE: "issue_packet.missing_objective",
  MISSING_RELEASE_ANCHOR: "issue_packet.missing_release_anchor",
  PLACEHOLDER_ONLY: "issue_packet.placeholder_only",
  NOT_READY: "issue_packet.not_ready",
} as const;

export type IssuePacketReasonCode =
  (typeof ISSUE_PACKET_REASON)[keyof typeof ISSUE_PACKET_REASON];

export type IssuePacketDorMode = "off" | "observe" | "enforce";

export type IssuePacketProfile =
  | "probe"
  | "standard_implement"
  | "standard_review"
  | "standard_release"
  | "coordination"
  | "exempt";

export type IssuePacketReadinessInput = {
  title?: string | null;
  description?: string | null;
  workMode?: string | null;
  status?: string | null;
  /** Agent role label (e.g. agents.role). */
  assigneeRole?: string | null;
  /** Agent display name (e.g. Argus, Harbor). */
  assigneeName?: string | null;
  /** When true, prefer standard_implement for product/repo work. */
  repositoryBacked?: boolean;
};

export type IssuePacketReadinessResult = {
  ready: boolean;
  mode: IssuePacketDorMode;
  profile: IssuePacketProfile;
  reasonCodes: string[];
  missing: string[];
  present: string[];
  details: string;
};

const MIN_SECTION_CHARS = 8;
const MIN_TITLE_CHARS = 12;

const PLACEHOLDER_ONLY_RE =
  /^(?:tbd|todo|n\/a|na|none|placeholder|coming soon|tbc|wip|\.+|-+|\*+|—+|–+)$/i;

const EXACT_HEAD_SHA_RE = /\b[0-9a-f]{40}\b/i;
const SHA256_DIGEST_RE = /\bsha256:[0-9a-f]{64}\b/i;
const LOOSE_SHA256_RE = /\b[0-9a-f]{64}\b/i;
/** Image refs: registry/name:tag, name@sha256:…, or ghcr.io/… */
const IMAGE_REF_RE =
  /\b(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+:[a-z0-9][\w.-]*|[a-z0-9][\w./-]+@sha256:[0-9a-f]{64})\b/i;

const REVIEW_TITLE_RE =
  /exact-head\s+review|maw-implementation-review|implementation\s+review/i;

const REVIEW_TERMINAL_LANGUAGE_RE =
  /\b(?:review\s+verdict|terminal\s+(?:review|contract)|verdict\s*:\s*(?:pass|fail|approve|reject)|(?:pass|fail|approved|rejected)\s+with\s+evidence|implementation\s+review\s+(?:pass|fail)|focused\s+review\s+(?:pass|fail))\b/i;

const EXACT_HEAD_LINE_RE =
  /(?:^|\n)\s*(?:exact\s*head|head\s*sha|headsha|base\s*sha|commit\s*sha)\s*[:=]?\s*`?([0-9a-f]{40})`?/i;

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Read PAPERCLIP_ISSUE_PACKET_DOR.
 * - Production default: enforce (product fail-close / GIGO).
 * - Vitest default when unset: off (legacy fixtures lack Scope/Acceptance packets).
 * - Explicit env always wins. Unknown values fall back to enforce.
 */
export function getIssuePacketDorMode(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IssuePacketDorMode {
  const raw = env[ISSUE_PACKET_DOR_ENV];
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
 * Extract a `## Heading` markdown section body (case-insensitive heading match).
 * Body runs until the next `## ` heading or end of document.
 */
export function extractMarkdownSection(
  markdown: string | null | undefined,
  heading: string,
): string | null {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`,
    "im",
  );
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section && section.length > 0 ? section : null;
}

function isPlaceholderOnly(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  // Single-line placeholders, or only list markers / dashes.
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*\-•]+/, "").trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => PLACEHOLDER_ONLY_RE.test(line));
}

type SectionAssessment = {
  present: boolean;
  substantive: boolean;
  placeholderOnly: boolean;
  body: string | null;
};

function assessSection(
  description: string | null | undefined,
  headings: readonly string[],
): SectionAssessment {
  for (const heading of headings) {
    const body = extractMarkdownSection(description, heading);
    if (body == null) continue;
    if (isPlaceholderOnly(body) || body.trim().length < MIN_SECTION_CHARS) {
      return {
        present: true,
        substantive: false,
        placeholderOnly: true,
        body,
      };
    }
    return {
      present: true,
      substantive: true,
      placeholderOnly: false,
      body,
    };
  }
  return {
    present: false,
    substantive: false,
    placeholderOnly: false,
    body: null,
  };
}

function roleMatchesAny(
  role: string | null | undefined,
  name: string | null | undefined,
  aliases: readonly string[],
): boolean {
  const candidates = [normalizeToken(role), normalizeToken(name)].filter(Boolean);
  if (candidates.length === 0) return false;
  for (const candidate of candidates) {
    for (const alias of aliases) {
      const needle = normalizeToken(alias);
      if (!needle) continue;
      if (candidate === needle) return true;
      // Allow "Independent Quality Owner" style contains for multi-word labels.
      if (candidate.includes(needle) || needle.includes(candidate)) return true;
    }
  }
  return false;
}

const REVIEW_ROLE_ALIASES = [
  "argus",
  "qa",
  "reviewer",
  "independent quality owner",
  "quality owner",
] as const;

const RELEASE_ROLE_ALIASES = [
  "harbor",
  "release",
  "deploy",
  "release and promotion owner",
] as const;

const COORDINATION_ROLE_ALIASES = [
  "dispatch",
  "northstar",
  "pm",
  "product manager",
  "execution coordinator",
  "project manager",
] as const;

function resolveProfile(input: IssuePacketReadinessInput): IssuePacketProfile {
  const status = normalizeToken(input.status);
  if (status === "done" || status === "cancelled") return "exempt";

  const workMode = normalizeToken(input.workMode);
  if (workMode === "skill_test" || workMode === "ask") return "probe";

  const title = input.title ?? "";
  const description = input.description ?? "";
  const reviewByRole = roleMatchesAny(input.assigneeRole, input.assigneeName, REVIEW_ROLE_ALIASES);
  const reviewByText = REVIEW_TITLE_RE.test(title) || REVIEW_TITLE_RE.test(description);
  if (reviewByRole || reviewByText) return "standard_review";

  if (roleMatchesAny(input.assigneeRole, input.assigneeName, RELEASE_ROLE_ALIASES)) {
    return "standard_release";
  }

  if (roleMatchesAny(input.assigneeRole, input.assigneeName, COORDINATION_ROLE_ALIASES)) {
    return "coordination";
  }

  // Default product path (standard / null / planning / repository-backed).
  void input.repositoryBacked;
  return "standard_implement";
}

function findExactHeadSha(description: string | null | undefined): string | null {
  if (!description) return null;
  const lineMatch = EXACT_HEAD_LINE_RE.exec(description);
  if (lineMatch?.[1]) return lineMatch[1].toLowerCase();
  const bare = EXACT_HEAD_SHA_RE.exec(description);
  return bare?.[0]?.toLowerCase() ?? null;
}

function hasReleaseAnchor(description: string | null | undefined): boolean {
  if (!description) return false;
  if (SHA256_DIGEST_RE.test(description)) return true;
  if (IMAGE_REF_RE.test(description)) return true;
  if (EXACT_HEAD_SHA_RE.test(description)) return true;
  if (LOOSE_SHA256_RE.test(description)) return true;
  return false;
}

function hasReviewTerminalLanguage(description: string | null | undefined): boolean {
  if (!description) return false;
  return REVIEW_TERMINAL_LANGUAGE_RE.test(description);
}

function evaluateProfileRequirements(
  profile: IssuePacketProfile,
  input: IssuePacketReadinessInput,
): {
  reasonCodes: string[];
  missing: string[];
  present: string[];
  detailParts: string[];
} {
  const reasonCodes: string[] = [];
  const missing: string[] = [];
  const present: string[] = [];
  const detailParts: string[] = [];

  if (profile === "exempt" || profile === "probe") {
    present.push(profile === "probe" ? "probe_exempt" : "status_exempt");
    detailParts.push(
      profile === "probe"
        ? "Probe workMode (skill_test/ask) is exempt from Scope/Acceptance packet requirements."
        : "Terminal issue status (done/cancelled) is exempt from packet readiness.",
    );
    return { reasonCodes, missing, present, detailParts };
  }

  const scope = assessSection(input.description, ["Scope"]);
  const acceptance = assessSection(input.description, [
    "Acceptance",
    "Acceptance Criteria",
  ]);
  const objective = assessSection(input.description, ["Objective"]);
  const decision = assessSection(input.description, [
    "Decision",
    "Outcome",
    "Decision / Outcome",
    "Decision/Outcome",
  ]);
  const grounding = assessSection(input.description, ["Grounding"]);

  // Grounding is observe-only in v1 — never fail-close.
  if (grounding.substantive) {
    present.push("Grounding");
  } else if (!grounding.present) {
    detailParts.push("Grounding section missing (observe-only; not required in v1).");
  } else {
    detailParts.push("Grounding section is placeholder-only (observe-only; not required in v1).");
  }

  const pushMissingSection = (
    label: string,
    assessment: SectionAssessment,
    missingCode: string,
  ) => {
    if (assessment.substantive) {
      present.push(label);
      return;
    }
    missing.push(label);
    if (assessment.placeholderOnly) {
      reasonCodes.push(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
      detailParts.push(`${label} section is placeholder-only.`);
    } else {
      reasonCodes.push(missingCode);
      detailParts.push(`Missing non-empty ## ${label} section.`);
    }
  };

  if (profile === "standard_implement") {
    pushMissingSection("Scope", scope, ISSUE_PACKET_REASON.MISSING_SCOPE);
    pushMissingSection("Acceptance", acceptance, ISSUE_PACKET_REASON.MISSING_ACCEPTANCE);
  } else if (profile === "standard_review") {
    const headSha = findExactHeadSha(input.description);
    if (headSha) {
      present.push("exactHeadSha");
    } else {
      missing.push("exactHeadSha");
      reasonCodes.push(ISSUE_PACKET_REASON.MISSING_EXACT_HEAD);
      detailParts.push("Review profile requires a 40-char exact head SHA in the description.");
    }

    const hasAcceptance = acceptance.substantive;
    const hasTerminal = hasReviewTerminalLanguage(input.description);
    if (hasAcceptance) {
      present.push("Acceptance");
    }
    if (hasTerminal) {
      present.push("reviewTerminalLanguage");
    }
    if (!hasAcceptance && !hasTerminal) {
      if (acceptance.placeholderOnly) {
        missing.push("Acceptance");
        reasonCodes.push(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
        detailParts.push(
          "Review profile needs Acceptance (or review terminal contract language); Acceptance is placeholder-only.",
        );
      } else {
        missing.push("Acceptance");
        reasonCodes.push(ISSUE_PACKET_REASON.MISSING_ACCEPTANCE);
        detailParts.push(
          "Review profile requires Acceptance section or explicit review terminal contract language.",
        );
      }
    }
  } else if (profile === "standard_release") {
    pushMissingSection("Acceptance", acceptance, ISSUE_PACKET_REASON.MISSING_ACCEPTANCE);
    if (hasReleaseAnchor(input.description)) {
      present.push("releaseAnchor");
    } else {
      missing.push("releaseAnchor");
      reasonCodes.push(ISSUE_PACKET_REASON.MISSING_RELEASE_ANCHOR);
      detailParts.push(
        "Release profile requires a sha256 digest, image ref, or 40-char merge SHA.",
      );
    }
  } else if (profile === "coordination") {
    const title = (input.title ?? "").trim();
    const titleOk = title.length >= MIN_TITLE_CHARS;
    if (objective.substantive) {
      present.push("Objective");
    } else if (titleOk) {
      present.push("title");
    } else {
      missing.push("Objective");
      if (objective.placeholderOnly) {
        reasonCodes.push(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
        detailParts.push(
          "Coordination profile needs Objective (or title ≥12 chars); Objective is placeholder-only.",
        );
      } else {
        reasonCodes.push(ISSUE_PACKET_REASON.MISSING_OBJECTIVE);
        detailParts.push(
          "Coordination profile requires ## Objective or a title of at least 12 characters.",
        );
      }
    }

    if (acceptance.substantive) {
      present.push("Acceptance");
    } else if (decision.substantive) {
      present.push("Decision/Outcome");
    } else if (acceptance.placeholderOnly || decision.placeholderOnly) {
      missing.push("Acceptance");
      reasonCodes.push(ISSUE_PACKET_REASON.PLACEHOLDER_ONLY);
      detailParts.push(
        "Coordination profile needs Acceptance or Decision/Outcome; section is placeholder-only.",
      );
    } else {
      missing.push("Acceptance");
      reasonCodes.push(ISSUE_PACKET_REASON.MISSING_ACCEPTANCE);
      detailParts.push(
        "Coordination profile requires Acceptance or an explicit Decision/Outcome section.",
      );
    }
  }

  // De-dupe reason codes while preserving order.
  const seen = new Set<string>();
  const uniqueCodes = reasonCodes.filter((code) => {
    if (seen.has(code)) return false;
    seen.add(code);
    return true;
  });

  return {
    reasonCodes: uniqueCodes,
    missing,
    present,
    detailParts,
  };
}

/**
 * Evaluate whether an issue description is a minimal typed packet for
 * execution admission. Pure: no I/O.
 *
 * Mode semantics:
 * - off: always ready (no-op rollback)
 * - observe: full evaluation but ready always true (reasonCodes still populated)
 * - enforce: ready false when required fields are missing
 */
export function evaluateIssuePacketReadiness(
  input: IssuePacketReadinessInput,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): IssuePacketReadinessResult {
  const mode = getIssuePacketDorMode(env);

  if (mode === "off") {
    return {
      ready: true,
      mode,
      profile: "exempt",
      reasonCodes: [],
      missing: [],
      present: [],
      details: "Issue packet DoR is off (PAPERCLIP_ISSUE_PACKET_DOR=off).",
    };
  }

  const profile = resolveProfile(input);
  const { reasonCodes, missing, present, detailParts } = evaluateProfileRequirements(
    profile,
    input,
  );

  const structurallyReady = reasonCodes.length === 0 && missing.length === 0;
  const ready = mode === "observe" ? true : structurallyReady;

  let details: string;
  if (structurallyReady) {
    details =
      detailParts.length > 0
        ? `Issue packet ready (profile=${profile}). ${detailParts.join(" ")}`
        : `Issue packet ready (profile=${profile}).`;
  } else {
    details = `Issue packet not ready (profile=${profile}): ${detailParts.join(" ") || missing.join(", ")}`;
    if (mode === "observe") {
      details = `[observe] ${details}`;
    }
  }

  return {
    ready,
    mode,
    profile,
    reasonCodes,
    missing,
    present,
    details: details.trim(),
  };
}
