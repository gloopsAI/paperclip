import { describe, expect, it } from "vitest";
import { projectExecutionWorkspacePolicySchema } from "./project.js";

// WG-PLAT-006: workspaceStrategy.branchTemplate must use the supported
// `{{dotted.path}}` syntax naming a supported variable, so a template with a
// leftover placeholder (e.g. `GLO-{identifier}-<slug>`) is rejected at save
// time instead of silently materializing as a literal branch name later.
describe("projectExecutionWorkspacePolicySchema branchTemplate validation", () => {
  it("rejects a branchTemplate with an unresolved single-brace/angle-bracket placeholder", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "GLO-{identifier}-<slug>",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["workspaceStrategy", "branchTemplate"]);
    }
  });

  it("rejects a branchTemplate referencing an unsupported {{variable}}", () => {
    const result = projectExecutionWorkspacePolicySchema.safeParse({
      enabled: true,
      workspaceStrategy: {
        type: "git_worktree",
        branchTemplate: "{{issue.number}}-{{slug}}",
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["workspaceStrategy", "branchTemplate"]);
    }
  });

  it("accepts a well-formed {{issue.identifier}}-{{slug}} branchTemplate", () => {
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({
        enabled: true,
        workspaceStrategy: {
          type: "git_worktree",
          branchTemplate: "{{issue.identifier}}-{{slug}}",
        },
      }).success,
    ).toBe(true);
  });

  it("accepts an omitted branchTemplate", () => {
    expect(
      projectExecutionWorkspacePolicySchema.safeParse({
        enabled: true,
        workspaceStrategy: { type: "git_worktree" },
      }).success,
    ).toBe(true);
  });
});
