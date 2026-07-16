#!/usr/bin/env python3

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("patch-hermes-startup-update-check.py")
ORIGINAL = '''def prefetch_update_check():
    """Kick off update check in a background daemon thread."""
    def _run():
        global _update_result
        _update_result = check_for_updates()
        _update_check_done.set()
    t = threading.Thread(target=_run, daemon=True)
    t.start()
'''


class StartupUpdateCheckPatchTest(unittest.TestCase):
    def run_patch(self, source: str) -> tuple[subprocess.CompletedProcess[str], str]:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "banner.py"
            target.write_text(source)
            env = {
                **os.environ,
                "HERMES_STARTUP_UPDATE_CHECK_TARGET": str(target),
                "SOURCE_DATE_EPOCH": "1783473071",
            }
            result = subprocess.run(
                ["python3", str(SCRIPT)],
                env=env,
                capture_output=True,
                text=True,
                check=False,
            )
            return result, target.read_text()

    def test_replaces_the_exact_background_network_entrypoint(self) -> None:
        result, patched = self.run_patch(f"prefix\n{ORIGINAL}suffix\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Keep GLoops runtime startup deterministic", patched)
        self.assertNotIn("threading.Thread", patched)
        self.assertNotIn("check_for_updates()", patched)

    def test_refuses_unknown_or_already_patched_source(self) -> None:
        result, unchanged = self.run_patch("def prefetch_update_check():\n    return None\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(unchanged, "def prefetch_update_check():\n    return None\n")
        self.assertIn("refusing to patch unexpected", result.stderr)


if __name__ == "__main__":
    unittest.main()
