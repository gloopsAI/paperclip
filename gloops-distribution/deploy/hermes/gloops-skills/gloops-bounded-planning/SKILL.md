---
name: gloops-bounded-planning
description: Convert a defined outcome into a concise, dependency-aware execution plan with explicit assumptions, verification, non-goals, and authority gates. Use when implementation order or ownership is genuinely uncertain, not for work already specified well enough to execute.
---

# GLoops bounded planning

Return exactly:

- known facts and no more than three material assumptions;
- an ordered plan of at most six steps;
- the verification evidence for each step;
- dependencies and the one accountable owner;
- explicit non-goals;
- any decision that genuinely requires human authority.

Prefer existing platform primitives and workflows. Do not invent new infrastructure, schemas, agents, or governance unless the outcome cannot be met without them. End with the next executable action, not another planning request.

Terminal state: `ready` when an implementer can execute without rediscovering scope; otherwise `blocked` with the one missing decision or fact.
