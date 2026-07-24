---
name: gloops-task-preparation
description: Prepare a Paperclip work item for Hermes execution by matching its task class, context size, tools, workspace, provider, and budget to a proven execution profile. Use before any lookup, implementation, review, planning, or terminal-reconciliation run, especially when work could write files, invoke a subscription model, or resume after failure.
---

# GLoops task preparation

Prepare the smallest complete packet that gives the selected agent a fair chance to finish. Do not dispatch first and diagnose fit afterward.

## Prepare the run

1. Classify the request as `lookup`, `implementation`, `review`, `planning`, or `terminal-reconciliation`.
2. Read [model-fit.md](references/model-fit.md) and select the cheapest proven model for that class.
3. Build one compact packet containing:
   - outcome and terminal definition;
   - exact repository, ref, workspace, and allowed files;
   - only the relevant evidence or code;
   - available tools and one verification command;
   - explicit non-goals;
   - measured input, output, turn, tool, and wall-time budgets.
   Count every required `skill_view` as a tool call when sizing the tool budget.
4. For a write task, verify before provider dispatch:
   - the exact workspace exists;
   - the expected repository and ref are present;
   - the workspace is writable;
   - required commands are available;
   - the allowed verification command can run.
5. For a read-only task, remove write tools and state that no mutation or receipt invention is allowed.
6. Dispatch once. Permit a retry only for a documented transient failure and only when the packet is unchanged or the correction is explicit.

## Fail before spending

If any preflight check fails, do not invoke a model. Return one terminal blocker containing the failed check, observed evidence, responsible owner, and smallest corrective action.

Never report a configured ceiling as observed usage. Never mark a run successful because the provider returned text. Success requires the task-specific terminal contract.

## Use an advisor selectively

Keep normal execution on Ollama, then Grok CLI. Invoke Codex as a compact advisor only when at least one condition holds:

- consequential architecture or authority boundary;
- conflicting requirements whose resolution changes the implementation;
- material review ambiguity after the primary review;
- repeated failure after one correctly prepared execution.

Do not use an advisor for routine lookup, simple bounded implementation, exact terminal reconciliation, or as a substitute for missing preflight. Send only the disputed evidence and decision question, never the full transcript. Receipt the reason, provider, usage, decision, and whether the advice changed the result.
