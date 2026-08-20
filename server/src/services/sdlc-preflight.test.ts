import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDUCT_PROJECT_WORKSPACE_ID,
  evaluateInductSdlcGate,
  evaluatePlaneStatusFromEnv,
  getInductProjectWorkspaceIds,
  getSdlcPreflightMode,
  isInductImplementTarget,
  looksImplementPacket,
  SDLC_PREFLIGHT_REASON,
} from "./sdlc-preflight.js";

const SHA = "c2435bb0a88d26b73dc2b3d26abd0bc406076dd3";
const INDUCT_PWS = DEFAULT_INDUCT_PROJECT_WORKSPACE_ID;

function hoursFromNow(hours: number, now = new Date()): string {
  return new Date(now.getTime() + hours * 3600 * 1000).toISOString();
}

describe("getSdlcPreflightMode", () => {
  it("defaults off outside tests when unset", () => {
    expect(getSdlcPreflightMode({ PAPERCLIP_SDLC_PREFLIGHT: "" })).toBe("off");
  });

  it("off under vitest when unset", () => {
    expect(getSdlcPreflightMode({ VITEST: "true" })).toBe("off");
  });

  it("off under NODE_ENV=test when unset", () => {
    expect(getSdlcPreflightMode({ NODE_ENV: "test" })).toBe("off");
  });

  it("honors explicit observe/enforce/off", () => {
    expect(getSdlcPreflightMode({ PAPERCLIP_SDLC_PREFLIGHT: "observe" })).toBe("observe");
    expect(getSdlcPreflightMode({ PAPERCLIP_SDLC_PREFLIGHT: "enforce", VITEST: "true" })).toBe(
      "enforce",
    );
    expect(getSdlcPreflightMode({ PAPERCLIP_SDLC_PREFLIGHT: "off" })).toBe("off");
  });

  it("unknown values fall back to enforce", () => {
    expect(getSdlcPreflightMode({ PAPERCLIP_SDLC_PREFLIGHT: "maybe" })).toBe("off");
  });
});

describe("evaluatePlaneStatusFromEnv", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");

  it("ok when no campaign deadline and not expecting swarm", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        HEARTBEAT_SCHEDULER_ENABLED: "false",
        PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(true);
    expect(p.criticalCodes).toEqual([]);
    expect(p.hostPreflight).toBeNull();
  });

  it("flags campaign.deadline_lt_6h when under min hours", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CAMPAIGN_DEADLINE_AT: hoursFromNow(3, now),
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(false);
    expect(p.criticalCodes).toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H);
    expect(p.hoursRemaining).toBeLessThan(6);
  });

  it("warns campaign.deadline_lt_12h between 6 and 12 hours", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CAMPAIGN_DEADLINE_AT: hoursFromNow(8, now),
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(true);
    expect(p.warningCodes).toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_12H);
    expect(p.criticalCodes).not.toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H);
  });

  it("ok when deadline comfortably above 12h", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CAMPAIGN_DEADLINE_AT: hoursFromNow(20, now),
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(true);
    expect(p.codes).toEqual([]);
  });

  it("does not emit deadline codes when PAPERCLIP_CAMPAIGN_DEADLINE_AT unset", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CAMPAIGN_ID: "controlled-swarm-repair-cell-x",
        PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "true",
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.criticalCodes).not.toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_DEADLINE_LT_6H);
    expect(p.criticalCodes).not.toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_MISSING_EPOCH);
  });

  it("flags campaign.missing_epoch when commissioned and require deadline", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "true",
        PAPERCLIP_SDLC_REQUIRE_DEADLINE_AT: "true",
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(false);
    expect(p.criticalCodes).toContain(SDLC_PREFLIGHT_REASON.CAMPAIGN_MISSING_EPOCH);
  });

  it("flags scheduler.true", () => {
    const p = evaluatePlaneStatusFromEnv(
      { HEARTBEAT_SCHEDULER_ENABLED: "true" },
      { now },
    );
    expect(p.ok).toBe(false);
    expect(p.criticalCodes).toContain(SDLC_PREFLIGHT_REASON.SCHEDULER_TRUE);
    expect(p.schedulerEnabled).toBe(true);
  });

  it("flags commissioned.false when campaign id present", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_CAMPAIGN_ID: "controlled-swarm-repair-cell-x",
        PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "false",
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(false);
    expect(p.criticalCodes).toContain(SDLC_PREFLIGHT_REASON.COMMISSIONED_FALSE);
  });

  it("flags pin.mismatch when image and approved differ", () => {
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_IMAGE: "ghcr.io/gloopsai/paperclip-gloops@sha256:aaa",
        PAPERCLIP_APPROVED_IMAGE: "ghcr.io/gloopsai/paperclip-gloops@sha256:bbb",
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(false);
    expect(p.criticalCodes).toContain(SDLC_PREFLIGHT_REASON.PIN_MISMATCH);
  });

  it("pin match is ok", () => {
    const img = "ghcr.io/gloopsai/paperclip-gloops@sha256:abc";
    const p = evaluatePlaneStatusFromEnv(
      {
        PAPERCLIP_IMAGE: img,
        PAPERCLIP_APPROVED_IMAGE: img,
        HEARTBEAT_SCHEDULER_ENABLED: "false",
      },
      { now },
    );
    expect(p.ok).toBe(true);
    expect(p.pinImage).toBe(img);
  });
});

