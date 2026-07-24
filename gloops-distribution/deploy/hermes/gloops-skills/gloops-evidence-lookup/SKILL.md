---
name: gloops-evidence-lookup
description: Answer exact questions about repositories, pull requests, issues, Paperclip state, configuration, or runtime evidence with current citations and no mutation. Use for read-only status, inventory, ownership, version, or value lookups after task preparation.
---

# GLoops evidence lookup

1. Restate the exact entity and requested fields.
2. Use the smallest deterministic source that can answer it. Prefer a purpose-built API or local command over broad agent exploration.
3. Query current state once unless sources conflict.
4. Return the requested values first, then source, freshness, and evidence grade.
5. Distinguish verified facts, inference, and unavailable data.

Do not mutate state, create tracking work, invent missing receipts, or broaden the question. If the source is unavailable, return one exact blocker and the source needed to resolve it.

Terminal state: `done` only when every requested field is answered or explicitly reported unavailable with supporting evidence.
