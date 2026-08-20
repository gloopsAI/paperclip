import { createHash } from "node:crypto";
import type { ExecutionInvocationBudget } from "@paperclipai/adapter-utils/execution-envelope";
import type { SubscriptionRouteProvider } from "@paperclipai/adapter-utils/execution-envelope";
import type { ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";

export const WORKFORCE_CAPACITY_CONTEXT_KEY = "gloopsWorkforceCapacity" as const;
export const WORKFORCE_CAPACITY_DENIED_CODE = "workforce_capacity.denied" as const;

export const DURABLE_WORKFORCE_MODELS = ["gpt-5.6-luna", "gpt-5.6-terra"] as const;

export type WorkforceLane = "durable_bench" | "supplemental" | "burst" | "non_model" | "unsupported";
export type WorkforceProvider = SubscriptionRouteProvider | "non_model" | "unsupported";
export type WorkforceCapacityReason =
  | "issue_binding_missing"
  | "invocation_budget_missing"
  | "phase_budget_missing"
  | "phase_budget_invalid"
  | "capacity_probe_failed"
  | "capacity_snapshot_missing"
  | "capacity_exhausted"
  | "unsupported_model_route";

export type WorkforceRoute = {
  lane: WorkforceLane;
  provider: WorkforceProvider;
  adapterType: string;
  model: string | null;
};

export type WorkforceCapacityReceipt = {
  schemaVersion: "gloops.workforce-capacity-receipt.v1";
  decision: "ready" | "denied" | "not_applicable";
  reasons: WorkforceCapacityReason[];
  route: WorkforceRoute;
  binding: {
    runId: string;
    issueId: string | null;
    agentId: string;
    budgetId: string | null;
    reservationId: string | null;
  };
  lease: {
    id: string;
    issuedAt: string;
    expiresAt: string;
    digest: string;
  } | null;
  metrics: {
    rawTokenReservation: {
      maxInputTokens: number | null;
      maxOutputTokens: number | null;
      provenance: "reservation" | "unavailable";
    };
    subscriptionCapacity: {
      source: "provider_quota_window" | "bounded_execution_budget" | "unavailable";
      state: "available" | "exhausted" | "unknown";
      maxUsedPercent: number | null;
      windows: QuotaWindow[];
    };
    quality: {
      source: "direct_selection" | "durable_default" | "supplemental" | "not_applicable";
      reason: string | null;
    };
    queue: {
      latencyMs: number;
    };
    billing: {
      usedForAdmission: false;
      billedCostCents: null;
      note: "billed cost is measured separately from capacity admission";
    };
  };
  evaluatedAt: string;
};

export function workforceCapacityRequiredForRoute(input: {
  route: WorkforceRoute;
  runtimeRequired?: unknown;
  issueRequired?: unknown;
}): boolean {
  // Durable workforce models are governed by capacity admission by default.
  // This source-controlled binding avoids depending on a live config mutation
  // for Wren/Argus-class roles and automatically covers future durable roles.
  // Existing non-durable routes remain opt-in for backwards compatibility.
  return input.route.lane === "durable_bench" ||
    input.runtimeRequired === true ||
    input.issueRequired === true;
}

function normalized(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function classifyWorkforceRoute(adapterType: string, model?: string | null): WorkforceRoute {
  const adapter = normalized(adapterType);
  const selectedModel = normalized(model);
  if (adapter === "codex_local" && selectedModel === "gpt-5.6-luna") {
    return { lane: "durable_bench", provider: "luna", adapterType, model: selectedModel };
  }
  if (adapter === "codex_local" && selectedModel === "gpt-5.6-terra") {
    return { lane: "durable_bench", provider: "terra", adapterType, model: selectedModel };
  }
  if (adapter === "hermes_gateway" || adapter === "hermes_local") {
    return { lane: "supplemental", provider: "ollama", adapterType, model: selectedModel || null };
  }
  if (adapter === "grok_local") {
    return { lane: "burst", provider: "grok", adapterType, model: selectedModel || null };
  }
  if (adapter === "codex_local") {
    return { lane: "burst", provider: "codex", adapterType, model: selectedModel || null };
  }
  if (/(?:claude|cursor|gemini|openclaw|opencode|pi)_?/.test(adapter)) {
    return { lane: "unsupported", provider: "unsupported", adapterType, model: selectedModel || null };
  }
  return { lane: "non_model", provider: "non_model", adapterType, model: selectedModel || null };
}

export async function probeWorkforceCapacity(
  provider: string,
  probe: (() => Promise<ProviderQuotaResult>) | null | undefined,
  timeoutMs = 5_000,
): Promise<ProviderQuotaResult | null> {
  if (!probe) return null;
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      probe().catch((error) => ({
        provider,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
        windows: [],
      })),
      new Promise<ProviderQuotaResult>((resolve) => {
        timeout = setTimeout(() => resolve({
          provider,
          ok: false,
          error: `capacity probe timed out after ${timeoutMs}ms`,
          windows: [],
        }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function validPhaseBudget(budget: ExecutionInvocationBudget | null): "missing" | "invalid" | "ready" {
  if (!budget?.phasePlan) return "missing";
  const phases = ["plan", "implement", "verify", "closeout"] as const;
  return phases.every((phase) => {
    const allocation = budget.phasePlan![phase];
    return allocation.inputTokens > 0 && allocation.outputTokens > 0 && allocation.wallMs > 0;
  }) && phases.reduce((total, phase) => total + budget.phasePlan![phase].turns, 0) > 0
    ? "ready"
    : "invalid";
}

function quotaState(
  route: WorkforceRoute,
  quota: ProviderQuotaResult | null,
  maxUsedPercent: number,
) {
  if (!quota) {
    if (route.lane === "durable_bench") {
      return {
        source: "unavailable" as const,
        state: "unknown" as const,
        maxUsedPercent: null,
        windows: [] as QuotaWindow[],
        reason: "capacity_snapshot_missing" as WorkforceCapacityReason,
      };
    }
    return {
      source: "bounded_execution_budget" as const,
      state: "available" as const,
      maxUsedPercent: null,
      windows: [] as QuotaWindow[],
      reason: null,
    };
  }
  if (!quota.ok) {
    return {
      source: "unavailable" as const,
      state: "unknown" as const,
      maxUsedPercent: null,
      windows: [] as QuotaWindow[],
      reason: "capacity_probe_failed" as WorkforceCapacityReason,
    };
  }
  const reported = quota.windows
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (reported.length === 0) {
    return {
      source: "unavailable" as const,
      state: "unknown" as const,
      maxUsedPercent: null,
      windows: quota.windows,
      reason: "capacity_snapshot_missing" as WorkforceCapacityReason,
    };
  }
  const observedMax = Math.max(...reported);
  return {
    source: "provider_quota_window" as const,
    state: observedMax >= maxUsedPercent ? "exhausted" as const : "available" as const,
    maxUsedPercent: observedMax,
    windows: quota.windows,
    reason: observedMax >= maxUsedPercent
      ? "capacity_exhausted" as WorkforceCapacityReason
      : null,
  };
}

function stableDigest(value: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function assessWorkforceCapacity(input: {
  runId: string;
  issueId?: string | null;
  agentId: string;
  adapterType: string;
  model?: string | null;
  invocationBudget: ExecutionInvocationBudget | null;
  context?: Record<string, unknown>;
  quota?: ProviderQuotaResult | null;
  required?: boolean;
  queuedAt?: Date | null;
  evaluatedAt?: Date;
  maxUsedPercent?: number;
}): WorkforceCapacityReceipt {
  const evaluatedAt = input.evaluatedAt ?? new Date();
  const issuedAt = evaluatedAt.toISOString();
  const required = input.required ?? true;
  const route = classifyWorkforceRoute(input.adapterType, input.model);
  const issueId = input.issueId?.trim() || null;
  const reasons: WorkforceCapacityReason[] = [];
  const budget = input.invocationBudget;
  const maxUsedPercent = Math.min(100, Math.max(1, input.maxUsedPercent ?? 95));

  if (!required || route.lane === "non_model") {
    return buildReceipt("not_applicable", reasons, null);
  }
  if (route.lane === "unsupported") reasons.push("unsupported_model_route");
  if (!issueId) reasons.push("issue_binding_missing");
  if (!budget) reasons.push("invocation_budget_missing");
  const phaseBudget = validPhaseBudget(budget);
  if (phaseBudget === "missing") reasons.push("phase_budget_missing");
  if (phaseBudget === "invalid") reasons.push("phase_budget_invalid");

  const capacity = quotaState(route, input.quota ?? null, maxUsedPercent);
  if (capacity.reason) reasons.push(capacity.reason);
  const decision = reasons.length > 0 ? "denied" as const : "ready" as const;
  const binding = {
    runId: input.runId,
    issueId,
    agentId: input.agentId,
    budgetId: budget?.budgetId ?? null,
    reservationId: budget?.reservationId ?? null,
  };
  const expiresAt = new Date(evaluatedAt.getTime() + 15 * 60_000).toISOString();
  const leaseBody = decision === "ready"
    ? { schemaVersion: "gloops.workforce-capacity-lease.v1", binding, route, issuedAt, expiresAt }
    : null;
  const lease = leaseBody
    ? {
        id: createHash("sha256").update(`${binding.runId}:${binding.reservationId}:${route.provider}`).digest("hex"),
        issuedAt,
        expiresAt,
        digest: stableDigest(leaseBody),
      }
    : null;
  return buildReceipt(decision, Array.from(new Set(reasons)), lease, capacity);

  function buildReceipt(
    receiptDecision: WorkforceCapacityReceipt["decision"],
    receiptReasons: WorkforceCapacityReason[],
    receiptLease: WorkforceCapacityReceipt["lease"],
    capacityMetrics = quotaState(route, input.quota ?? null, maxUsedPercent),
    qualityReason: string | null = null,
  ): WorkforceCapacityReceipt {
    return {
      schemaVersion: "gloops.workforce-capacity-receipt.v1",
      decision: receiptDecision,
      reasons: receiptReasons,
      route,
      binding: {
        runId: input.runId,
        issueId,
        agentId: input.agentId,
        budgetId: budget?.budgetId ?? null,
        reservationId: budget?.reservationId ?? null,
      },
      lease: receiptLease,
      metrics: {
        rawTokenReservation: {
          maxInputTokens: budget?.maxInputTokens ?? null,
          maxOutputTokens: budget?.maxOutputTokens ?? null,
          provenance: budget ? "reservation" : "unavailable",
        },
        subscriptionCapacity: {
          source: capacityMetrics.source,
          state: capacityMetrics.state,
          maxUsedPercent: capacityMetrics.maxUsedPercent,
          windows: capacityMetrics.windows,
        },
        quality: {
          source: route.lane === "burst"
            ? "direct_selection"
            : route.lane === "durable_bench"
              ? "durable_default"
              : route.lane === "supplemental"
                ? "supplemental"
                : "not_applicable",
          reason: qualityReason,
        },
        queue: {
          latencyMs: input.queuedAt
            ? Math.max(0, evaluatedAt.getTime() - input.queuedAt.getTime())
            : 0,
        },
        billing: {
          usedForAdmission: false,
          billedCostCents: null,
          note: "billed cost is measured separately from capacity admission",
        },
      },
      evaluatedAt: issuedAt,
    };
  }
}
