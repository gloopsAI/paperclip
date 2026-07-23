#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "http://127.0.0.1:3100";
const DEFAULT_AUTH_FILE = "/home/paperclip/.paperclip/auth.json";
const DEFAULT_REPORT_DIR = "/opt/paperclip/reports";
const DEFAULT_CODEX_SHARE_ALERT = 0.15;

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function money(cents) {
  return cents == null ? "unavailable" : `$${(cents / 100).toFixed(2)}`;
}

function safeRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function capacityObservationFor(capacity, planId) {
  const observation = capacity?.providers?.[planId];
  if (!observation || typeof observation !== "object") {
    return {
      availability: "unknown",
      usagePercent: null,
      resetsAt: null,
      observedAt: null,
      source: "unavailable",
    };
  }
  return {
    availability: observation.availability ?? "unknown",
    usagePercent: Number.isFinite(observation.usagePercent) ? observation.usagePercent : null,
    resetsAt: observation.resetsAt ?? null,
    observedAt: observation.observedAt ?? capacity.observedAt ?? null,
    source: observation.source ?? capacity.source ?? "operator_observation",
  };
}

export function buildDailyEconomicsReceipt(summary, capacity = null, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const codexShareAlert = options.codexShareAlert ?? DEFAULT_CODEX_SHARE_ALERT;
  const plans = Object.fromEntries(summary.plans.map((plan) => [plan.planId, plan]));
  const classifiedRuns = summary.usageTruth.classifiedSubscriptionRunCount;
  const codexRuns = plans.codex_subscription?.terminalRunCount ?? 0;
  const codexRunShare = safeRatio(codexRuns, classifiedRuns);
  const outcomeGradedAgentRows = summary.byAgent.filter((row) => row.outcomeGrade != null).length;
  const outcomeGradeCoverage = safeRatio(outcomeGradedAgentRows, summary.byAgent.length);

  const alerts = [];
  if (codexRunShare != null && codexRunShare > codexShareAlert) {
    alerts.push(
      `Codex run share is ${percent(codexRunShare)}, above the ${(codexShareAlert * 100).toFixed(0)}% proxy threshold. Confirm lower-route exhaustion receipts before further Codex work.`,
    );
  }
  if (summary.usageTruth.unknownRunCount > 0) {
    alerts.push(
      `${summary.usageTruth.unknownRunCount} terminal runs have unknown usage; per-agent ROI remains incomplete.`,
    );
  }

  for (const plan of summary.plans) {
    const observation = capacityObservationFor(capacity, plan.planId);
    if (
      observation.availability === "available"
      && observation.usagePercent != null
      && observation.usagePercent < 0.1
    ) {
      alerts.push(
        `${plan.label} has ${(observation.usagePercent * 100).toFixed(1)}% observed utilization while available; eligible work may be leaving prepaid capacity unused.`,
      );
    }
  }

  const recommendation =
    outcomeGradeCoverage == null || outcomeGradeCoverage < 0.8
      ? "Hold subscription changes until terminal outcome-grade coverage reaches 80%; optimize routing and receipt completeness first."
      : alerts.length > 0
        ? "Capacity Manager should review the alerts before the next provider reset or Codex admission."
        : "No subscription change is supported by the current evidence.";

  const planRows = summary.plans.map((plan) => {
    const observation = capacityObservationFor(capacity, plan.planId);
    const failureRate = safeRatio(plan.failedOrNoValueRunCount, plan.terminalRunCount);
    return {
      planId: plan.planId,
      label: plan.label,
      monthlyCostCents: plan.monthlyCostCents,
      terminalRunCount: plan.terminalRunCount,
      failedOrNoValueRunCount: plan.failedOrNoValueRunCount,
      failureRate,
      tokenEquivalents: plan.tokenEquivalents,
      usageProvenance: plan.usageProvenance,
      allocatedFixedCostCents: plan.allocatedFixedCostCents,
      availability: observation.availability,
      observedUsagePercent: observation.usagePercent,
      resetsAt: observation.resetsAt,
      capacityObservedAt: observation.observedAt,
      capacitySource: observation.source,
    };
  });

  const agentRows = summary.byAgent
    .slice()
    .sort((a, b) => b.terminalRunCount - a.terminalRunCount || a.label.localeCompare(b.label))
    .map((row) => ({
      agentId: row.key,
      label: row.label,
      planId: row.planId,
      terminalRunCount: row.terminalRunCount,
      failedOrNoValueRunCount: row.failedOrNoValueRunCount,
      successProxy: safeRatio(
        row.terminalRunCount - row.failedOrNoValueRunCount,
        row.terminalRunCount,
      ),
      tokenEquivalents: row.tokenEquivalents,
      usageProvenance: row.usageProvenance,
      allocatedFixedCostCents: row.allocatedFixedCostCents,
      outcomeGrade: row.outcomeGrade,
      qualityAdjustedRoi: row.outcomeGrade != null && row.allocatedFixedCostCents != null
        ? "grade_and_cost_available"
        : "unavailable",
    }));

  const markdown = [
    `## Daily subscription economics — ${generatedAt.slice(0, 10)}`,
    "",
    `**Policy:** Ollama → Grok CLI → Codex. Grok API is prohibited.`,
    `**Known fixed base:** ${money(summary.knownBaseMonthlyCents)}/month; Claude remains excluded until its cost is known.`,
    `**Evidence:** ${classifiedRuns}/${summary.usageTruth.terminalRunCount} terminal runs classified; ${summary.usageTruth.unknownRunCount} have unknown usage.`,
    "",
    "| Provider | Runs | Failed/no-value | Token-equivalents | Availability / reset |",
    "| --- | ---: | ---: | ---: | --- |",
    ...planRows.map((row) => {
      const reset = row.resetsAt ?? "reset unavailable";
      const usage = row.observedUsagePercent == null
        ? ""
        : `, ${(row.observedUsagePercent * 100).toFixed(1)}% observed`;
      return `| ${row.label} | ${row.terminalRunCount} | ${row.failedOrNoValueRunCount} | ${row.tokenEquivalents ?? "unavailable"} | ${row.availability}${usage}; ${reset} |`;
    }),
    "",
    `**Codex consumption signal:** ${codexRunShare == null ? "unavailable" : `${percent(codexRunShare)} of classified terminal runs`}.`,
    `**Quality-adjusted ROI:** ${
      outcomeGradeCoverage == null || outcomeGradeCoverage === 0
        ? "unavailable (no agent rows have terminal outcome grades)"
        : `${percent(outcomeGradeCoverage)} agent-row grade coverage`
    }; success/failure is only a proxy until terminal grades are present.`,
    `**Recommendation:** ${recommendation}`,
    "",
    alerts.length > 0
      ? `**Alerts:**\n${alerts.map((alert) => `- ${alert}`).join("\n")}`
      : "**Alerts:** none supported by current evidence.",
  ].join("\n");

  return {
    schema: "gloops.subscription_economics_daily.v1",
    generatedAt,
    routePolicy: ["ollama", "grok-build-cli", "codex"],
    knownBaseMonthlyCents: summary.knownBaseMonthlyCents,
    usageTruth: summary.usageTruth,
    codexRunShare,
    codexShareAlert,
    outcomeGradeCoverage,
    plans: planRows,
    agents: agentRows,
    alerts,
    recommendation,
    markdown,
  };
}

