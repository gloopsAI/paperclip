import type { IssueExecutionCompletionProfile } from "@paperclipai/shared";

export type CompiledExecutionVerification = {
  exactHeadSha?: string | null;
  cursor: string;
};

export function compileExecutionVerification(input: {
  completionProfile?: IssueExecutionCompletionProfile | null;
  exactHeadSha?: string | null;
}): CompiledExecutionVerification {
  if (input.completionProfile === "direct") {
    return {
      cursor: "complete only the declared task, report the result, and record terminal disposition; do not invent code, git, test, review, or exact-head work",
    };
  }
  return {
    exactHeadSha: input.exactHeadSha ?? null,
    cursor: "verify exact head, run focused checks, and record terminal disposition before completion",
  };
}
