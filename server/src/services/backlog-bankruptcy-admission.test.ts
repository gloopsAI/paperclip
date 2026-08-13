import { describe, expect, it } from "vitest";
import {
  BACKLOG_BANKRUPTCY_ADMISSION_ERROR,
  evaluateBacklogBankruptcyAdmission,
  parseBacklogBankruptcyAdmissionPolicy,
} from "./backlog-bankruptcy-admission.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const READMIT_ISSUE_ID = "33333333-3333-4333-8333-333333333333";

describe("backlog-bankruptcy admission", () => {
  it("defaults to no frozen companies", () => {
    expect(parseBacklogBankruptcyAdmissionPolicy({})).toEqual({
      frozenCompanyIds: new Set(),
      readmitIssueIds: new Set(),
    });
  });

  it("parses exact company and issue UUID allowlists", () => {
    expect(parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: COMPANY_ID,
      PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS: READMIT_ISSUE_ID,
    })).toEqual({
      frozenCompanyIds: new Set([COMPANY_ID]),
      readmitIssueIds: new Set([READMIT_ISSUE_ID]),
    });
  });

  it("fails closed on malformed, duplicate, or unscoped configuration", () => {
    expect(() => parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: "not-a-uuid",
    })).toThrow("comma-separated list of UUIDs");
    expect(() => parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: `${COMPANY_ID},${COMPANY_ID}`,
    })).toThrow("must not contain duplicate UUIDs");
    expect(() => parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS: READMIT_ISSUE_ID,
    })).toThrow("requires at least one frozen company");
  });

  it("denies frozen-company claims while leaving other companies admitted", () => {
    const policy = parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: COMPANY_ID,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: null,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: false,
    })).toMatchObject({
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.COMPANY_FROZEN,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: OTHER_COMPANY_ID,
      issueId: null,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: false,
    })).toEqual({ admitted: true, reason: "company_not_frozen" });
  });

  it("admits only allowlisted issues with an enabled explicit budget envelope", () => {
    const policy = parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: COMPANY_ID,
      PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS: READMIT_ISSUE_ID,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: false,
    })).toMatchObject({
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.READMIT_BUDGET_REQUIRED,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: false,
      hasExplicitResourceBudget: true,
    })).toMatchObject({
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.READMIT_BUDGET_REQUIRED,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: true,
    })).toEqual({ admitted: true, reason: "budgeted_readmit" });
  });

  it("admits a server-derived task-bridge consultation only with an explicit budget", () => {
    const policy = parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: COMPANY_ID,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: true,
      trustedTaskBridgeConsult: true,
    })).toEqual({ admitted: true, reason: "trusted_task_bridge_consult" });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: false,
      trustedTaskBridgeConsult: true,
    })).toMatchObject({
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.READMIT_BUDGET_REQUIRED,
    });
  });

  it("does not trust an ordinary frozen-company issue merely because it has a budget", () => {
    const policy = parseBacklogBankruptcyAdmissionPolicy({
      PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS: COMPANY_ID,
    });
    expect(evaluateBacklogBankruptcyAdmission(policy, {
      companyId: COMPANY_ID,
      issueId: READMIT_ISSUE_ID,
      executionAdmissionEnabled: true,
      hasExplicitResourceBudget: true,
      trustedTaskBridgeConsult: false,
    })).toMatchObject({
      admitted: false,
      errorCode: BACKLOG_BANKRUPTCY_ADMISSION_ERROR.COMPANY_FROZEN,
    });
  });
});
