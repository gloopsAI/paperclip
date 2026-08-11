import { createConnection } from "node:net";
import {
  buildExecutionPhaseBudgetPlan,
  type ExecutionInvocationBudget,
} from "@paperclipai/adapter-utils/execution-envelope";

export const CAMPAIGN_EPOCH_CONTEXT_KEY = "paperclipCampaignEpoch";
export const CAMPAIGN_DEADMAN_SCHEMA_VERSION = "gloops.campaign-deadman.v1";

export type CampaignDeadmanPolicy = {
  campaignId: string;
  socketPath: string;
  durationSeconds: number;
  timeoutMs: number;
};

export type ExecutionCampaignPolicy =
  | { scope: "general"; deadman: null }
  | { scope: "campaign-bound"; deadman: CampaignDeadmanPolicy };

export type CampaignEpochReceipt = {
  schemaVersion: typeof CAMPAIGN_DEADMAN_SCHEMA_VERSION;
  campaignId: string;
  companyId: string;
  firstRunId: string;
  firstAdmittedAt: string;
  deadlineAt: string;
  durationSeconds: number;
  epochSha256: string;
};

type CampaignAdmissionRequest = {
  schemaVersion: typeof CAMPAIGN_DEADMAN_SCHEMA_VERSION;
  operation: "admit";
  campaignId: string;
  companyId: string;
  runId: string;
};

type CampaignAdmissionResponse = CampaignEpochReceipt & {
  allowed: true;
  status: "armed" | "active";
};

const CAMPAIGN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_RESPONSE_BYTES = 16 * 1024;

// The campaign duration is how long the control plane is permitted to run
// unsupervised: the broker's epoch is non-renewing, so the plane stops when the
// epoch lapses. The duration is therefore an enforced invariant with a bounded
// range, not an open tuning knob.
//
// The floor keeps an epoch long enough to be an execution window rather than a
// restart loop. The ceiling is the load-bearing half: it is what guarantees a
// human must re-authorize the plane periodically. An unbounded (or absent)
// maximum would let the dead-man be configured so that it never fires, which is
// the same as having no dead-man at all.
//
// CO-AUTHORITY: gloops-distribution/deploy/hermes/campaign-deadman.py declares
// the same three constants and the same validate_duration_seconds() check. That
// process owns the epoch; this one only asks to be admitted against it. THE TWO
// RANGES MUST MOVE TOGETHER. If they disagree, the server accepts a duration the
// broker refuses (the broker never arms, and every run is denied at admission
// instead of at configuration) or refuses one the broker would have honoured.
// A hard-pinned bound on one side and not the other is precisely the class of
// bug this bounded range was introduced to remove.
export const MIN_CAMPAIGN_DURATION_SECONDS = 1 * 60 * 60; // 1 hour
export const MAX_CAMPAIGN_DURATION_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const DEFAULT_CAMPAIGN_DURATION_SECONDS = 24 * 60 * 60; // 24 hours

function readPositiveInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${name} must be an integer`);
  }
  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

/**
 * Return the campaign duration, or refuse anything outside the bounded range.
 *
 * Mirror of `validate_duration_seconds()` in
 * gloops-distribution/deploy/hermes/campaign-deadman.py — same bounds, same
 * refusals, same message shape. Change one and you must change the other.
 */
export function validateDurationSeconds(
  value: unknown,
  name = "campaign duration",
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < MIN_CAMPAIGN_DURATION_SECONDS ||
    value > MAX_CAMPAIGN_DURATION_SECONDS
  ) {
    // Echo the offending value the way Python's `!r` does: quoted if it came
    // through as text, bare if it was already a number.
    const received = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new Error(
      `${name} must be a whole number of seconds between ` +
        `${MIN_CAMPAIGN_DURATION_SECONDS} and ${MAX_CAMPAIGN_DURATION_SECONDS} ` +
        `inclusive, received ${received}`,
    );
  }
  return value;
}

/**
 * Env adapter so the server refuses exactly what the broker refuses — the
 * counterpart of `duration_seconds_argument()` on the Python side. An unset or
 * empty variable keeps the historical 24h epoch.
 */
function readCampaignDurationSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CAMPAIGN_DURATION_SECONDS;
  }
  const trimmed = raw.trim();
  // Anything that is not a plain base-10 integer is handed to the validator
  // verbatim so it is reported the way it was written, as Python does.
  const parsed: unknown = /^-?[0-9]+$/.test(trimmed) ? Number(trimmed) : trimmed;
  return validateDurationSeconds(parsed, "PAPERCLIP_CAMPAIGN_DURATION_SECONDS");
}

export function parseCampaignDeadmanPolicy(
  env: Record<string, string | undefined> = process.env,
): CampaignDeadmanPolicy | null {
  const campaignId = env.PAPERCLIP_CAMPAIGN_ID?.trim() ?? "";
  const socketPath = env.PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET?.trim() ?? "";
  if (!campaignId && !socketPath) return null;
  if (!campaignId || !socketPath) {
    throw new Error(
      "PAPERCLIP_CAMPAIGN_ID and PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET must be configured together",
    );
  }
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    throw new Error("PAPERCLIP_CAMPAIGN_ID has an invalid format");
  }
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) {
    throw new Error("PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET must be an absolute Unix socket path");
  }
  const durationSeconds = readCampaignDurationSeconds(
    env.PAPERCLIP_CAMPAIGN_DURATION_SECONDS,
  );
  const timeoutMs = readPositiveInteger(
    env.PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS,
    "PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS",
    2_000,
    100,
    10_000,
  );
  return { campaignId, socketPath, durationSeconds, timeoutMs };
}

export function parseExecutionCampaignPolicy(
  env: Record<string, string | undefined> = process.env,
): ExecutionCampaignPolicy {
  const configuredScope = env.PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE?.trim() ?? "";
  const hasLegacyCampaignEnvelope = Boolean(
    env.PAPERCLIP_CAMPAIGN_ID?.trim() || env.PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET?.trim(),
  );
  const scope = configuredScope || (hasLegacyCampaignEnvelope ? "campaign-bound" : "general");
  if (scope !== "general" && scope !== "campaign-bound") {
    throw new Error("PAPERCLIP_EXECUTION_CAMPAIGN_SCOPE must be general or campaign-bound");
  }
  if (scope === "general") {
    const forbidden = [
      "PAPERCLIP_CAMPAIGN_ID",
      "PAPERCLIP_CAMPAIGN_DEADMAN_SOCKET",
      "PAPERCLIP_CAMPAIGN_DURATION_SECONDS",
      "PAPERCLIP_CAMPAIGN_DEADMAN_TIMEOUT_MS",
    ].filter((name) => env[name]?.trim());
    if (forbidden.length > 0) {
      throw new Error(
        `general execution must not inherit campaign configuration: ${forbidden.join(", ")}`,
      );
    }
    return { scope: "general", deadman: null };
  }
  const deadman = parseCampaignDeadmanPolicy(env);
  if (!deadman) {
    throw new Error("campaign-bound execution requires a complete campaign deadman policy");
  }
  return { scope: "campaign-bound", deadman };
}

export function readCampaignEpochReceipt(value: unknown): CampaignEpochReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== CAMPAIGN_DEADMAN_SCHEMA_VERSION ||
    typeof candidate.campaignId !== "string" ||
    typeof candidate.companyId !== "string" ||
    typeof candidate.firstRunId !== "string" ||
    typeof candidate.firstAdmittedAt !== "string" ||
    typeof candidate.deadlineAt !== "string" ||
    typeof candidate.durationSeconds !== "number" ||
    typeof candidate.epochSha256 !== "string"
  ) return null;
  return candidate as CampaignEpochReceipt;
}

/**
 * Bind a campaign run's actual adapter wall clock to its immutable epoch.
 * General execution passes through unchanged. Campaign-bound execution refuses
 * a missing receipt/budget and cannot run beyond the broker-issued deadline.
 */
export function enforceCampaignExecutionDeadline(input: {
  policy: ExecutionCampaignPolicy;
  receipt: unknown;
  budget: ExecutionInvocationBudget | null;
  now?: Date;
}): ExecutionInvocationBudget | null {
  if (input.policy.scope === "general") return input.budget;
  const receipt = readCampaignEpochReceipt(input.receipt);
  if (!receipt || receipt.campaignId !== input.policy.deadman.campaignId) {
    throw new Error("campaign-bound execution requires its exact claim-time epoch receipt");
  }
  if (!input.budget) {
    throw new Error("campaign-bound execution requires a strict adapter wall-time budget");
  }
  const deadlineMs = Date.parse(receipt.deadlineAt);
  const remainingMs = deadlineMs - (input.now ?? new Date()).getTime();
  if (!Number.isFinite(deadlineMs) || remainingMs <= 0) {
    throw new Error("campaign epoch expired before adapter invocation");
  }
  const maxWallMs = Math.min(input.budget.maxWallMs, Math.floor(remainingMs));
  if (maxWallMs <= 0) {
    throw new Error("campaign epoch expired before adapter invocation");
  }
  return {
    ...input.budget,
    maxWallMs,
    phasePlan: buildExecutionPhaseBudgetPlan({
      inputTokens: input.budget.discretionaryInputTokens ?? input.budget.maxInputTokens,
      outputTokens: input.budget.maxOutputTokens,
      turns: input.budget.maxTurns,
      toolCalls: input.budget.maxToolCalls,
      wallMs: maxWallMs,
    }),
  };
}

function requestOverUnixSocket(
  policy: CampaignDeadmanPolicy,
  request: CampaignAdmissionRequest,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: policy.socketPath });
    let settled = false;
    let response = "";

    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setTimeout(policy.timeoutMs);
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("campaign deadman response exceeded the size limit"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(response.slice(0, newline)));
      } catch {
        finish(new Error("campaign deadman returned invalid JSON"));
      }
    });
    socket.once("timeout", () => {
      finish(new Error("campaign deadman request timed out"));
    });
    socket.once("error", (error) => {
      finish(new Error(`campaign deadman is unavailable: ${error.message}`));
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("campaign deadman closed without a response"));
    });
  });
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("campaign deadman returned an invalid response");
  }
  return value as Record<string, unknown>;
}

export async function admitCampaignRun(
  policy: CampaignDeadmanPolicy,
  input: { companyId: string; runId: string; now?: Date },
  requester: (
    policy: CampaignDeadmanPolicy,
    request: CampaignAdmissionRequest,
  ) => Promise<unknown> = requestOverUnixSocket,
): Promise<CampaignEpochReceipt> {
  const request: CampaignAdmissionRequest = {
    schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
    operation: "admit",
    campaignId: policy.campaignId,
    companyId: input.companyId,
    runId: input.runId,
  };
  const response = readRecord(await requester(policy, request));
  if (response.allowed !== true) {
    const reason = typeof response.reason === "string"
      ? response.reason
      : "campaign admission was denied";
    throw new Error(`campaign deadman denied admission: ${reason}`);
  }
  // Everything below compares the broker's receipt against the policy this
  // process holds. These stay EXACT even though the duration is now
  // configurable: they are not bounds checks, they are the agreement check that
  // both halves are running the same epoch. A receipt whose duration or
  // deadline span differs from the policy means the broker was started with a
  // different --duration-seconds than this server was configured with, which is
  // exactly the drift the bounded range exists to surface. Widening these into
  // a range would hide it.
  if (
    response.schemaVersion !== CAMPAIGN_DEADMAN_SCHEMA_VERSION ||
    response.status !== "armed" && response.status !== "active" ||
    response.campaignId !== policy.campaignId ||
    response.companyId !== input.companyId ||
    typeof response.firstRunId !== "string" ||
    typeof response.firstAdmittedAt !== "string" ||
    typeof response.deadlineAt !== "string" ||
    response.durationSeconds !== policy.durationSeconds ||
    typeof response.epochSha256 !== "string" ||
    !SHA256_PATTERN.test(response.epochSha256)
  ) {
    throw new Error("campaign deadman returned a mismatched epoch receipt");
  }
  const firstAdmittedAtMs = Date.parse(response.firstAdmittedAt);
  const deadlineAtMs = Date.parse(response.deadlineAt);
  const nowMs = (input.now ?? new Date()).getTime();
  if (
    !Number.isFinite(firstAdmittedAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    deadlineAtMs - firstAdmittedAtMs !== policy.durationSeconds * 1_000 ||
    deadlineAtMs <= nowMs
  ) {
    throw new Error("campaign deadman returned an invalid or expired deadline");
  }

  return {
    schemaVersion: CAMPAIGN_DEADMAN_SCHEMA_VERSION,
    campaignId: policy.campaignId,
    companyId: input.companyId,
    firstRunId: response.firstRunId,
    firstAdmittedAt: response.firstAdmittedAt,
    deadlineAt: response.deadlineAt,
    durationSeconds: policy.durationSeconds,
    epochSha256: response.epochSha256,
  };
}

export async function admitExecutionCampaign(
  policy: ExecutionCampaignPolicy,
  input: { companyId: string; runId: string; now?: Date },
  admitter: typeof admitCampaignRun = admitCampaignRun,
): Promise<CampaignEpochReceipt | null> {
  if (policy.scope === "general") return null;
  return admitter(policy.deadman, input);
}
