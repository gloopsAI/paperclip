import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { taskBridgeAgentKeyScopeSchema } from "./agent.js";

describe("taskBridgeAgentKeyScopeSchema", () => {
  it("accepts a projectless-consultation-only boundary with an explicit assignee allowlist", () => {
    expect(taskBridgeAgentKeyScopeSchema.parse({
      kind: "task_bridge",
      allowProjectlessConsultations: true,
      allowedAssigneeAgentIds: [randomUUID()],
    })).toMatchObject({ allowProjectlessConsultations: true });
  });

  it("rejects an unbounded, mixed, or assignee-less projectless consultation scope", () => {
    expect(taskBridgeAgentKeyScopeSchema.safeParse({ kind: "task_bridge" }).success).toBe(false);
    expect(taskBridgeAgentKeyScopeSchema.safeParse({
      kind: "task_bridge",
      allowProjectlessConsultations: true,
    }).success).toBe(false);
    expect(taskBridgeAgentKeyScopeSchema.safeParse({
      kind: "task_bridge",
      allowProjectlessConsultations: true,
      projectId: randomUUID(),
      allowedAssigneeAgentIds: [randomUUID()],
    }).success).toBe(false);
  });
});
