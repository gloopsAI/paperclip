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
                    "HEARTBEAT_SCHEDULER_ENABLED=false",
                    "PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=true",
                    "PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS=",
                    "PAPERCLIP_ALLOWED_HOSTNAMES=ubuntu-hermes-nyc1.taild219d6.ts.net,127.0.0.1,localhost",
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

    def test_a4_exact_buzz_hostname_is_an_allowlisted_receipted_mutation(self) -> None:
        self.reconcile()
        allowed = self.command(
            "apply", *self.identity(), "--intent", "allow exact Buzz endpoint",
            "--set",
            "PAPERCLIP_ALLOWED_HOSTNAMES="
            "ubuntu-hermes-nyc1.taild219d6.ts.net,paperclip.gloops.ai,127.0.0.1,localhost",
            check=False,
        )
        self.assertEqual(allowed.returncode, 0, allowed.stderr or allowed.stdout)
        self.assertIn("paperclip.gloops.ai", self.runtime.read_text(encoding="utf-8"))
        events = self.journal()
        self.assertEqual(events[-2]["event"], "pre")
        self.assertEqual(events[-1]["event"], "post")
        self.assertEqual(events[-1]["exit_status"], 0)

    def test_a5_commission_restore_journal_reconstructs_transition(self) -> None:
        self.reconcile()
        commissioned = self.command(
            "apply", *self.identity(), "--intent", "commission controlled swarm",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true",
            "--systemctl", "restart:paperclip-gloops.service",
            check=True,
        )
        restored = self.command(
            "apply", *self.identity(), "--intent", "end controlled swarm campaign",
            "--set", "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            "--systemctl", "restart:paperclip-gloops.service",
            check=True,
        )
        self.assertTrue(json.loads(commissioned.stdout)["ok"])
        final = json.loads(restored.stdout)["post_state"]
        self.assertEqual(final["commissioned"], "false")
        events = self.journal()
        self.assertEqual([entry["event"] for entry in events].count("pre"), 2)
        self.assertEqual([entry["event"] for entry in events].count("post"), 2)
        for entry in (event for event in events if event["event"] == "post"):
            self.assertIn("runtime_env_sha256", entry)
            self.assertIn("unit_state", entry)
            self.assertIn("exit_status", entry)

    def test_a8_reconciled_local_adapters_are_an_allowlisted_receipted_mutation(self) -> None:
        self.reconcile()
        result = self.command(
            "apply", *self.identity(), "--intent", "activate reconciled local adapters",
            "--set", "PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS=codex_local,grok_local",
            check=True,
        )
        self.assertTrue(json.loads(result.stdout)["ok"])
        self.assertIn(
            "PAPERCLIP_EXECUTION_RECONCILED_ADAPTERS=codex_local,grok_local",
            self.runtime.read_text(encoding="utf-8"),
        )
        self.assertEqual([entry["event"] for entry in self.journal()][-2:], ["pre", "post"])

    def test_a9_managed_company_codex_home_is_exact_and_receipted(self) -> None:
        expected = (
            "/home/paperclip/.paperclip/instances/default/companies/"
            "89ed0964-d918-4fcc-b830-5be49d2d4089/codex-home"
        )
        self.reconcile()
        accepted = self.command(
            "apply", *self.identity(), "--intent", "bind subscription home",
            "--set", f"CODEX_HOME={expected}",
            check=True,
        )
        self.assertTrue(json.loads(accepted.stdout)["ok"])
        self.assertIn(f"CODEX_HOME={expected}", self.runtime.read_text(encoding="utf-8"))
        before = self.runtime.read_text(encoding="utf-8")
        rejected = self.command(
            "apply", *self.identity(), "--intent", "reject arbitrary home",
            "--set", "CODEX_HOME=/tmp/attacker-controlled",
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("exact managed company Codex home", rejected.stderr)
        self.assertEqual(self.runtime.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
