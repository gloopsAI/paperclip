import type { ExecutionInvocationBudget } from "@paperclipai/adapter-utils/execution-envelope";
import {
  readBoundExecutionContext,
  type BoundExecutionContext,
} from "@paperclipai/adapter-utils/execution-envelope";

export const WORK_PREPARATION_CONTEXT_KEY = "paperclipWorkPreparation" as const;
export const WORK_PREPARATION_DENIED_CODE = "work_preparation.denied" as const;
export const WORK_PREPARATION_SPLIT_CODE = "work_preparation.split" as const;

export type WorkPreparationReason =
  | "missing_execution_context_packet"
  | "execution_context_packet_invalid"
  | "workspace_cwd_missing"
  | "workspace_repo_url_missing"
  | "workspace_repo_ref_missing"
  | "workspace_not_writable"
  | "input_reservation_missing"
  | "input_reservation_insufficient"
  | "required_skill_unavailable"
  | "required_tool_unavailable"
  | "packet_byte_limit_exceeded"
  | "packet_token_limit_exceeded"
  | "phase_budget_plan_missing"
  | "phase_budget_insufficient"
  | "model_context_capacity_insufficient";

export type WorkPreparationReceipt = {
  schemaVersion: "gloops.work-preparation-receipt.v2";
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  agentId: string;
  adapterType: string;
  model: string | null;
  required: boolean;
  implementation: boolean;
  splitAllowed: boolean;
  decision: "ready" | "split" | "denied";
  fatalReasons: WorkPreparationReason[];
  splitReasons: WorkPreparationReason[];
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
    writable: boolean | null;
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
  tools: {
    required: string[];
    available: string[];
    missing: string[];
    ready: boolean;
  };
  capacity: {
    modelContextTokens: number | null;
    packetTokens: number | null;
    overheadTokens: number | null;
    totalRequiredTokens: number | null;
    fits: boolean;
  };
  phaseBudget: {
    present: boolean;
    ready: boolean;
  };
  evaluatedAt: string;
};

const DEFAULT_MINIMUM_DISCRETIONARY_INPUT_TOKENS = 4_000;
const HERMES_TOOLSETS = [
  "terminal",
  "file",
  "web",
  "browser",
  "code_execution",
  "vision",
  "mcp",
  "creative",
  "productivity",
] as const;
const CODING_ADAPTER_TYPES = new Set([
  "acpx_local",
  "claude_local",
  "codex_local",
  "gemini_local",
  "grok_local",
  "hermes_gateway",
  "hermes_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
]);

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return Array.from(new Set(
    values
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )).sort();
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

