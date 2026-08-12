import os
from pathlib import Path
import subprocess
import sys
import unittest


SCRIPT = Path(__file__).with_name("verify-backlog-readmit-window.py")
ISSUE_ID = "123e4567-e89b-42d3-a456-426614174000"


class VerifyBacklogReadmitWindowTest(unittest.TestCase):
    def run_policy(self, **overrides: str | None) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS": "",
            "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS": "",
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED": "false",
        }
        for key, value in overrides.items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_default_freeze_is_valid(self) -> None:
        self.assertEqual(self.run_policy().returncode, 0)

    def test_one_matching_uncommissioned_work_item_window_is_valid(self) -> None:
        result = self.run_policy(
            PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=ISSUE_ID,
            PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=ISSUE_ID,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_mismatched_lists_fail_closed(self) -> None:
        result = self.run_policy(
            PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=ISSUE_ID,
            PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS="",
        )
        self.assertNotEqual(result.returncode, 0)

    def test_multiple_or_invalid_ids_fail_closed(self) -> None:
        for value in (f"{ISSUE_ID},{ISSUE_ID}", "not-a-uuid"):
            with self.subTest(value=value):
                result = self.run_policy(
                    PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=value,
                    PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=value,
                )
                self.assertNotEqual(result.returncode, 0)

    def test_commissioned_non_empty_window_fails_closed(self) -> None:
        result = self.run_policy(
            PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=ISSUE_ID,
            PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=ISSUE_ID,
            PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED="true",
        )
        self.assertNotEqual(result.returncode, 0)

    def test_both_keys_must_be_explicit(self) -> None:
        for key in (
            "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS",
            "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS",
        ):
            with self.subTest(key=key):
                self.assertNotEqual(self.run_policy(**{key: None}).returncode, 0)


if __name__ == "__main__":
    unittest.main()
