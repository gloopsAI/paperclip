/**
 * Harbor release/rollback contract (OK-06).
 *
 * Pure validation + receipt builders for agent-owned release decisions.
 * Does NOT call platform-ops or widen deploy authority — live deploy remains
 * receipt-gated and flag-controlled elsewhere.
 */

export const RELEASE_CONTRACT_SCHEMA_VERSION = "gloops.harbor-release-contract.v1" as const;

/** Environments Harbor may consider for a release candidate. */
export const ALLOWED_RELEASE_ENVIRONMENTS = ["surface", "staging", "production"] as const;
export type AllowedReleaseEnvironment = (typeof ALLOWED_RELEASE_ENVIRONMENTS)[number];

/**
 * Exact image digest: either bare `sha256:<64hex>` or a registry path pin
 * `name@sha256:<64hex>` (matches platform-ops broker pin shape).
 */
const IMAGE_DIGEST_PATTERN =
  /^(?:(?:[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)@)?sha256:[0-9a-f]{64}$/;

/** Git object id: full 40-char SHA-1 (or 64-char SHA-256 object ids). */
const HEAD_REF_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type ReleaseCandidate = {
  /** Exact image digest to promote (required; fail closed if missing/malformed). */
  imageDigest: string;
  /** PR reference (number, URL, or refs/pull/N/head). */
  prRef: string;
  /** Exact head commit SHA of the release candidate. */
  headRef: string;
  /** Argus accepted the exact head (required true; fail closed otherwise). */
  argusAccepted: boolean;
  /** CI green on the exact head (required true). */
  ciGreen: boolean;
  /** Target environment; must be allowlisted. */
  environment: string;
  /** Optional systemd unit / service name the pin targets. */
  service?: string;
  /** Optional prior pin for rollback targeting. */
  previousImageDigest?: string;
  /** Optional idempotency key for deploy receipt correlation. */
  idempotencyKey?: string;
};

export type ReleaseCandidateValidationCode =
  | "missing_digest"
  | "invalid_digest"
  | "missing_pr_ref"
  | "missing_head_ref"
  | "invalid_head_ref"
  | "argus_not_accepted"
  | "ci_not_green"
  | "environment_not_allowlisted";

export type ReleaseCandidateValidation = {
  valid: boolean;
  errors: Array<{ code: ReleaseCandidateValidationCode; message: string }>;
  /** Echo of normalized allowlisted environment when valid. */
  environment?: AllowedReleaseEnvironment;
  /** Echo of the exact digest when valid. */
  imageDigest?: string;
};

export type DeployReceipt = {
  schemaVersion: typeof RELEASE_CONTRACT_SCHEMA_VERSION;
  kind: "deploy";
  receiptId: string;
  imageDigest: string;
  previousImageDigest: string | null;
  environment: AllowedReleaseEnvironment;
  service: string | null;
  prRef: string;
  headRef: string;
  argusAccepted: true;
  ciGreen: true;
  actor: string | null;
  idempotencyKey: string | null;
  deployedAt: string;
  state: "completed";
};

export type HealthSignal = {
  /** Stable name of the probe (e.g. service-health, http-ready). */
  name: string;
  healthy: boolean;
  /** ISO-8601 UTC observation time. Required for soak evaluation. */
  observedAt: string;
};

export type HealthVerdict = "healthy" | "unhealthy" | "unknown";

export type RollbackReceipt = {
  schemaVersion: typeof RELEASE_CONTRACT_SCHEMA_VERSION;
  kind: "rollback";
  receiptId: string;
  deployReceiptId: string;
  fromImageDigest: string;
  toImageDigest: string | null;
  environment: AllowedReleaseEnvironment;
  service: string | null;
  reason: string;
  healthVerdict: HealthVerdict;
  rolledBackAt: string;
  verified: boolean;
  state: "completed";
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedEnvironment(value: string): value is AllowedReleaseEnvironment {
  return (ALLOWED_RELEASE_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * Validate a Harbor release candidate. Fail closed when the exact digest is
 * missing/malformed or Argus has not accepted the head.
 */
export function validateReleaseCandidate(
  candidate: Partial<ReleaseCandidate> | null | undefined,
): ReleaseCandidateValidation {
  const errors: ReleaseCandidateValidation["errors"] = [];

  if (!candidate || typeof candidate !== "object") {
    return {
      valid: false,
      errors: [
        { code: "missing_digest", message: "Release candidate is required" },
        { code: "argus_not_accepted", message: "Argus acceptance is required (fail closed)" },
      ],
    };
  }

  const imageDigest = isNonEmptyString(candidate.imageDigest)
    ? candidate.imageDigest.trim()
    : "";
  if (!imageDigest) {
    errors.push({
      code: "missing_digest",
      message: "Exact image digest is required (fail closed)",
    });
  } else if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    errors.push({
      code: "invalid_digest",
      message:
        "imageDigest must be an exact pin: sha256:<64hex> or registry/path@sha256:<64hex>",
    });
  }

  if (!isNonEmptyString(candidate.prRef)) {
    errors.push({
      code: "missing_pr_ref",
      message: "prRef is required (PR number, URL, or refs/pull/N/head)",
    });
  }

  const headRef = isNonEmptyString(candidate.headRef) ? candidate.headRef.trim().toLowerCase() : "";
  if (!headRef) {
    errors.push({
      code: "missing_head_ref",
      message: "headRef (exact head commit SHA) is required",
    });
  } else if (!HEAD_REF_PATTERN.test(headRef)) {
    errors.push({
      code: "invalid_head_ref",
      message: "headRef must be a full git object id (40 or 64 hex chars)",
    });
  }

  if (candidate.argusAccepted !== true) {
    errors.push({
      code: "argus_not_accepted",
      message: "argusAccepted must be true (fail closed)",
    });
  }

  if (candidate.ciGreen !== true) {
    errors.push({
      code: "ci_not_green",
      message: "ciGreen must be true",
    });
  }

  const environment = isNonEmptyString(candidate.environment)
    ? candidate.environment.trim()
    : "";
  if (!environment || !isAllowedEnvironment(environment)) {
    errors.push({
      code: "environment_not_allowlisted",
      message: `environment must be one of: ${ALLOWED_RELEASE_ENVIRONMENTS.join(", ")}`,
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    environment: environment as AllowedReleaseEnvironment,
    imageDigest,
  };
}

export type BuildDeployReceiptInput = {
  receiptId: string;
  candidate: ReleaseCandidate;
  deployedAt?: string | Date;
  actor?: string | null;
};

/**
 * Build a deploy receipt from a validated candidate. Throws if the candidate
 * would not pass validation (callers should validate first).
 */
export function buildDeployReceipt(input: BuildDeployReceiptInput): DeployReceipt {
  const validation = validateReleaseCandidate(input.candidate);
  if (!validation.valid || !validation.environment || !validation.imageDigest) {
    const codes = validation.errors.map((e) => e.code).join(", ");
    throw new Error(`Cannot build deploy receipt for invalid release candidate: ${codes}`);
  }
  if (!isNonEmptyString(input.receiptId)) {
    throw new Error("receiptId is required");
  }

  const deployedAt =
    input.deployedAt instanceof Date
      ? input.deployedAt.toISOString()
      : isNonEmptyString(input.deployedAt)
        ? new Date(input.deployedAt).toISOString()
        : new Date().toISOString();

  const previous = isNonEmptyString(input.candidate.previousImageDigest)
    ? input.candidate.previousImageDigest.trim()
    : null;
  if (previous && !IMAGE_DIGEST_PATTERN.test(previous)) {
    throw new Error("previousImageDigest must be an exact digest pin when provided");
  }

  return {
    schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
    kind: "deploy",
    receiptId: input.receiptId.trim(),
    imageDigest: validation.imageDigest,
    previousImageDigest: previous,
    environment: validation.environment,
    service: isNonEmptyString(input.candidate.service) ? input.candidate.service.trim() : null,
    prRef: input.candidate.prRef.trim(),
    headRef: input.candidate.headRef.trim().toLowerCase(),
    argusAccepted: true,
    ciGreen: true,
    actor: isNonEmptyString(input.actor) ? input.actor.trim() : null,
    idempotencyKey: isNonEmptyString(input.candidate.idempotencyKey)
      ? input.candidate.idempotencyKey.trim()
      : null,
    deployedAt,
    state: "completed",
  };
}

/**
 * Evaluate soak/health signals.
 *
 * - any unhealthy signal → unhealthy
 * - no usable signals / incomplete soak → unknown
 * - all healthy and earliest observation is at least soakMs old → healthy
 */
export function evaluateHealth(
  signals: readonly HealthSignal[] | null | undefined,
  soakMs: number,
  nowMs: number = Date.now(),
): HealthVerdict {
  if (!Number.isFinite(soakMs) || soakMs < 0) {
    return "unknown";
  }
  if (!signals || signals.length === 0) {
    return "unknown";
  }

  let earliestHealthyMs: number | null = null;
  let sawHealthy = false;

  for (const signal of signals) {
    if (!signal || typeof signal !== "object") {
      return "unknown";
    }
    if (signal.healthy !== true && signal.healthy !== false) {
      return "unknown";
    }
    if (signal.healthy === false) {
      return "unhealthy";
    }
    const observedMs = Date.parse(signal.observedAt);
    if (Number.isNaN(observedMs)) {
      return "unknown";
    }
    sawHealthy = true;
    if (earliestHealthyMs === null || observedMs < earliestHealthyMs) {
      earliestHealthyMs = observedMs;
    }
  }

  if (!sawHealthy || earliestHealthyMs === null) {
    return "unknown";
  }

  if (nowMs - earliestHealthyMs < soakMs) {
    return "unknown";
  }

  return "healthy";
}

/**
 * Decide whether a deploy should roll back given health and the deploy receipt.
 * Only confirmed unhealthy health triggers rollback. Unknown means continue soak.
 */
export function shouldRollback(
  health: HealthVerdict,
  deployReceipt: DeployReceipt | null | undefined,
): boolean {
  if (!deployReceipt || deployReceipt.kind !== "deploy" || deployReceipt.state !== "completed") {
    return false;
  }
  if (
    deployReceipt.schemaVersion !== RELEASE_CONTRACT_SCHEMA_VERSION
    || !isNonEmptyString(deployReceipt.imageDigest)
  ) {
    return false;
  }
  return health === "unhealthy";
}

export type BuildRollbackReceiptInput = {
  receiptId: string;
  deployReceipt: DeployReceipt;
  healthVerdict: HealthVerdict;
  reason: string;
  rolledBackAt?: string | Date;
  /** When true, post-rollback verification passed. Defaults false (fail closed). */
  verified?: boolean;
  /** Override target pin; defaults to deployReceipt.previousImageDigest. */
  toImageDigest?: string | null;
};

/**
 * Build a rollback receipt bound to a prior deploy receipt.
 */
export function buildRollbackReceipt(input: BuildRollbackReceiptInput): RollbackReceipt {
  if (!isNonEmptyString(input.receiptId)) {
    throw new Error("receiptId is required");
  }
  if (!input.deployReceipt || input.deployReceipt.kind !== "deploy") {
    throw new Error("deployReceipt is required");
  }
  if (!isNonEmptyString(input.reason)) {
    throw new Error("reason is required");
  }

  const rolledBackAt =
    input.rolledBackAt instanceof Date
      ? input.rolledBackAt.toISOString()
      : isNonEmptyString(input.rolledBackAt)
        ? new Date(input.rolledBackAt).toISOString()
        : new Date().toISOString();

  const toImageDigest =
    input.toImageDigest !== undefined
      ? input.toImageDigest
      : input.deployReceipt.previousImageDigest;

  if (toImageDigest !== null && toImageDigest !== undefined) {
    if (!isNonEmptyString(toImageDigest) || !IMAGE_DIGEST_PATTERN.test(toImageDigest.trim())) {
      throw new Error("toImageDigest must be an exact digest pin when provided");
    }
  }

  return {
    schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
    kind: "rollback",
    receiptId: input.receiptId.trim(),
    deployReceiptId: input.deployReceipt.receiptId,
    fromImageDigest: input.deployReceipt.imageDigest,
    toImageDigest: toImageDigest === null || toImageDigest === undefined
      ? null
      : toImageDigest.trim(),
    environment: input.deployReceipt.environment,
    service: input.deployReceipt.service,
    reason: input.reason.trim(),
    healthVerdict: input.healthVerdict,
    rolledBackAt,
    verified: input.verified === true,
    state: "completed",
  };
}