describe("isInductImplementTarget / looksImplementPacket", () => {
  it("true for default induct PWS with implement role", () => {
    expect(
      isInductImplementTarget({
        projectWorkspaceId: INDUCT_PWS,
        assigneeRole: "engineer",
        title: "Wire feature",
        env: {},
      }),
    ).toBe(true);
  });

  it("true for InductAI mention + Scope", () => {
    expect(
      isInductImplementTarget({
        title: "Fix InductAI/induct checkout",
        description: "## Scope\n- a.ts\n",
        env: {},
      }),
    ).toBe(true);
  });

  it("false for non-induct review issue", () => {
    expect(
      isInductImplementTarget({
        title: "Review paperclip PR",
        description: "Please review the platform change",
        assigneeRole: "qa",
        env: {},
      }),
    ).toBe(false);
  });

  it("respects custom PWS allowlist", () => {
    const env = { PAPERCLIP_INDUCT_PROJECT_WORKSPACE_IDS: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" };
    expect(
      isInductImplementTarget({
        projectWorkspaceId: INDUCT_PWS,
        assigneeRole: "engineer",
        env,
      }),
    ).toBe(false);
    expect(
      isInductImplementTarget({
        projectWorkspaceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        assigneeRole: "engineer",
        env,
      }),
    ).toBe(true);
  });

  it("looksImplementPacket true on ## Scope", () => {
    expect(looksImplementPacket({ description: "## Scope\n- x\n" })).toBe(true);
  });

  it("default induct PWS set includes known id", () => {
    expect(getInductProjectWorkspaceIds({})).toContain(INDUCT_PWS);
  });
});

describe("evaluateInductSdlcGate", () => {
  const now = new Date("2026-08-03T12:00:00.000Z");
  const healthyEnv = {
    PAPERCLIP_SDLC_PREFLIGHT: "enforce",
    HEARTBEAT_SCHEDULER_ENABLED: "false",
    PAPERCLIP_CAMPAIGN_DEADLINE_AT: hoursFromNow(20, now),
  };

  const goodPacket = {
    projectWorkspaceId: INDUCT_PWS,
    title: "Implement induct feature",
    description: `## Scope\n- a.ts\n\nExact head: \`${SHA}\`\n`,
    assigneeRole: "engineer",
  };

  it("allows non-induct issues", () => {
    const d = evaluateInductSdlcGate({
      title: "Platform health fix",
      description: "## Scope\n- server/x.ts\n",
      env: healthyEnv,
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.required).toBe(false);
  });

  it("allows good induct implement packet on healthy plane", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      env: healthyEnv,
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.required).toBe(true);
    expect(d.reasonCodes).toEqual([]);
  });

  it("denies missing PWS", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      projectWorkspaceId: null,
      title: "Implement on InductAI/induct",
      env: healthyEnv,
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(SDLC_PREFLIGHT_REASON.MISSING_PROJECT_WORKSPACE);
  });

  it("denies missing exact head", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      description: "## Scope\n- a.ts\n",
      env: healthyEnv,
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(SDLC_PREFLIGHT_REASON.MISSING_EXACT_HEAD);
  });

  it("accepts head from workspaceRepoRef", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      description: "## Scope\n- a.ts\n",
      workspaceRepoRef: SHA,
      env: healthyEnv,
      now,
    });
    expect(d.allowed).toBe(true);
  });

  it("denies when plane critically failing", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      env: {
        ...healthyEnv,
        HEARTBEAT_SCHEDULER_ENABLED: "true",
      },
      now,
    });
    expect(d.allowed).toBe(false);
    expect(d.reasonCodes).toContain(SDLC_PREFLIGHT_REASON.PLANE_NOT_OK);
    expect(d.reasonCodes).toContain(SDLC_PREFLIGHT_REASON.SCHEDULER_TRUE);
  });

  it("observe allows but reports codes", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      projectWorkspaceId: null,
      title: "Implement InductAI/induct path",
      env: {
        ...healthyEnv,
        PAPERCLIP_SDLC_PREFLIGHT: "observe",
      },
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.reasonCodes.length).toBeGreaterThan(0);
  });

  it("off skips gate", () => {
    const d = evaluateInductSdlcGate({
      ...goodPacket,
      projectWorkspaceId: null,
      env: { PAPERCLIP_SDLC_PREFLIGHT: "off" },
      now,
    });
    expect(d.allowed).toBe(true);
    expect(d.required).toBe(false);
  });
});
