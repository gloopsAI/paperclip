#!/usr/bin/env python3
"""Apply the one GLoops-owned Hermes command-security correction."""

import os
from pathlib import Path


TARGET = Path("/opt/hermes/tools/tirith_security.py")
OLD = '''    if _circuit_open:
        return {"action": "allow", "findings": [], "summary": "tirith disabled (circuit breaker)"}
'''
NEW = '''    if _circuit_open:
        if cfg["tirith_fail_open"]:
            return {"action": "allow", "findings": [], "summary": "tirith disabled (circuit breaker)"}
        return {
            "action": "block",
            "findings": [],
            "summary": "tirith disabled (circuit breaker, fail-closed)",
        }
'''


source = TARGET.read_text()
if source.count(OLD) != 1:
    raise SystemExit("refusing to patch unexpected Hermes command-security source")
TARGET.write_text(source.replace(OLD, NEW))
epoch = int(os.environ["SOURCE_DATE_EPOCH"])
os.utime(TARGET, (epoch, epoch))