export function resolveWorkPreparationCapabilities(input: {
  adapterType: string;
  runtimeConfig: Record<string, unknown>;
  issueAdapterConfig?: Record<string, unknown> | null;
  implementation: boolean;
}) {
  const issueConfig = input.issueAdapterConfig ?? {};
  const explicitRequiredTools = stringList(
    issueConfig.paperclipRequiredToolsets ??
    input.runtimeConfig.paperclipRequiredToolsets,
  );
  const requiredTools = explicitRequiredTools.length > 0
    ? explicitRequiredTools
    : input.implementation
      ? ["file", "terminal"]
      : [];

  const explicitToolsets = stringList(
    input.runtimeConfig.toolsets ??
    input.runtimeConfig.enabledToolsets,
  );
  const availableTools = input.adapterType === "hermes_gateway" || input.adapterType === "hermes_local"
    ? explicitToolsets.length > 0
      ? explicitToolsets
      : [...HERMES_TOOLSETS]
    : CODING_ADAPTER_TYPES.has(input.adapterType)
      ? ["file", "terminal"]
      : input.adapterType === "process"
        ? ["terminal"]
        : [];

  const modelContextTokens =
    positiveInteger(issueConfig.paperclipModelContextTokens) ??
    positiveInteger(input.runtimeConfig.paperclipModelContextTokens) ??
    positiveInteger(input.runtimeConfig.modelContextTokens) ??
    positiveInteger(input.runtimeConfig.contextWindowTokens) ??
    positiveInteger(input.runtimeConfig.contextWindow);
  const explicitSplitAllowed =
    issueConfig.paperclipSplitOversizedAssignments ??
    input.runtimeConfig.paperclipSplitOversizedAssignments;

  return {
    requiredTools,
    availableTools,
    modelContextTokens,
    splitAllowed: typeof explicitSplitAllowed === "boolean"
      ? explicitSplitAllowed
      : input.implementation,
  };
}

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
    writable?: boolean | null;
  };
  assignment?: {
    implementation: boolean;
    splitAllowed?: boolean;
  };
  skills?: {
    mentionedKeys: string[];
    runtimeEntries: Array<{
      key: string;
      sourceStatus?: "available" | "missing";
    }>;
  };
  tools?: {
    mentionedKeys: string[];
    runtimeEntries: Array<{
      key: string;
      sourceStatus?: "available" | "missing";
    }>;
  };
  capacity?: {
    modelContextTokens?: number | null;
  };
  packetLimits?: {
    maxBytes?: number | null;
    maxTokens?: number | null;
  };
  minimumDiscretionaryInputTokens?: number;
  evaluatedAt?: Date;
}): WorkPreparationReceipt {
  const fatalReasons: WorkPreparationReason[] = [];
  const splitReasons: WorkPreparationReason[] = [];
  const required = input.required ?? true;
  const implementation = input.assignment?.implementation ?? false;
  const splitAllowed = input.assignment?.splitAllowed ?? implementation;
  const issueId = nonEmpty(input.issueId);

  const packetAssessment = assessPacket(input.executionContext);
  if (required && packetAssessment.reason) fatalReasons.push(packetAssessment.reason);

  if (required && packetAssessment.packet) {
    const maxBytes = input.packetLimits?.maxBytes ?? null;
    const maxTokens = input.packetLimits?.maxTokens ?? null;
    if (maxBytes != null && (packetAssessment.packet.serializedBytes ?? 0) > maxBytes) {
      fatalReasons.push("packet_byte_limit_exceeded");
    }
    if (maxTokens != null && (packetAssessment.packet.approximateTokens ?? 0) > maxTokens) {
      fatalReasons.push("packet_token_limit_exceeded");
    }
  }

  const cwd = nonEmpty(input.workspace.cwd);
  const repoUrl = nonEmpty(input.workspace.repoUrl);
  const repoRef = nonEmpty(input.workspace.repoRef);
  if (required && !cwd) fatalReasons.push("workspace_cwd_missing");
  if (required && input.workspace.required && !repoUrl) fatalReasons.push("workspace_repo_url_missing");
  if (required && input.workspace.required && !repoRef) fatalReasons.push("workspace_repo_ref_missing");
  if (required && implementation && input.workspace.writable !== true) {
    fatalReasons.push("workspace_not_writable");
  }

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

  const requiredToolKeys = Array.from(new Set(
    (input.tools?.mentionedKeys ?? [])
      .map((key) => key.trim())
      .filter(Boolean),
  )).sort();
  const availableToolKeys = new Set(
    (input.tools?.runtimeEntries ?? [])
      .filter((entry) => entry.sourceStatus === "available")
      .map((entry) => entry.key),
  );
  const availableTools = requiredToolKeys.filter((key) => availableToolKeys.has(key));
  const missingTools = requiredToolKeys.filter((key) => !availableToolKeys.has(key));
  if (required && missingTools.length > 0) {
    fatalReasons.push("required_tool_unavailable");
  }

  let phaseBudgetPresent = false;
  let phaseBudgetReady = false;
  if (required && implementation) {
    const phasePlan = reservation?.phasePlan ?? null;
    if (!phasePlan) {
      fatalReasons.push("phase_budget_plan_missing");
      phaseBudgetPresent = false;
      phaseBudgetReady = false;
    } else {
      phaseBudgetPresent = true;
      const phases = ["plan", "implement", "verify", "closeout"] as const;
      const allPhasesOk = phases.every((phase) =>
        phasePlan[phase].inputTokens > 0 &&
        phasePlan[phase].outputTokens > 0 &&
        phasePlan[phase].wallMs > 0,
      ) && phases.reduce((total, phase) => total + phasePlan[phase].turns, 0) > 0;
      if (!allPhasesOk) {
        fatalReasons.push("phase_budget_insufficient");
        phaseBudgetReady = false;
      } else {
        phaseBudgetReady = true;
      }
    }
  } else {
    const phasePlan = reservation?.phasePlan ?? null;
    phaseBudgetPresent = Boolean(phasePlan);
    phaseBudgetReady = true;
  }

  const modelContextTokens = input.capacity?.modelContextTokens ?? null;
  const overheadTokens = reservation?.fixedOverheadInputTokens ?? packetTokens;
  const totalRequiredTokens = reservation
    ? reservation.maxInputTokens + reservation.maxOutputTokens
    : packetTokens + minimumDiscretionaryInputTokens;
  let capacityFits = true;
  if (required && modelContextTokens != null && totalRequiredTokens > modelContextTokens) {
    if (implementation && splitAllowed) {
      splitReasons.push("model_context_capacity_insufficient");
    } else {
      fatalReasons.push("model_context_capacity_insufficient");
    }
    capacityFits = false;
  }

  let decision: "ready" | "split" | "denied";
  if (fatalReasons.length > 0) {
    decision = "denied";
  } else if (splitReasons.length > 0) {
    decision = "split";
  } else {
    decision = "ready";
  }

  const workspaceReady = Boolean(
    cwd &&
    (!input.workspace.required || (repoUrl && repoRef)) &&
    (!implementation || input.workspace.writable === true),
  );
  return {
    schemaVersion: "gloops.work-preparation-receipt.v2",
    runId: input.runId,
    issueId,
    issueIdentifier: nonEmpty(input.issueIdentifier),
    agentId: input.agentId,
    adapterType: input.adapterType,
    model: nonEmpty(input.model),
    required,
    implementation,
    splitAllowed,
    decision,
    fatalReasons: Array.from(new Set(fatalReasons)),
    splitReasons: Array.from(new Set(splitReasons)),
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
      writable: input.workspace.writable ?? null,
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
    tools: {
      required: requiredToolKeys,
      available: availableTools,
      missing: missingTools,
      ready: missingTools.length === 0,
    },
    capacity: {
      modelContextTokens,
      packetTokens: packetAssessment.packet?.approximateTokens ?? null,
      overheadTokens,
      totalRequiredTokens,
      fits: capacityFits,
    },
    phaseBudget: {
      present: phaseBudgetPresent,
      ready: phaseBudgetReady,
    },
    evaluatedAt: (input.evaluatedAt ?? new Date()).toISOString(),
  };
}
