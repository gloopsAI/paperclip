import { createConnection } from "node:net";

export const CAMPAIGN_EPOCH_CONTEXT_KEY = "paperclipCampaignEpoch";
export const CAMPAIGN_DEADMAN_SCHEMA_VERSION = "gloops.campaign-deadman.v1";

export type CampaignDeadmanPolicy = {
  campaignId: string;
  socketPath: string;
  durationSeconds: number;
  timeoutMs: number;
};

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
  const durationSeconds = readPositiveInteger(
    env.PAPERCLIP_CAMPAIGN_DURATION_SECONDS,
    "PAPERCLIP_CAMPAIGN_DURATION_SECONDS",
    24 * 60 * 60,
    24 * 60 * 60,
    24 * 60 * 60,
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

