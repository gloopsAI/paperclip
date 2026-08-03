import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).with_name("paperclip-hostctl.py")


class PaperclipHostctlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.runtime = self.root / "runtime.env"
        self.runtime.write_text(
            "\n".join(
                (
                    "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
                    "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=",
                    "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=",
                    "HEARTBEAT_SCHEDULER_ENABLED=false",
                    "PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false",
                    "PAPERCLIP_IMAGE=ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64,
                    "",
                )
            ),
            encoding="utf-8",
        )
        self.approved = self.root / "approved-image"
        self.approved.write_text("ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64 + "\n")
        self.systemctl = self.root / "systemctl"
        self.systemctl.write_text(
            """#!/usr/bin/env python3
import os,sys,time
action=sys.argv[1]
if action == 'is-active':
    print('active')
    raise SystemExit(0)
if action == os.environ.get('FAKE_SYSTEMCTL_SLEEP_ACTION'):
    time.sleep(float(os.environ.get('FAKE_SYSTEMCTL_SLEEP_SECONDS','0')))
raise SystemExit(0)
""",
            encoding="utf-8",
        )
        self.systemctl.chmod(0o755)
        self.env = {
            **os.environ,
            "PAPERCLIP_HOSTCTL_TEST_MODE": "1",
            "PAPERCLIP_HOSTCTL_LOCK": str(self.root / "writer.lock"),
            "PAPERCLIP_HOSTCTL_JOURNAL": str(self.root / "journal.jsonl"),
            "PAPERCLIP_HOSTCTL_HOLDER": str(self.root / "holder.json"),
            "PAPERCLIP_HOSTCTL_RUNTIME_ENV": str(self.runtime),
            "PAPERCLIP_HOSTCTL_APPROVED_IMAGE": str(self.approved),
            "PAPERCLIP_HOSTCTL_SYSTEMCTL": str(self.systemctl),
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def command(self, *args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(SCRIPT), *args],
            env=self.env,
            text=True,
            capture_output=True,
            check=check,
            timeout=15,
        )

    def identity(self) -> list[str]:
        return [
            "--agent-slug", "codex-lead",
            "--session-id", "test-session",
            "--mission-id", "host-lock-test",
        ]

    def reconcile(self) -> subprocess.CompletedProcess[str]:
        return self.command("reconcile", *self.identity(), "--reason", "test baseline", check=True)

    def wait_for_holder(self) -> None:
        deadline = time.monotonic() + 5
        holder = self.root / "holder.json"
        while not holder.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue(holder.exists())

    def journal(self) -> list[dict]:
        return [json.loads(line) for line in (self.root / "journal.jsonl").read_text().splitlines()]

    def test_a1_second_writer_fails_fast_and_names_holder(self) -> None:
        self.reconcile()
        env = {**self.env, "FAKE_SYSTEMCTL_SLEEP_ACTION": "restart", "FAKE_SYSTEMCTL_SLEEP_SECONDS": "1"}
        first = subprocess.Popen(
            [
                sys.executable, str(SCRIPT), "apply", *self.identity(),
                "--intent", "first writer", "--systemctl", "restart:paperclip-gloops.service",
            ],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.wait_for_holder()
        second = self.command(
            "apply", *self.identity(), "--intent", "second writer",
            "--systemctl", "restart:paperclip-gloops.service",
        )
        self.assertNotEqual(second.returncode, 0)
        self.assertIn("host writer lock held by", second.stderr)
        self.assertIn("codex-lead", second.stderr)
        first_stdout, first_stderr = first.communicate(timeout=5)
        self.assertEqual(first.returncode, 0, first_stderr or first_stdout)

    def test_a2_sigterm_leaves_dangling_pre_and_requires_reconcile(self) -> None:
        self.reconcile()
        env = {**self.env, "FAKE_SYSTEMCTL_SLEEP_ACTION": "restart", "FAKE_SYSTEMCTL_SLEEP_SECONDS": "60"}
        holder = subprocess.Popen(
            [
                sys.executable, str(SCRIPT), "apply", *self.identity(),
                "--intent", "terminated writer", "--systemctl", "restart:paperclip-gloops.service",
            ],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.wait_for_holder()
        holder.terminate()
        holder.communicate(timeout=5)
        refused = self.command(
            "apply", *self.identity(), "--intent", "must refuse",
            "--systemctl", "restart:paperclip-gloops.service",
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("unreconciled writer window", refused.stderr)
        reconciled = self.command(
            "reconcile", *self.identity(), "--reason", "dead holder verified", check=True,
        )
        self.assertTrue(json.loads(reconciled.stdout)["reconciled_dangling"])
        self.assertIn("break", [entry["event"] for entry in self.journal()])

    def test_a3_out_of_band_runtime_edit_refuses_mutation(self) -> None:
        self.reconcile()
        self.runtime.write_text(self.runtime.read_text() + "# out-of-band\n", encoding="utf-8")
        refused = self.command(
            "apply", *self.identity(), "--intent", "hash mismatch",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true",
        )
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("runtime.env hash mismatch refuses mutation", refused.stderr)

    def test_a4_commission_restore_journal_reconstructs_window(self) -> None:
        self.reconcile()
        commissioned = self.command(
            "apply", *self.identity(), "--intent", "commission one uuid",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=issue-1",
            "--set", "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=issue-1",
            "--systemctl", "restart:paperclip-gloops.service",
            check=True,
        )
        restored = self.command(
            "apply", *self.identity(), "--intent", "restore freeze",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=",
            "--set", "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=",
            "--systemctl", "restart:paperclip-gloops.service",
            check=True,
        )
        self.assertTrue(json.loads(commissioned.stdout)["ok"])
        final = json.loads(restored.stdout)["post_state"]
        self.assertEqual(final["commissioned"], "false")
        self.assertEqual(final["controlled_swarm_readmit"], "")
        self.assertEqual(final["backlog_bankruptcy_readmit"], "")
        events = self.journal()
        self.assertEqual([entry["event"] for entry in events].count("pre"), 2)
        self.assertEqual([entry["event"] for entry in events].count("post"), 2)
        for entry in (event for event in events if event["event"] == "post"):
            self.assertIn("runtime_env_sha256", entry)
            self.assertIn("unit_state", entry)
            self.assertIn("exit_status", entry)


if __name__ == "__main__":
    unittest.main()