function authToken(authFile, baseUrl) {
  const auth = JSON.parse(readFileSync(authFile, "utf8"));
  return auth[baseUrl]?.token
    ?? auth.credentials?.[baseUrl]?.token
    ?? auth[DEFAULT_BASE_URL]?.token
    ?? auth.credentials?.[DEFAULT_BASE_URL]?.token
    ?? null;
}

async function jsonRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function optionalJson(path) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export async function runDailyEconomicsReport(env = process.env) {
  const baseUrl = env.PAPERCLIP_BASE_URL ?? DEFAULT_BASE_URL;
  const companyId = env.PAPERCLIP_COMPANY_ID;
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID is required");
  const token = env.PAPERCLIP_TOKEN ?? authToken(
    env.PAPERCLIP_AUTH_FILE ?? DEFAULT_AUTH_FILE,
    baseUrl,
  );
  if (!token) throw new Error("Paperclip authentication token unavailable");

  const summary = await jsonRequest(
    `${baseUrl}/api/companies/${companyId}/costs/subscription-economics`,
    token,
  );
  const capacity = optionalJson(env.PAPERCLIP_SUBSCRIPTION_CAPACITY_FILE);
  const receipt = buildDailyEconomicsReceipt(summary, capacity);
  const reportDir = env.PAPERCLIP_ECONOMICS_REPORT_DIR ?? DEFAULT_REPORT_DIR;
  mkdirSync(reportDir, { recursive: true });
  const day = receipt.generatedAt.slice(0, 10);
  const jsonPath = `${reportDir}/subscription-economics-${day}.json`;
  const markdownPath = `${reportDir}/subscription-economics-${day}.md`;
  writeFileSync(jsonPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o640 });
  writeFileSync(markdownPath, `${receipt.markdown}\n`, { mode: 0o640 });

  if (env.PAPERCLIP_DAILY_ECONOMICS_ISSUE_ID) {
    await jsonRequest(
      `${baseUrl}/api/issues/${env.PAPERCLIP_DAILY_ECONOMICS_ISSUE_ID}/comments`,
      token,
      {
        method: "POST",
        body: JSON.stringify({ body: receipt.markdown, authorType: "system" }),
      },
    );
  }
  return { receipt, jsonPath, markdownPath };
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runDailyEconomicsReport()
    .then(({ receipt, jsonPath, markdownPath }) => {
      console.log(JSON.stringify({
        generatedAt: receipt.generatedAt,
        alerts: receipt.alerts.length,
        jsonPath,
        markdownPath,
      }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
