/**
 * Fail-closed pre-run role / skill / config admission (OK-04).
 *
 * Pure evaluation: no DB, no heartbeat side effects. Callers (Dispatch check
 * route, future wake/preflight hooks) supply a normalized input and receive
 * an admit/deny decision with stable reason codes.
 *
 * Follow-up wire point (not in this slice): call `evaluateRoleAdmission` from
 * heartbeat wakeup / claim preflight and deny wake with the returned reason
 * codes when `admitted === false`. Prefer that over half-wiring heartbeat.ts
 * until the invokability + budget path is settled.
 */

export const ADMISSION_REASON = {
  AGENT_PAUSED: "admission.agent_paused",
  MISSING_MODEL: "admission.missing_model",
  CHARTER_INVALID: "admission.charter_invalid",
  SKILL_MISSING: "admission.skill_missing",
  SKILL_DENIED: "admission.skill_denied",
  ROLE_UNKNOWN: "admission.role_unknown",
  AGENT_STATUS: "admission.agent_status",
  BUDGET_MISSING: "admission.budget_missing",
} as const;

export type AdmissionReasonCode =
  (typeof ADMISSION_REASON)[keyof typeof ADMISSION_REASON];

export type RoleAdmissionPolicy = {
  /** Canonical role key (lowercase). */
  key: string;
  /** Case-insensitive role name aliases that map to this policy. */
  aliases: readonly string[];
  /**
   * Skill key / slug fragments that are allowed for this role.
   * Matching is case-insensitive substring against the skill key or its
   * trailing slug (last path segment). Empty allowlist means deny-all skills.
   */
  allowedSkillPatterns: readonly string[];
  /**
   * Explicit denylist patterns. Matched the same way as allow patterns.
   * Always evaluated even when a skill would otherwise match allow.
   */
  deniedSkillPatterns: readonly string[];
};

/**
 * GLoops controlled-swarm role skill policies.
 * Role matching is by agent name / role label (case-insensitive).
 */
/**
 * WP-E role skill allowlists (PLAN-AUTONOMOUS-RUNTIME + phase-bc-closure B5).
 * Attached skills must match allow patterns and must not match deny patterns.
 * Default-deny for unknown attached skills is enforced in evaluateRoleAdmission.
 */
export const ROLE_ADMISSION_POLICIES: readonly RoleAdmissionPolicy[] = [
  {
    key: "implementer",
    aliases: ["wren", "mason", "implementer", "implementation engineer", "accountable implementation owner"],
    // WP-E: gloops-bounded-implementation, gloops-task-preparation, software-development,
    // github (read patterns), gloops-evidence-lookup + paperclip helpers
    allowedSkillPatterns: [
      "paperclip",
      "github",
      "git",
      "terminal",
      "file",
      "workspace",
      "implementation",
      "bounded-implementation",
      "task-preparation",
      "software-development",
      "software",
      "prcheck",
      "pr-report",
      "check-pr",
      "code",
      "test",
      "qa-acceptance",
      "doc-maintenance",
      "evidence-lookup",
      "gloops-bounded-implementation",
      "gloops-task-preparation",
      "gloops-evidence-lookup",
      "gloops-",
    ],
    // WP-E default deny packs (social/media/etc.)
    deniedSkillPatterns: [
      "twitter",
      "discord",
      "slack",
      "social-media",
      "social",
      "smart-home",
      "yuanbao",
      "dogfood",
      "apple",
      "creative",
      "email",
      "announcement",
      "release-announcement",
      "release-changelog-discord",
      "media",
    ],
  },
  {
    key: "reviewer",
    aliases: ["argus", "reviewer", "independent quality owner", "qa"],
    // WP-E: gloops-focused-review, gloops-evidence-lookup, gloops-terminal-reconciliation
    allowedSkillPatterns: [
      "review",
      "evidence",
      "qa",
      "acceptance",
      "focused-review",
      "gloops-focused-review",
      "gloops-evidence",
      "gloops-evidence-lookup",
      "gloops-terminal-reconciliation",
      "terminal-reconciliation",
      "reconciliation",
      "paperclip",
      "github-read",
      "doc-maintenance",
      "diagnose",
    ],
    deniedSkillPatterns: [
      "bounded-implementation",
      "implementation",
      "github-pr",
      "github-push",
      "push",
      "release",
      "deploy",
      "promotion",
      "terminal-bench",
      "twitter",
      "discord",
      "slack",
      "social-media",
      "social",
      "smart-home",
      "yuanbao",
      "dogfood",
      "media",
    ],
  },
  {
    key: "dispatch",
    aliases: ["dispatch", "execution coordinator"],
    // WP-E: gloops-bounded-planning, gloops-evidence-lookup only (no implement)
    allowedSkillPatterns: [
      "dispatch",
      "triage",
      "task-planning",
      "task-preparation",
      "issue-triage",
      "routing",
      "gloops-task-preparation",
      "gloops-bounded-planning",
      "gloops-evidence-lookup",
      "evidence-lookup",
      "evidence",
      "paperclip",
    ],
    deniedSkillPatterns: [
      "implementation",
      "github-pr",
      "github-push",
      "push",
      "release",
      "deploy",
      "review",
      "twitter",
      "discord",
      "slack",
      "social-media",
      "social",
      "smart-home",
      "yuanbao",
      "dogfood",
      "media",
    ],
  },
  {
    key: "researcher",
    aliases: ["scout", "researcher", "business analyst copilot", "business analyst"],
    allowedSkillPatterns: [
      "paperclip",
      "research",
      "analysis",
      "evidence",
      "gloops-evidence-lookup",
      "evidence-lookup",
      "github-read",
      "doc-maintenance",
      "task-preparation",
    ],
    deniedSkillPatterns: [
      "implementation",
      "github-pr",
      "github-push",
      "push",
      "release",
      "deploy",
      "promotion",
      "twitter",
      "discord",
      "slack",
      "social-media",
      "social",
      "smart-home",
      "media",
    ],
  },
  {
    key: "harbor",
    aliases: ["harbor", "release and promotion owner", "release", "deploy"],
    // release / deploy + evidence helpers
    allowedSkillPatterns: [
      "release",
      "deploy",
      "promotion",
      "changelog",
      "harbor",
      "paperclip",
      "github",
      "rollback",
      "gloops-evidence-lookup",
      "gloops-terminal-reconciliation",
      "evidence-lookup",
      "evidence",
      "terminal-reconciliation",
      "reconciliation",
    ],
    deniedSkillPatterns: [
      "bounded-implementation",
      "implementation",
      "twitter",
      "discord",
      "slack",
      "social-media",
      "social",
      "smart-home",
      "yuanbao",
      "dogfood",
      "media",
      "announcement",
    ],
  },
] as const;

