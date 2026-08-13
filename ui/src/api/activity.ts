import type { ActivityEvent, RunLivenessState } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export type { RunLivenessState } from "@paperclipai/shared";

export interface RunForIssue {
  runId: string;
  status: string;
  agentId: string;
  adapterType: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  invocationSource: string;
  responsibleUserId?: string | null;
  errorCode?: string | null;
  usageJson: Record<string, unknown> | null;
  resultJson: Record<string, unknown> | null;
  logBytes?: number | null;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | null;
  scheduledRetryAttempt?: number;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
  livenessState?: RunLivenessState | null;
  livenessReason?: string | null;
  continuationAttempt?: number;
  lastUsefulActionAt?: string | null;
  nextAction?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
  truth?: {
    stage: "queued" | "executing" | "retry_wait" | "recovery" | "review" | "publication" | "deployed" | "rolled_back" | "settled" | "failed";
    intendedOwner: { agentId: string | null; userId: string | null };
    currentOwner: { agentId: string | null; userId: string | null };
    recoveryOwner: {
      agentId: string | null;
      userId: string | null;
      status: string;
      attempt: number;
      nextAction: string;
    } | null;
    retryEpoch: number;
    retryOfRunId: string | null;
    workspaceId: string | null;
    review: { status: string | null; headSha: string | null } | null;
    exactOids: {
      expectedOld: string | null;
      expectedNew: string | null;
      remoteOld: string | null;
      remoteNew: string | null;
    } | null;
    publication: {
      receiptId: string;
      state: string;
      brokerReceiptDigest: string | null;
      terminalAt: string | Date | null;
    } | null;
    deployment: { action: string; status: string | null; at: string | Date } | null;
    rollback: { action: string; status: string | null; at: string | Date } | null;
    terminalReceipt: {
      id: string;
      schemaVersion: string;
      terminalStatus: string;
      mutationDisposition: string;
      brokerReceiptDigest: string | null;
      settledAt: string | Date;
    } | null;
  };
  environment?: {
    id: string;
    name: string;
    driver: string;
  } | null;
  environmentLease?: {
    id: string;
    status: string;
    leasePolicy: string;
    provider: string | null;
    providerLeaseId: string | null;
    executionWorkspaceId: string | null;
    workspacePath: string | null;
    failureReason: string | null;
    cleanupStatus: string | null;
    acquiredAt: string | Date;
    releasedAt: string | Date | null;
  } | null;
}

export interface IssueForRun {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
}

export const activityApi = {
  list: (
    companyId: string,
    filters?: { entityType?: string; entityId?: string; agentId?: string; limit?: number },
    options?: RequestOptions,
  ) => {
    const params = new URLSearchParams();
    if (filters?.entityType) params.set("entityType", filters.entityType);
    if (filters?.entityId) params.set("entityId", filters.entityId);
    if (filters?.agentId) params.set("agentId", filters.agentId);
    if (filters?.limit) params.set("limit", String(filters.limit));
    const qs = params.toString();
    return api.get<ActivityEvent[]>(`/companies/${companyId}/activity${qs ? `?${qs}` : ""}`, options);
  },
  forIssue: (issueId: string) => api.get<ActivityEvent[]>(`/issues/${issueId}/activity`),
  runsForIssue: (issueId: string) => api.get<RunForIssue[]>(`/issues/${issueId}/runs`),
  issuesForRun: (runId: string) => api.get<IssueForRun[]>(`/heartbeat-runs/${runId}/issues`),
};
