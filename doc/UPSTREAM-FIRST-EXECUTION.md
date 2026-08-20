# Upstream-first execution

GLoops uses Paperclip's ordinary work lifecycle. The runtime does not add a
second admission system around it.

## The path

1. Create or select an issue and assign one agent.
2. Let Paperclip realize an isolated workspace from the configured project
   repository.
3. Run the assigned adapter in that workspace.
4. The agent implements, verifies, commits, pushes, and opens a pull request.
5. CI and a distinct reviewer evaluate the pull request.
6. Merge through the repository's normal protected-branch policy.
7. Continue the same issue in the same workspace when follow-up is needed.

Issue descriptions should explain intent and acceptance criteria, but their
Markdown shape is not an execution gate. Exact-head and clean-tree checks are
not repeated on continuations: the realized workspace and Git provide the
working state. Generated adapter instructions and skills live in a run-scoped
temporary bundle outside the Git worktree.

## What is deliberately not in the path

- issue-packet definition-of-ready admission
- custom execution-budget admission or guarded reset
- backlog-bankruptcy readmission lists
- controlled-swarm commissioning
- plane-steward repair loops
- per-continuation exact-head or clean-tree cancellation
- full Git bundle export/import when the SSH executor shares the workspace
  filesystem with Paperclip

Those former controls may remain readable in old receipts or compatibility
code, but the production configuration does not activate them. Operational
metrics may observe failures; they do not stop or rewrite work.

## Adapter-neutral agent playbook

This applies to Grok, Codex, Claude, Ollama-backed agents, and other coding
adapters.

- Read the issue, repository `AGENTS.md`, and the existing workspace state.
- Do not demand a second claim or exact-head declaration after Paperclip has
  assigned the issue and realized the workspace.
- Inspect before editing. Preserve unrelated changes.
- Work directly in the assigned isolated workspace. Do not create another
  clone or copy the repository through a temporary directory.
- Run the smallest relevant checks while iterating, then the repository's
  PR-ready verification before handoff.
- Commit only the intended files, push the assigned branch, and open or update
  one pull request.
- Report the exact PR/head and verification. If CI or review requests changes,
  continue in the same workspace and address them.
- Stop only for a real external authority decision, missing credential, or
  destructive ambiguity. Do not convert formatting preferences or advisory
  packet fields into blockers.

Paperclip owns assignment, workspace isolation, run identity, and lifecycle
state. GitHub owns CI, review, and merge policy. Agents own implementation and
truthful handoff. No model-specific shepherd is required.
