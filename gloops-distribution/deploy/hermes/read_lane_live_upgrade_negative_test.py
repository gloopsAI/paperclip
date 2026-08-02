"""Source-level negative proof for read-lane-live-upgrade.sh.

The live host-only wrapper must upgrade ONLY the two read-lane files and control
ONLY the read broker unit.  It must never touch the Paperclip container, any
container image/digest, runtime.env, or any other systemd unit, and must never
enable/disable the unit.  It must bind the reviewed snapshot primitives and run
BOTH governed no-work proofs.  These are exact-source assertions, complementary
to the executable behavior suite (read_lane_live_upgrade_test.sh).
"""

import os
import re
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
WRAPPER = os.path.join(HERE, "read-lane-live-upgrade.sh")

with open(WRAPPER, "r", encoding="utf-8") as _fh:
    SRC = _fh.read()


class ReadLaneLiveUpgradeSourceNegative(unittest.TestCase):
    def test_bash_syntax_clean(self):
        self.assertEqual(subprocess.run(["bash", "-n", WRAPPER]).returncode, 0)

    def test_no_container_or_runtime_env_mutations(self):
        forbidden = [
            r"runtime\.env",
            r"approved-image",
            r"PAPERCLIP_IMAGE",
            r"\bdocker\b",
            r"\bpodman\b",
            r"\bnerdctl\b",
            r"install-dark",
            r"backup-dark",
            r"rollback\.sh",
        ]
        for pat in forbidden:
            self.assertIsNone(
                re.search(pat, SRC), f"wrapper must not reference {pat!r}"
            )

    def test_never_enables_or_disables_the_unit(self):
        self.assertIsNone(re.search(r"systemctl\s+(?:--\S+\s+)*enable\b", SRC))
        self.assertIsNone(re.search(r"systemctl\s+(?:--\S+\s+)*disable\b", SRC))

    def test_only_the_read_broker_service_is_referenced(self):
        self.assertIn("paperclip-github-read-broker.service", SRC)
        units = set(re.findall(r"[A-Za-z0-9_.@-]+\.service", SRC))
        self.assertEqual(
            units,
            {"paperclip-github-read-broker.service"},
            f"unexpected systemd units referenced: {units}",
        )

    def test_binds_reviewed_snapshot_primitives(self):
        for fn in (
            "capture_read_lane_snapshot",
            "check_read_lane_snapshot",
            "restore_read_lane_snapshot",
            "verify_read_lane_restored",
        ):
            self.assertIn(fn, SRC)
        self.assertRegex(SRC, r'source\s+"\$\{SELF_DIR\}/read-lane-snapshot\.sh"')

    def test_runs_both_no_work_proofs(self):
        self.assertGreaterEqual(SRC.count("_check_live_runs"), 2)
        self.assertIn("/live-runs", SRC)

    def test_token_stripped_from_child_environment(self):
        self.assertIn("export -n PAPERCLIP_API_TOKEN", SRC)

    def test_single_invocation_lock_before_staging(self):
        self.assertIn("flock -n 9", SRC)
        main_i = SRC.index("main() {")
        lock_i = SRC.index("flock -n 9", main_i)
        stage_i = SRC.index("_stage_pair", main_i)
        self.assertLess(lock_i, stage_i)

    def test_pre_apply_revalidation_precedes_apply(self):
        ru = SRC[SRC.index("_run_upgrade() {"):]
        self.assertLess(
            ru.index("verify_read_lane_restored"), ru.index("_apply_pair")
        )


if __name__ == "__main__":
    unittest.main()
