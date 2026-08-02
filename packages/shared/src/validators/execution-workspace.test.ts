import { describe, expect, it } from "vitest";
import {
  SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES,
  describeSupportedWorkspaceBranchTemplateVariables,
  findUnsupportedWorkspaceBranchTemplateVariables,
  hasStrayWorkspaceBranchTemplatePlaceholderSyntax,
} from "./execution-workspace.js";

// WG-PLAT-006: a workspace branch template like `GLO-{identifier}-<slug>`
// used to materialize as the literal branch `GLO-identifier-<slug>` because
// only double-curly `{{dotted.path}}` placeholders are expanded, and
// admission never checked for leftover placeholder syntax. These helpers are
// the shared source of truth both save-time validation (project.ts,
// issue.ts) and admission-time rendering (server workspace-runtime.ts) use
// to reject unresolved placeholders instead of silently sanitizing them.
describe("findUnsupportedWorkspaceBranchTemplateVariables", () => {
  it("returns an empty list for templates using only supported variables", () => {
    expect(findUnsupportedWorkspaceBranchTemplateVariables("{{issue.identifier}}-{{slug}}")).toEqual([]);
    for (const variable of SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES) {
      expect(findUnsupportedWorkspaceBranchTemplateVariables(`{{${variable}}}`)).toEqual([]);
    }
  });

  it("flags a well-formed {{...}} placeholder naming an unsupported variable", () => {
    expect(findUnsupportedWorkspaceBranchTemplateVariables("{{issue.number}}-{{slug}}")).toEqual(["issue.number"]);
  });

  it("does not flag single-brace or angle-bracket text (not its job)", () => {
    // These never match the {{dotted.path}} pattern, so this helper reports
    // no matches for them; hasStrayWorkspaceBranchTemplatePlaceholderSyntax
    // is responsible for catching that shape instead.
    expect(findUnsupportedWorkspaceBranchTemplateVariables("GLO-{identifier}-<slug>")).toEqual([]);
  });

  it("deduplicates repeated unsupported variables", () => {
    expect(findUnsupportedWorkspaceBranchTemplateVariables("{{foo.bar}}-{{foo.bar}}")).toEqual(["foo.bar"]);
  });
});

describe("hasStrayWorkspaceBranchTemplatePlaceholderSyntax", () => {
  it("returns false for a fully resolved branch name", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("GLO-447-add-worktree-support")).toBe(false);
  });

  it("returns false for a well-formed template with recognized placeholders", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("{{issue.identifier}}-{{slug}}")).toBe(false);
  });

  it("detects a leftover single-brace placeholder", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("GLO-{identifier}-slug")).toBe(true);
  });

  it("detects a leftover angle-bracket placeholder", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("GLO-447-<slug>")).toBe(true);
  });

  it("detects the exact WG-PLAT-006 repro shape", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("GLO-{identifier}-<slug>")).toBe(true);
  });

  it("detects a malformed double-curly block missing its closing brace", () => {
    expect(hasStrayWorkspaceBranchTemplatePlaceholderSyntax("{{issue.identifier}-slug")).toBe(true);
  });
});

describe("describeSupportedWorkspaceBranchTemplateVariables", () => {
  it("lists every supported variable wrapped in double curlies", () => {
    const description = describeSupportedWorkspaceBranchTemplateVariables();
    for (const variable of SUPPORTED_WORKSPACE_BRANCH_TEMPLATE_VARIABLES) {
      expect(description).toContain(`{{${variable}}}`);
    }
  });
});
