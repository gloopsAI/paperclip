---
name: gloops-focused-review
description: Review one exact diff or artifact for material correctness, concurrency, lifecycle, evidence, or authority defects and return a small number of actionable findings. Use for independent review after implementation or when a disputed technical claim needs code-grounded adjudication.
---

# GLoops focused review

1. Read the objective, acceptance criteria, exact head, and changed code.
2. Trace behavior far enough to confirm actual semantics, including null, duplicate, concurrency, and terminal-state cases when relevant.
3. Check tests and receipts against the behavior they claim to prove.
4. Return at most three material findings, ordered by impact, each with exact evidence and the smallest viable correction.
5. State `accepted` only when no material finding remains at the reviewed head.

Do not reward verbosity, speculate without code evidence, or propose unrelated improvements. Escalate to the Codex advisor only when the primary review leaves a consequential ambiguity; send the disputed code and question, not the full run history.

Terminal state: `accepted`, `changes-required`, or `blocked`, always tied to an exact artifact identity.
