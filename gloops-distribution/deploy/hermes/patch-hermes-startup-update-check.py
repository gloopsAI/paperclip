#!/usr/bin/env python3
"""Disable Hermes' automatic startup update check in the GLoops runtime image."""

import os
from pathlib import Path


TARGET = Path(
    os.environ.get(
        "HERMES_STARTUP_UPDATE_CHECK_TARGET",
        "/opt/hermes/hermes_cli/banner.py",
    )
)
OLD = '''def prefetch_update_check():
    """Kick off update check in a background daemon thread."""
    def _run():
        global _update_result
        _update_result = check_for_updates()
        _update_check_done.set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
'''
NEW = '''def prefetch_update_check():
    """Keep GLoops runtime startup deterministic and free of update traffic."""
    return None
'''


source = TARGET.read_text()
if source.count(OLD) != 1:
    raise SystemExit("refusing to patch unexpected Hermes startup update-check source")
TARGET.write_text(source.replace(OLD, NEW))
if epoch_raw := os.environ.get("SOURCE_DATE_EPOCH"):
    epoch = int(epoch_raw)
    os.utime(TARGET, (epoch, epoch))
