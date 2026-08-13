const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const BACKLOG_BANKRUPTCY_ADMISSION_ERROR = {
  COMPANY_FROZEN: "backlog_bankruptcy.company_frozen",
  READMIT_BUDGET_REQUIRED: "backlog_bankruptcy.readmit_budget_required",
} as const;

export interface BacklogBankruptcyAdmissionPolicy {
  frozenCompanyIds: ReadonlySet<string>;
  readmitIssueIds: ReadonlySet<string>;
}

export type BacklogBankruptcyAdmissionDecision =
  | {
      admitted: true;
      reason: "company_not_frozen" | "budgeted_readmit" | "trusted_task_bridge_consult";
    }
  | {
      admitted: false;
      errorCode: typeof BACKLOG_BANKRUPTCY_ADMISSION_ERROR[keyof typeof BACKLOG_BANKRUPTCY_ADMISSION_ERROR];
      reason: string;
    };

function parseUuidSet(name: string, raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const values = raw.split(",").map((value) => value.trim().toLowerCase());
  if (values.some((value) => !value || !UUID_PATTERN.test(value))) {
    throw new Error(`${name} must be a comma-separated list of UUIDs`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${name} must not contain duplicate UUIDs`);
  }
  return new Set(values);
}

export function parseBacklogBankruptcyAdmissionPolicy(
  env: Record<string, string | undefined> = process.env,
): BacklogBankruptcyAdmissionPolicy {
  const frozenCompanyIds = parseUuidSet(
    "PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS",
    env.PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS,
  );
  const readmitIssueIds = parseUuidSet(
    "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS",
    env.PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS,
  );
  if (readmitIssueIds.size > 0 && frozenCompanyIds.size === 0) {
    throw new Error(
      "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS requires at least one frozen company",
    );
  }
  return { frozenCompanyIds, readmitIssueIds };
}

export function evaluateBacklogBankruptcyAdmission(
  policy: BacklogBankruptcyAdmissionPolicy,
  input: {
    companyId: string;
    issueId: string | null;
    executionAdmissionEnabled: boolean;
    hasExplicitResourceBudget: boolean;
    /** Server-derived from immutable origin plus the issue's current governed execution shape. */
    trustedTaskBridgeConsult?: boolean;
    /** Exact one-run/zero-retry floor for the trusted consultation exception. */
    trustedTaskBridgeBudgetIsOneRun?: boolean;
  },
): BacklogBankruptcyAdmissionDecision {
  if (!policy.frozenCompanyIds.has(input.companyId.toLowerCase())) {
    return { admitted: true, reason: "company_not_frozen" };
  }
  if (input.trustedTaskBridgeConsult) {
    if (
      !input.executionAdmissionEnabled ||
      !input.hasExplicitResourceBudget ||
      !input.trustedTaskBridgeBudgetIsOneRun
    ) {
      return {
        admitted: false,
        errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.READMIT_BUDGET_REQUIRED,
        reason: "Cancelled before adapter invocation because the trusted task-bridge consultation lacks an exact one-run, zero-retry resource budget envelope",
      };
    }
    return { admitted: true, reason: "trusted_task_bridge_consult" };
  }
  if (!input.issueId || !policy.readmitIssueIds.has(input.issueId.toLowerCase())) {
    return {
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.COMPANY_FROZEN,
      reason: "Cancelled before adapter invocation because backlog-bankruptcy admission is frozen for this company",
    };
  }
  if (!input.executionAdmissionEnabled || !input.hasExplicitResourceBudget) {
    return {
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.READMIT_BUDGET_REQUIRED,
      reason: "Cancelled before adapter invocation because the explicit bankruptcy re-admit lacks a resource budget envelope",
    };
  }
  return { admitted: true, reason: "budgeted_readmit" };
}
