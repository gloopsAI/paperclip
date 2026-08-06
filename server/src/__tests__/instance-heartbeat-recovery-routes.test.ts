import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

// Phase 1.3: the operator route always hardcodes `settleOnly: true` and
// never lets the request body override it (a caller-supplied `settleOnly`
// key must be ignored) — see the doc comment on
// instanceHeartbeatRecoveryRoutes for why. This test file only covers the
// route's auth gate and request/response contract; reapOrphanedRuns'
// settlement/accounting behavior itself is covered against a real database
// in heartbeat-reap-orphan-settlement.test.ts.

const mockReapOrphanedRuns = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  heartbeatService: () => ({
    reapOrphanedRuns: mockReapOrphanedRuns,
  }),
}));

const { instanceHeartbeatRecoveryRoutes } = await import("../routes/instance-heartbeat-recovery.js");

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", instanceHeartbeatRecoveryRoutes({} as never));
  app.use(errorHandler);
  return app;
}

const instanceAdminActor = {
  type: "board",
  userId: "admin-1",
  source: "session",
  isInstanceAdmin: true,
};

describe("instance heartbeat recovery routes", () => {
  beforeEach(() => {
    mockReapOrphanedRuns.mockReset();
    mockReapOrphanedRuns.mockResolvedValue({ reaped: 0, runIds: [] });
  });

  it("reaps with settleOnly:true for an instance admin and returns the result", async () => {
    mockReapOrphanedRuns.mockResolvedValue({ reaped: 2, runIds: ["run-1", "run-2"] });
    const app = createApp(instanceAdminActor);

    const res = await request(app).post("/api/instance/heartbeat-runs/reap-orphaned").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reaped: 2, runIds: ["run-1", "run-2"] });
    expect(mockReapOrphanedRuns).toHaveBeenCalledTimes(1);
    expect(mockReapOrphanedRuns).toHaveBeenCalledWith({ settleOnly: true });
  });

  it("passes through caller-supplied staleThresholdMs / noPidStaleThresholdMs overrides", async () => {
    const app = createApp(instanceAdminActor);

    await request(app)
      .post("/api/instance/heartbeat-runs/reap-orphaned")
      .send({ staleThresholdMs: 60000, noPidStaleThresholdMs: 120000 })
      .expect(200);

    expect(mockReapOrphanedRuns).toHaveBeenCalledWith({
      settleOnly: true,
      staleThresholdMs: 60000,
      noPidStaleThresholdMs: 120000,
    });
  });

  it("ignores a caller attempt to override settleOnly from the request body", async () => {
    const app = createApp(instanceAdminActor);

    await request(app)
      .post("/api/instance/heartbeat-runs/reap-orphaned")
      .send({ settleOnly: false })
      .expect(200);

    expect(mockReapOrphanedRuns).toHaveBeenCalledWith({ settleOnly: true });
  });

  it("ignores malformed threshold overrides (negative / non-numeric) instead of forwarding them", async () => {
    const app = createApp(instanceAdminActor);

    await request(app)
      .post("/api/instance/heartbeat-runs/reap-orphaned")
      .send({ staleThresholdMs: -1, noPidStaleThresholdMs: "not-a-number" })
      .expect(200);

    expect(mockReapOrphanedRuns).toHaveBeenCalledWith({ settleOnly: true });
  });

  it("rejects non-admin board users", async () => {
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });

    await request(app).post("/api/instance/heartbeat-runs/reap-orphaned").send({}).expect(403);
    expect(mockReapOrphanedRuns).not.toHaveBeenCalled();
  });

  it("rejects agent callers", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    });

    await request(app).post("/api/instance/heartbeat-runs/reap-orphaned").send({}).expect(403);
    expect(mockReapOrphanedRuns).not.toHaveBeenCalled();
  });

  it("allows local implicit board access", async () => {
    const app = createApp({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      isInstanceAdmin: false,
    });

    await request(app).post("/api/instance/heartbeat-runs/reap-orphaned").send({}).expect(200);
    expect(mockReapOrphanedRuns).toHaveBeenCalledTimes(1);
  });
});
