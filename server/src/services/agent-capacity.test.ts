import { describe, expect, it } from "vitest";
import {
  classifyAgentCapacity,
  evaluateUnpauseGate,
  lifecycleForAgentName,
  MVP_CAPACITY_ROLE_NAMES,
  PAUSE_REASON,
  recommendedPauseReasonForLifecycle,
  summarizeCapacityClassifications,
  type AgentCapacityLifecycle,
} from "./agent-capacity.js";

describe("MVP capacity role map", () => {
  it("covers the default MVP roles without duplicates", () => {
    const seen = new Set<string>();
    for (const names of Object.values(MVP_CAPACITY_ROLE_NAMES)) {
      for (const name of names) {
        const key = name.trim().toLowerCase();
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
    expect(MVP_CAPACITY_ROLE_NAMES.active_capacity).toEqual([
      "Dispatch",
      "Wren",
      "Argus",
      "Harbor",
    ]);
    expect(MVP_CAPACITY_ROLE_NAMES.pool_ready).toEqual(["Mason"]);
    expect(MVP_CAPACITY_ROLE_NAMES.invoked_only).toHaveLength(11);
    expect(MVP_CAPACITY_ROLE_NAMES.archived).toHaveLength(4);
  });
});

describe("lifecycleForAgentName", () => {
  it("matches case-insensitively and trims whitespace", () => {
    expect(lifecycleForAgentName("dispatch")).toBe("active_capacity");
    expect(lifecycleForAgentName("  WREN  ")).toBe("active_capacity");
    expect(lifecycleForAgentName("Mason")).toBe("pool_ready");
    expect(lifecycleForAgentName("context steward")).toBe("invoked_only");
    expect(lifecycleForAgentName("Reflection Coach")).toBe("archived");
  });

  it("returns unknown for unmapped names", () => {
    expect(lifecycleForAgentName("Random Agent")).toBe("unknown");
    expect(lifecycleForAgentName("")).toBe("unknown");
  });
});

describe("classifyAgentCapacity", () => {
  it("classifies active capacity roles as counting toward capacity", () => {
    for (const name of MVP_CAPACITY_ROLE_NAMES.active_capacity) {
      const result = classifyAgentCapacity({ name, status: "idle" });
      expect(result).toMatchObject({
        lifecycle: "active_capacity",
        countsAsCapacity: true,
      });
      expect(result.reason).toContain(name);
    }
  });

  it("classifies pool_ready, invoked_only, and archived as non-capacity", () => {
    expect(
      classifyAgentCapacity({ name: "Mason", status: "paused", pauseReason: "not_in_mvp" }),
    ).toMatchObject({
      lifecycle: "pool_ready",
      countsAsCapacity: false,
    });

    expect(
      classifyAgentCapacity({ name: "Atlas", status: "paused" }),
    ).toMatchObject({
      lifecycle: "invoked_only",
      countsAsCapacity: false,
    });

    expect(
      classifyAgentCapacity({ name: "Reception", status: "paused" }),
    ).toMatchObject({
      lifecycle: "archived",
      countsAsCapacity: false,
    });
  });

  it("does not let status override the name map", () => {
    // Even if an active role is paused, lifecycle remains active_capacity.
    expect(
      classifyAgentCapacity({
        name: "Harbor",
        status: "paused",
        pauseReason: "budget",
      }),
    ).toMatchObject({
      lifecycle: "active_capacity",
      countsAsCapacity: true,
    });
  });

  it("classifies unmapped agents as unknown non-capacity", () => {
    expect(
      classifyAgentCapacity({ name: "Mystery Bot", status: "error" }),
    ).toMatchObject({
      lifecycle: "unknown",
      countsAsCapacity: false,
    });
  });
});

describe("recommendedPauseReasonForLifecycle", () => {
  it("maps lifecycle to pause reason constants", () => {
    expect(recommendedPauseReasonForLifecycle("active_capacity")).toBeNull();
    expect(recommendedPauseReasonForLifecycle("pool_ready")).toBe(PAUSE_REASON.not_in_mvp);
    expect(recommendedPauseReasonForLifecycle("invoked_only")).toBe(
      PAUSE_REASON.invoked_only,
    );
    expect(recommendedPauseReasonForLifecycle("archived")).toBe(
      PAUSE_REASON.archived_pilot,
    );
    expect(recommendedPauseReasonForLifecycle("unknown")).toBe(PAUSE_REASON.not_in_mvp);
  });
});

describe("evaluateUnpauseGate", () => {
  const clearGates = {
    acceptedOutcomes: 3,
    humanInterventions: 0,
    openP0KernelDefects: 0,
  };

  it("allows active_capacity without gate metrics", () => {
    expect(
      evaluateUnpauseGate({
        lifecycle: "active_capacity",
        acceptedOutcomes: 0,
        humanInterventions: 99,
        openP0KernelDefects: 5,
      }),
    ).toEqual({
      allowed: true,
      reasons: ["active_capacity agents are already allowed for work"],
    });
  });

  it("never allows archived", () => {
    expect(
      evaluateUnpauseGate({
        lifecycle: "archived",
        ...clearGates,
      }),
    ).toEqual({
      allowed: false,
      reasons: ["archived agents are never eligible for unpause"],
    });
  });

  it("rejects unknown lifecycle", () => {
    const result = evaluateUnpauseGate({
      lifecycle: "unknown",
      ...clearGates,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.join(" ")).toContain("unknown");
  });

  it("allows pool_ready and invoked_only when gates clear", () => {
    for (const lifecycle of ["pool_ready", "invoked_only"] as const) {
      const result = evaluateUnpauseGate({ lifecycle, ...clearGates });
      expect(result.allowed).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });

  it("requires acceptedOutcomes >= minAccepted (default 3)", () => {
    const result = evaluateUnpauseGate({
      lifecycle: "pool_ready",
      acceptedOutcomes: 2,
      humanInterventions: 0,
      openP0KernelDefects: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes("acceptedOutcomes"))).toBe(true);
  });

  it("honors custom minAccepted", () => {
    expect(
      evaluateUnpauseGate({
        lifecycle: "invoked_only",
        acceptedOutcomes: 1,
        humanInterventions: 0,
        openP0KernelDefects: 0,
        minAccepted: 1,
      }).allowed,
    ).toBe(true);

    expect(
      evaluateUnpauseGate({
        lifecycle: "invoked_only",
        acceptedOutcomes: 1,
        humanInterventions: 0,
        openP0KernelDefects: 0,
        minAccepted: 2,
      }).allowed,
    ).toBe(false);
  });

  it("requires humanInterventions <= 0", () => {
    const result = evaluateUnpauseGate({
      lifecycle: "pool_ready",
      acceptedOutcomes: 5,
      humanInterventions: 1,
      openP0KernelDefects: 0,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes("humanInterventions"))).toBe(true);

    expect(
      evaluateUnpauseGate({
        lifecycle: "pool_ready",
        acceptedOutcomes: 5,
        humanInterventions: 0,
        openP0KernelDefects: 0,
      }).allowed,
    ).toBe(true);

    expect(
      evaluateUnpauseGate({
        lifecycle: "pool_ready",
        acceptedOutcomes: 5,
        humanInterventions: -1,
        openP0KernelDefects: 0,
      }).allowed,
    ).toBe(true);
  });

  it("requires openP0KernelDefects === 0", () => {
    const result = evaluateUnpauseGate({
      lifecycle: "invoked_only",
      acceptedOutcomes: 10,
      humanInterventions: 0,
      openP0KernelDefects: 1,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons.some((r) => r.includes("openP0KernelDefects"))).toBe(true);
  });

  it("accumulates multiple failure reasons", () => {
    const result = evaluateUnpauseGate({
      lifecycle: "pool_ready",
      acceptedOutcomes: 0,
      humanInterventions: 2,
      openP0KernelDefects: 3,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toHaveLength(3);
  });
});

describe("summarizeCapacityClassifications", () => {
  it("buckets lifecycle counts into the report summary shape", () => {
    const lifecycles: AgentCapacityLifecycle[] = [
      "active_capacity",
      "active_capacity",
      "pool_ready",
      "invoked_only",
      "invoked_only",
      "invoked_only",
      "archived",
      "unknown",
      "unknown",
    ];
    expect(
      summarizeCapacityClassifications(lifecycles.map((lifecycle) => ({ lifecycle }))),
    ).toEqual({
      activeCapacity: 2,
      poolReady: 1,
      invokedOnly: 3,
      archived: 1,
      pausedErrorUnknown: 2,
    });
  });
});
