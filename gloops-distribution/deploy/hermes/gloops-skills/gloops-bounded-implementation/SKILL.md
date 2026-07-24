---
name: gloops-bounded-implementation
description: Implement one explicitly prepared code or configuration change in a verified writable workspace, run the named verification, and report exact terminal evidence. Use only after GLoops task preparation has established the repository, ref, allowed files, tools, and acceptance command.
---

# GLoops bounded implementation

1. Confirm the packet names a writable workspace, repository ref, allowed files, outcome, non-goals, and verification command.
2. Inspect only the minimum code required to locate the change.
3. Make the smallest coherent change that satisfies the outcome.
4. Run the exact verification command once. Fix only failures caused by the change and within scope.
5. Report changed files, verification result, resulting commit or diff identity, and remaining work.

Do not edit outside the allowed files, create unrelated receipts or documentation, redesign settled architecture, or silently switch workspaces. Stop before model work when preparation is incomplete.

Terminal state: `done` requires a materialized diff plus passing named verification. Text, a plan, or an unverified patch is not completion.
