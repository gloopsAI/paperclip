#!/usr/bin/env python3
"""Fail closed unless backlog readmission is frozen or one exact governed UUID."""

from __future__ import annotations

import os
import re
import sys


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)
BACKLOG_KEY = "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS"
SWARM_KEY = "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS"
COMMISSIONED_KEY = "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED"


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def main() -> int:
    if BACKLOG_KEY not in os.environ:
        return fail(f"{BACKLOG_KEY} must be explicitly present")
    if SWARM_KEY not in os.environ:
        return fail(f"{SWARM_KEY} must be explicitly present")

    backlog = os.environ[BACKLOG_KEY].strip().lower()
    swarm = os.environ[SWARM_KEY].strip().lower()
    commissioned = os.environ.get(COMMISSIONED_KEY, "")

    if not backlog and not swarm:
        return 0
    if not backlog or backlog != swarm:
        return fail("backlog and controlled-swarm readmission must name the same single UUID")
    if "," in backlog or not UUID_RE.fullmatch(backlog):
        return fail("readmission window must contain exactly one canonical issue UUID")
    if commissioned != "false":
        return fail("single-item general readmission requires commissioned=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
