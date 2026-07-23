import type { ExecutionInvocationBudget } from "@paperclipai/adapter-utils/execution-envelope";
import {
  readBoundExecutionContext,
  type BoundExecutionContext,
} from "@paperclipai/adapter-utils/execution-envelope";

export const WORK_PREPARATION_CONTEXT_KEY = "paperclipWorkPreparation" as const;
export const WORK_PREPARATION_DENIED_CODE = "work_preparation.denied" as const;

export type WorkPreparationReason =
  | "missing_execution_context_packet"
  | "execution_context_packet_invalid"
  | "workspace_cwd_missing"
  | "workspace_repo_url_missing"
  | "workspace_repo_ref_missing"
  | "input_reservation_missing"
  | "input_reservation_insufficient"
  | "required_skill_unavailable";

export type WorkPreparationReceipt = {
  schemaVersion: "gloops.work-preparation-receipt.v1";
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  agentId: string;
  adapterType: string;
  model: string | null;
  required: boolean;
  decision: "ready" | "denied";
  fatalReasons: WorkPreparationReason[];
  packet: {
    valid: boolean;
    serializedBytes: number | null;
    approximateTokens: number | null;
    cacheIdentity: string | null;
  };
  workspace: {
    required: boolean;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    ready: boolean;
  };
  reservation: {
    present: boolean;
    maxInputTokens: number | null;
    fixedOverheadInputTokens: number | null;
    discretionaryInputTokens: number | null;
    minimumDiscretionaryInputTokens: number;
    ready: boolean;
  };
  skills: {
    required: string[];
    available: string[];
    missing: string[];
    ready: boolean;
  };
  evaluatedAt: string;
};

const DEFAULT_MINIMUM_DISCRETIONARY_INPUT_TOKENS = 4_000;

function nonEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function assessPacket(value: unknown): {
  packet: BoundExecutionContext | null;
  reason: WorkPreparationReason | null;
} {
  if (value === null || value === undefined) {
    return { packet: null, reason: "missing_execution_context_packet" };
  }
  const packet = readBoundExecutionContext(value);
  return packet
    ? { packet, reason: null }
    : { packet: null, reason: "execution_context_packet_invalid" };
}

export function assessWorkPreparation(input: {
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  agentId: string;
  adapterType: string;
  model?: string | null;
  required?: boolean;
  executionContext: unknown;
  invocationBudget: ExecutionInvocationBudget | null;
  workspace: {
    required: boolean;
    cwd?: string | null;
    repoUrl?: string | null;
    repoRef?: string | null;
  };
  skills?: {
    mentionedKeys: string[];
    runtimeEntries: Array<{
      key: string;
      sourceStatus?: "available" | "missing";
    }>;
  };
  minimumDiscretionaryInputTokens?: number;
  evaluatedAt?: Date;
}): WorkPreparationReceipt {
  const fatalReasons: WorkPreparationReason[] = [];
  const required = input.required ?? true;
  const packetAssessment = assessPacket(input.executionContext);
  if (required && packetAssessment.reason) fatalReasons.push(packetAssessment.reason);

  const cwd = nonEmpty(input.workspace.cwd);
  const repoUrl = nonEmpty(input.workspace.repoUrl);
  const repoRef = nonEmpty(input.workspace.repoRef);
  if (required && !cwd) fatalReasons.push("workspace_cwd_missing");
  if (required && input.workspace.required && !repoUrl) fatalReasons.push("workspace_repo_url_missing");
  if (required && input.workspace.required && !repoRef) fatalReasons.push("workspace_repo_ref_missing");

  const minimumDiscretionaryInputTokens = Math.max(
    0,
    Math.floor(input.minimumDiscretionaryInputTokens ?? DEFAULT_MINIMUM_DISCRETIONARY_INPUT_TOKENS),
  );
  const reservation = input.invocationBudget;
  if (required && !reservation) {
    fatalReasons.push("input_reservation_missing");
  }
  const packetTokens = packetAssessment.packet?.approximateTokens ?? 0;
  const fixedOverhead = reservation?.fixedOverheadInputTokens ?? packetTokens;
  const discretionary = reservation
    ? reservation.discretionaryInputTokens ?? Math.max(0, reservation.maxInputTokens - fixedOverhead)
    : null;
  const reservationReady = Boolean(
    reservation &&
    reservation.maxInputTokens >= packetTokens + minimumDiscretionaryInputTokens &&
    (discretionary ?? 0) >= minimumDiscretionaryInputTokens,
  );
  if (required && reservation && !reservationReady) {
    fatalReasons.push("input_reservation_insufficient");
  }

  const requiredSkillKeys = Array.from(new Set(
    (input.skills?.mentionedKeys ?? [])
      .map((key) => key.trim())
      .filter(Boolean),
  )).sort();
  const availableSkillKeys = new Set(
    (input.skills?.runtimeEntries ?? [])
      .filter((entry) => entry.sourceStatus === "available")
      .map((entry) => entry.key),
  );
  const availableSkills = requiredSkillKeys.filter((key) => availableSkillKeys.has(key));
  const missingSkills = requiredSkillKeys.filter((key) => !availableSkillKeys.has(key));
  if (required && missingSkills.length > 0) {
    fatalReasons.push("required_skill_unavailable");
  }

  const workspaceReady = Boolean(
    cwd && (!input.workspace.required || (repoUrl && repoRef)),
  );
  return {
    schemaVersion: "gloops.work-preparation-receipt.v1",
    runId: input.runId,
    issueId: nonEmpty(input.issueId),
    issueIdentifier: nonEmpty(input.issueIdentifier),
    agentId: input.agentId,
    adapterType: input.adapterType,
    model: nonEmpty(input.model),
    required,
    decision: fatalReasons.length === 0 ? "ready" : "denied",
    fatalReasons: Array.from(new Set(fatalReasons)),
    packet: {
      valid: Boolean(packetAssessment.packet),
      serializedBytes: packetAssessment.packet?.serializedBytes ?? null,
      approximateTokens: packetAssessment.packet?.approximateTokens ?? null,
      cacheIdentity: packetAssessment.packet?.cacheIdentity ?? null,
    },
    workspace: {
      required: input.workspace.required,
      cwd,
      repoUrl,
      repoRef,
      ready: workspaceReady,
    },
    reservation: {
      present: Boolean(reservation),
      maxInputTokens: reservation?.maxInputTokens ?? null,
      fixedOverheadInputTokens: reservation?.fixedOverheadInputTokens ?? null,
      discretionaryInputTokens: discretionary,
      minimumDiscretionaryInputTokens,
      ready: reservationReady,
    },
    skills: {
      required: requiredSkillKeys,
      available: availableSkills,
      missing: missingSkills,
      ready: missingSkills.length === 0,
    },
    evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
  };
}
