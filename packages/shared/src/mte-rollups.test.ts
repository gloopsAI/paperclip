import { describe, expect, it } from "vitest";
import {
  buildMteStewardRollupHint,
  getMteRollup,
  MTE_ROLLUP_QUERIES,
  TOKEN_ECONOMICS_STEWARD_ROLLUPS,
  type MteRollupSpec,
} from "./mte-rollups.js";

describe("MTE rollup surface", () => {
  it("exposes one row per documented rollup name", () => {
    const names = MTE_ROLLUP_QUERIES.map((rollup) => rollup.name);
    const expected = [
      "byAgent",
      "byAgentModel",
      "byProvider",
      "byBiller",
      "byProject",
      "windowSpend",
      "issueTreeSummary",
      "summary",
      "financeSummary",
      "financeByBiller",
      "financeByKind",
    ];
    expect(names).toEqual(expected);
  });

  it("sources every cost rollup from cost_events and every finance rollup from finance_events", () => {
    const costRollups = MTE_ROLLUP_QUERIES.filter((rollup) => rollup.source === "cost_events");
    const financeRollups = MTE_ROLLUP_QUERIES.filter((rollup) => rollup.source === "finance_events");

    expect(costRollups.length).toBeGreaterThan(0);
    expect(financeRollups.length).toBeGreaterThan(0);

    for (const rollup of costRollups) {
      expect(rollup.name).not.toMatch(/^finance/);
    }
    for (const rollup of financeRollups) {
      expect((rollup.name as string).indexOf("finance")).toBe(0);
    }
  });

  it("declares biller as one of the group axes when the rollup name references biller", () => {
    const byBiller = getMteRollup("byBiller");
    const byProvider = getMteRollup("byProvider");
    const byAgentModel = getMteRollup("byAgentModel");
    const financeByBiller = getMteRollup("financeByBiller");

    expect(byBiller).toBeDefined();
    expect(byBiller?.groupBy).toContain("biller");

    expect(byProvider).toBeDefined();
    expect(byProvider?.groupBy).toContain("provider");
    expect(byProvider?.groupBy).toContain("biller");

    expect(byAgentModel).toBeDefined();
    expect(byAgentModel?.groupBy).toContain("biller");
    expect(byAgentModel?.groupBy).toContain("billingType");

    expect(financeByBiller).toBeDefined();
    expect(financeByBiller?.groupBy).toContain("biller");
  });

  it("surfaces a steward-consumable rollup with costCents+tokenSums+runCounts measure", () => {
    const candidates: MteRollupSpec[] = MTE_ROLLUP_QUERIES.filter((rollup) =>
      rollup.measure === "costCents+tokenSums+runCounts"
    );
    // byAgent / byProvider / byBiller are the steward surface (budget gates rely on them).
    const names = candidates.map((rollup) => rollup.name);
    expect(names).toEqual(expect.arrayContaining(["byAgent", "byProvider", "byBiller"]));
  });

  it("getMteRollup returns undefined for unknown names", () => {
    expect(getMteRollup("nonExistent" as MteRollupSpec["name"])).toBeUndefined();
  });

  it("TOKEN_ECONOMICS_STEWARD_ROLLUPS only references rows that resolve in the registry", () => {
    for (const name of TOKEN_ECONOMICS_STEWARD_ROLLUPS) {
      const row = getMteRollup(name);
      expect(row).toBeDefined();
      // Token economics owner must always see at least one finance rollup so
      // finance_events anomalies have a registry entry to fall back to.
    }
    const financeHits = TOKEN_ECONOMICS_STEWARD_ROLLUPS.filter((name) =>
      (name as string).indexOf("finance") === 0
    );
    expect(financeHits.length).toBeGreaterThan(0);
  });

  it("buildMteStewardRollupHint returns an empty rollup list when the owner is capacity", () => {
    expect(buildMteStewardRollupHint({ owner: "capacity" })).toEqual({
      tokenEconomicsOwner: false,
      rollupNames: [],
    });
  });

  it("buildMteStewardRollupHint lists the token-economics steward rollups when the owner is token_economics", () => {
    expect(buildMteStewardRollupHint({ owner: "token_economics" })).toEqual({
      tokenEconomicsOwner: true,
      rollupNames: TOKEN_ECONOMICS_STEWARD_ROLLUPS,
    });
  });
});
