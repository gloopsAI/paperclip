import { describe, expect, it } from "vitest";
import { PAPERCLIP_EXECUTION_RECEIPT_KEY } from "@paperclipai/adapter-utils/execution-envelope";
import { buildRunTimelineTruth } from "./run-timeline-truth.js";

describe("buildRunTimelineTruth", () => {
  it("projects review, owners, retry epoch and exact publication OIDs without raw context", () => {
    const truth = buildRunTimelineTruth({
      run: {
        runId: "run-1",
        status: "succeeded",
        agentId: "agent-current",
        responsibleUserId: "user-current",
        retryOfRunId: "run-0",
        scheduledRetryAttempt: 2,
        contextSnapshot: {
          intendedAgentId: "agent-intended",
          executionWorkspaceId: "workspace-1",
          secret: "must-not-project",
          [PAPERCLIP_EXECUTION_RECEIPT_KEY]: {
            verification: { review: { status: "accepted", headSha: "b".repeat(40) } },
          },
        },
      },
      mutationReceipt: {
        id: "receipt-1",
        state: "reconciled_success",
        expectedOldOid: "a".repeat(40),
        expectedNewOid: "b".repeat(40),
        remoteOldOid: "a".repeat(40),
        remoteNewOid: "b".repeat(40),
        brokerReceiptDigest: "sha256:receipt",
        terminalAt: "2026-08-13T12:00:00.000Z",
      },
      settlement: null,
    });

    expect(truth).toMatchObject({
      stage: "publication",
      intendedOwner: { agentId: "agent-intended", userId: "user-current" },
      currentOwner: { agentId: "agent-current", userId: "user-current" },
      retryEpoch: 2,
      workspaceId: "workspace-1",
      review: { status: "accepted", headSha: "b".repeat(40) },
      exactOids: { expectedOld: "a".repeat(40), remoteNew: "b".repeat(40) },
      publication: { state: "reconciled_success" },
    });
    expect(JSON.stringify(truth)).not.toContain("must-not-project");
  });

  it("makes rollback the visible terminal stage and names the recovery owner", () => {
    const truth = buildRunTimelineTruth({
      run: { runId: "run-2", status: "failed", agentId: "agent-1" },
      recoveryAction: {
        ownerAgentId: "agent-recovery",
        ownerUserId: null,
        status: "active",
        attemptCount: 1,
        nextAction: "Repair the route",
      },
      deployment: { action: "deployment.completed", status: "healthy", at: "2026-08-13T12:00:00Z" },
      rollback: { action: "rollback.completed", status: "restored", at: "2026-08-13T12:05:00Z" },
    });

    expect(truth.stage).toBe("rolled_back");
    expect(truth.recoveryOwner).toMatchObject({ agentId: "agent-recovery", nextAction: "Repair the route" });
    expect(truth.rollback?.status).toBe("restored");
  });
});
