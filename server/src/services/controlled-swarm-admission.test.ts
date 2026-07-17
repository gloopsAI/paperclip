import { describe, expect, it } from "vitest";
import { parseControlledSwarmAdmissionPolicy } from "./controlled-swarm-admission.js";

describe("controlled swarm admission policy", () => {
  it("is disabled when no campaign envelope is configured", () => {
    expect(parseControlledSwarmAdmissionPolicy({})).toEqual({
      commissioned: true,
      companyMaxActiveRuns: null,
      issueCreatedAtGte: null,
    });
  });

  it("parses exact company WIP and campaign cutoff controls", () => {
    expect(parseControlledSwarmAdmissionPolicy({
      PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "4",
      PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "false",
      PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE: "2026-07-17T06:00:00.000Z",
    })).toEqual({
      commissioned: false,
      companyMaxActiveRuns: 4,
      issueCreatedAtGte: new Date("2026-07-17T06:00:00.000Z"),
    });
  });

  it("fails closed on malformed or unsafe values", () => {
    expect(() => parseControlledSwarmAdmissionPolicy({
      PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "0",
    })).toThrow("between 1 and 50");
    expect(() => parseControlledSwarmAdmissionPolicy({
      PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS: "four",
    })).toThrow("positive integer");
    expect(() => parseControlledSwarmAdmissionPolicy({
      PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE: "2026-07-17",
    })).toThrow("exact ISO-8601 UTC timestamp");
    expect(() => parseControlledSwarmAdmissionPolicy({
      PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED: "yes",
    })).toThrow("must be true or false");
  });
});