export type RoleAdmissionOptions = {
  /** When true, paused agents may still pass the status check. Default false. */
  allowPaused?: boolean;
  /** Minimum charter/instructions length. Default 100. */
  minCharterLength?: number;
  /** Maximum charter/instructions length. Default 4000. */
  maxCharterLength?: number;
  /**
   * When true, require a budget envelope (budgetMonthlyCents > 0 or
   * budgetEnvelope present). Default false for MVP.
   */
  requireBudget?: boolean;
};

export type RoleAdmissionInput = {
  /** Role name used for policy lookup (typically agent name in GLoops). */
  role: string;
  /** Agent lifecycle status. */
  status: string;
  /**
   * Model / route identifier. Non-empty string required.
   * Callers should surface adapterConfig.model or an equivalent route field.
   */
  model?: string | null;
  /** Charter / instructions text length is what we validate. */
  instructions?: string | null;
  /**
   * Skills currently attached / desired-synced on the agent.
   * Used for denylist checks and for satisfying `desiredSkills`.
   */
  attachedSkills?: readonly string[] | null;
  /**
   * Skills required for the upcoming run. When provided, every entry must
   * appear in `attachedSkills` (case-insensitive key/slug match).
   */
  desiredSkills?: readonly string[] | null;
  /** Monthly budget cents on the agent row (optional budget signal). */
  budgetMonthlyCents?: number | null;
  /** Explicit budget envelope presence flag / object (optional). */
  budgetEnvelope?: unknown;
  options?: RoleAdmissionOptions;
};

export type RoleAdmissionResult = {
  admitted: boolean;
  reasonCodes: string[];
  details: string;
  /** Resolved policy key when role was recognized; null when unknown. */
  roleKey: string | null;
};

const DEFAULT_MIN_CHARTER = 100;
const DEFAULT_MAX_CHARTER = 4000;

const ADMITTED_STATUSES = new Set(["idle", "running", "active"]);
const PAUSED_STATUSES = new Set(["paused"]);
const HARD_DENY_STATUSES = new Set(["error", "terminated", "pending_approval"]);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function skillSlug(skillKey: string): string {
  const normalized = normalizeToken(skillKey);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function skillMatchesPattern(skillKey: string, pattern: string): boolean {
  const needle = normalizeToken(pattern);
  if (!needle) return false;
  const key = normalizeToken(skillKey);
  const slug = skillSlug(skillKey);
  return key.includes(needle) || slug.includes(needle) || slug === needle || key === needle;
}

function skillMatchesAny(skillKey: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => skillMatchesPattern(skillKey, pattern));
}

