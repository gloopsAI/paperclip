import assert from "node:assert/strict";
import test from "node:test";

import { buildDailyEconomicsReceipt } from "./gloops-daily-economics-report.mjs";

const summary = {
  knownBaseMonthlyCents: 33_000,
  usageTruth: {
    terminalRunCount: 20,
    classifiedSubscriptionRunCount: 10,
    unclassifiedRunCount: 10,
    measuredTokenEquivalents: 1_000,
    estimatedTokenEquivalents: 100,
    reservedTokenCeilings: 0,
    unknownRunCount: 4,
  },
  plans: [
    {
      planId: "ollama_cloud_max",
      label: "Ollama Cloud Max",
      monthlyCostCents: 10_000,
      terminalRunCount: 6,
      failedOrNoValueRunCount: 1,
      tokenEquivalents: 1_000,
      usageProvenance: "measured",
      allocatedFixedCostCents: 10_000,
    },
    {
      planId: "grok_supergrok_build",
      label: "Grok / SuperGrok Build",
      monthlyCostCents: 3_000,
      terminalRunCount: 1,
      failedOrNoValueRunCount: 0,
      tokenEquivalents: 100,
      usageProvenance: "estimated",
      allocatedFixedCostCents: 3_000,
    },
    {
      planId: "codex_subscription",
      label: "Codex subscription",
      monthlyCostCents: 20_000,
      terminalRunCount: 3,
      failedOrNoValueRunCount: 1,
      tokenEquivalents: null,
      usageProvenance: null,
      allocatedFixedCostCents: null,
    },
    {
      planId: "claude",
      label: "Claude",
      monthlyCostCents: null,
      terminalRunCount: 0,
      failedOrNoValueRunCount: 0,
      tokenEquivalents: null,
      usageProvenance: null,
      allocatedFixedCostCents: null,
    },
  ],
  byAgent: [
    {
      key: "agent-1",
      label: "Agent 1",
      planId: "ollama_cloud_max",
      terminalRunCount: 6,
      failedOrNoValueRunCount: 1,
      tokenEquivalents: 1_000,
      usageProvenance: "measured",
      allocatedFixedCostCents: 10_000,
      outcomeGrade: null,
    },
  ],
};

test("emits a concise, honest receipt and detects disproportionate Codex use", () => {
  const receipt = buildDailyEconomicsReceipt(summary, null, {
    generatedAt: "2026-07-23T12:00:00.000Z",
  });

  assert.equal(receipt.codexRunShare, 0.3);
  assert.ok(receipt.alerts.some((alert) => alert.includes("Codex run share")));
  assert.match(receipt.markdown, /Ollama → Grok CLI → Codex/);
  assert.match(receipt.markdown, /reset unavailable/);
  assert.match(receipt.markdown, /Quality-adjusted ROI.*unavailable/);
  assert.match(receipt.recommendation, /Hold subscription changes/);
});

test("alerts on observed unused prepaid capacity without inventing reset data", () => {
  const receipt = buildDailyEconomicsReceipt(summary, {
    observedAt: "2026-07-23T11:55:00.000Z",
    providers: {
      ollama_cloud_max: {
        availability: "available",
        usagePercent: 0.03,
        resetsAt: "2026-07-27T12:00:00.000Z",
        source: "operator_observation",
      },
    },
  }, {
    generatedAt: "2026-07-23T12:00:00.000Z",
  });

  assert.ok(receipt.alerts.some((alert) => alert.includes("prepaid capacity unused")));
  assert.match(receipt.markdown, /3.0% observed/);
  assert.match(receipt.markdown, /2026-07-27T12:00:00.000Z/);
});