/**
 * Resolve a role admission policy by role name (case-insensitive alias match).
 * Returns null for unknown roles (fail-closed).
 */
export function resolveRoleAdmissionPolicy(role: string): RoleAdmissionPolicy | null {
  const normalized = normalizeToken(role);
  if (!normalized) return null;
  for (const policy of ROLE_ADMISSION_POLICIES) {
    if (policy.key === normalized) return policy;
    if (policy.aliases.some((alias) => normalizeToken(alias) === normalized)) {
      return policy;
    }
  }
  return null;
}

function hasNonEmptyModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.trim().length > 0;
}

/**
 * Extract a model/route string from adapterConfig-shaped records.
 * Prefers `model`, then common route equivalents.
 */
export function extractModelFromAdapterConfig(adapterConfig: unknown): string | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null || Array.isArray(adapterConfig)) {
    return null;
  }
  const config = adapterConfig as Record<string, unknown>;
  const candidates = [
    config.model,
    config.route,
    config.apiBaseUrl,
    config.url,
    config.endpoint,
    config.command,
    config.script,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

/**
 * Extract charter/instructions text from common agent config shapes.
 * Prefer explicit instructions, then promptTemplate, then capabilities.
 */
export function extractCharterText(input: {
  instructions?: string | null;
  adapterConfig?: unknown;
  capabilities?: string | null;
}): string {
  if (typeof input.instructions === "string" && input.instructions.trim().length > 0) {
    return input.instructions;
  }
  if (typeof input.adapterConfig === "object" && input.adapterConfig !== null && !Array.isArray(input.adapterConfig)) {
    const config = input.adapterConfig as Record<string, unknown>;
    if (typeof config.promptTemplate === "string" && config.promptTemplate.trim().length > 0) {
      return config.promptTemplate;
    }
  }
  if (typeof input.capabilities === "string" && input.capabilities.trim().length > 0) {
    return input.capabilities;
  }
  return "";
}

function skillsEquivalent(left: string, right: string): boolean {
  const a = normalizeToken(left);
  const b = normalizeToken(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return skillSlug(a) === skillSlug(b);
}

function attachedContains(attached: readonly string[], desired: string): boolean {
  return attached.some((skill) => skillsEquivalent(skill, desired));
}

function hasBudgetEnvelope(input: RoleAdmissionInput): boolean {
  if (input.budgetEnvelope != null && input.budgetEnvelope !== false) {
    if (typeof input.budgetEnvelope === "object") return true;
    if (input.budgetEnvelope === true) return true;
  }
  if (typeof input.budgetMonthlyCents === "number" && Number.isFinite(input.budgetMonthlyCents) && input.budgetMonthlyCents > 0) {
    return true;
  }
  return false;
}

/**
 * Fail-closed pre-run admission for role skill allowlists and agent config.
 */
export function evaluateRoleAdmission(input: RoleAdmissionInput): RoleAdmissionResult {
  const reasonCodes: string[] = [];
  const detailParts: string[] = [];
  const options = input.options ?? {};
  const allowPaused = options.allowPaused === true;
  const minCharter = options.minCharterLength ?? DEFAULT_MIN_CHARTER;
  const maxCharter = options.maxCharterLength ?? DEFAULT_MAX_CHARTER;
  const requireBudget = options.requireBudget === true;

  const policy = resolveRoleAdmissionPolicy(input.role);
  if (!policy) {
    return {
      admitted: false,
      reasonCodes: [ADMISSION_REASON.ROLE_UNKNOWN],
      details: `Unknown role "${input.role.trim() || "(empty)"}"; fail-closed admission denies non-MVP roles.`,
      roleKey: null,
    };
  }

  const status = normalizeToken(input.status);
  if (PAUSED_STATUSES.has(status) && !allowPaused) {
    reasonCodes.push(ADMISSION_REASON.AGENT_PAUSED);
    detailParts.push(`Agent status is paused.`);
  } else if (HARD_DENY_STATUSES.has(status) || !ADMITTED_STATUSES.has(status)) {
    // paused with allowPaused falls through; error/terminated/unknown deny
    if (!(PAUSED_STATUSES.has(status) && allowPaused)) {
      reasonCodes.push(ADMISSION_REASON.AGENT_STATUS);
      detailParts.push(
        `Agent status "${input.status}" is not idle/running/active` +
          (allowPaused ? " (paused allowed)." : "."),
      );
    }
  }

  if (!hasNonEmptyModel(input.model)) {
    reasonCodes.push(ADMISSION_REASON.MISSING_MODEL);
    detailParts.push("Model/route is missing or empty.");
  }

  const charter = typeof input.instructions === "string" ? input.instructions : "";
  const charterLength = charter.length;
  if (charterLength < minCharter || charterLength > maxCharter) {
    reasonCodes.push(ADMISSION_REASON.CHARTER_INVALID);
    detailParts.push(
      `Charter/instructions length ${charterLength} is outside [${minCharter}, ${maxCharter}].`,
    );
  }

  const attached = (input.attachedSkills ?? [])
    .map((skill) => (typeof skill === "string" ? skill.trim() : ""))
    .filter(Boolean);
  const desired = (input.desiredSkills ?? [])
    .map((skill) => (typeof skill === "string" ? skill.trim() : ""))
    .filter(Boolean);

  if (desired.length > 0) {
    const missing = desired.filter((skill) => !attachedContains(attached, skill));
    if (missing.length > 0) {
      reasonCodes.push(ADMISSION_REASON.SKILL_MISSING);
      detailParts.push(`Missing required skills: ${missing.join(", ")}.`);
    }
  }

  const deniedAttached: string[] = [];
  for (const skill of attached) {
    const deniedExplicit = skillMatchesAny(skill, policy.deniedSkillPatterns);
    const allowed = skillMatchesAny(skill, policy.allowedSkillPatterns);
    if (deniedExplicit || !allowed) {
      deniedAttached.push(skill);
    }
  }
  if (deniedAttached.length > 0) {
    reasonCodes.push(ADMISSION_REASON.SKILL_DENIED);
    detailParts.push(
      `Attached skills denied for role ${policy.key}: ${deniedAttached.join(", ")}.`,
    );
  }

  if (requireBudget && !hasBudgetEnvelope(input)) {
    reasonCodes.push(ADMISSION_REASON.BUDGET_MISSING);
    detailParts.push("Budget envelope is required but missing.");
  }

  const admitted = reasonCodes.length === 0;
  return {
    admitted,
    reasonCodes,
    details: admitted
      ? `Admitted role ${policy.key} (${normalizeToken(input.role)}).`
      : detailParts.join(" "),
    roleKey: policy.key,
  };
}

/**
 * Build a pure evaluation input from an agent-shaped record plus optional
 * desired skills override (e.g. Dispatch admission-check body).
 */
export function buildRoleAdmissionInputFromAgent(
  agent: {
    name: string;
    role?: string | null;
    title?: string | null;
    status: string;
    capabilities?: string | null;
    adapterConfig?: unknown;
    budgetMonthlyCents?: number | null;
  },
  options?: {
    desiredSkills?: readonly string[] | null;
    attachedSkills?: readonly string[] | null;
    instructions?: string | null;
    budgetEnvelope?: unknown;
    admissionOptions?: RoleAdmissionOptions;
  },
): RoleAdmissionInput {
  // GLoops roles are agent names (Wren/Mason/Argus/…). Prefer name, then title, then Paperclip role enum.
  const roleLabel = agent.name?.trim() || agent.title?.trim() || agent.role?.trim() || "";
  const adapterConfig =
    typeof agent.adapterConfig === "object" && agent.adapterConfig !== null && !Array.isArray(agent.adapterConfig)
      ? (agent.adapterConfig as Record<string, unknown>)
      : {};

  let attachedSkills = options?.attachedSkills ?? null;
  if (!attachedSkills) {
    const sync = adapterConfig.paperclipSkillSync;
    if (typeof sync === "object" && sync !== null && !Array.isArray(sync)) {
      const desiredRaw = (sync as Record<string, unknown>).desiredSkills;
      if (Array.isArray(desiredRaw)) {
        attachedSkills = desiredRaw.flatMap((value) => {
          if (typeof value === "string" && value.trim()) return [value.trim()];
          if (typeof value === "object" && value !== null && !Array.isArray(value)) {
            const key = (value as Record<string, unknown>).key;
            return typeof key === "string" && key.trim() ? [key.trim()] : [];
          }
          return [];
        });
      }
    }
  }

  const instructions =
    options?.instructions ??
    extractCharterText({
      adapterConfig,
      capabilities: agent.capabilities,
    });

  return {
    role: roleLabel,
    status: agent.status,
    model: extractModelFromAdapterConfig(adapterConfig),
    instructions,
    attachedSkills,
    desiredSkills: options?.desiredSkills ?? null,
    budgetMonthlyCents: agent.budgetMonthlyCents ?? null,
    budgetEnvelope: options?.budgetEnvelope,
    options: options?.admissionOptions,
  };
}
