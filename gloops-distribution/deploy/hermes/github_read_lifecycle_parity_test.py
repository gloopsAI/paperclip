#!/usr/bin/env python3
"""WG-PLAT-018 source-level lifecycle parity for the read-only evidence lane.

Proves that a governed install -> activate -> stop -> backup -> rollback cannot
strand or omit EITHER the read broker (github-read-broker.py) OR the read-tool
client (github-read-tool.mjs), and that the activation receipt carries BOTH the
broker file hash AND the client file hash.

These are source-level assertions over the actual deploy scripts (the same
evidence reviewers inspect); they require no live systemd/root host.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

READ_BROKER_UNIT = "paperclip-github-read-broker.service"
READ_BROKER_FILE = "github-read-broker.py"
READ_TOOL_FILE = "github-read-tool.mjs"
READ_BROKER_RUNTIME = "/run/paperclip-github-read-broker"
READ_BROKER_STATE = "/var/lib/paperclip-gloops/github-read-broker"


def read(name: str) -> str:
    return (HERE / name).read_text(encoding="utf-8")


def lines_with(text: str, needle: str) -> list[str]:
    return [line for line in text.splitlines() if needle in line]


class LifecycleParityTests(unittest.TestCase):

    # -- install / mask -------------------------------------------------------

    def test_install_dark_installs_both_halves_immutably(self):
        script = read("install-dark.sh")
        # Broker AND client tool are both installed read-only (0555).
        self.assertRegex(
            script,
            rf"install -m 0555 [^\n]*{re.escape(READ_BROKER_FILE)}",
            "install-dark must install the read broker immutably",
        )
        self.assertRegex(
            script,
            rf"install -m 0555 [^\n]*{re.escape(READ_TOOL_FILE)}",
            "install-dark must install the read-tool client immutably",
        )
        # Service unit and durable state dir are provisioned.
        self.assertIn(READ_BROKER_UNIT, script)
        self.assertIn(READ_BROKER_STATE, script)

    def test_install_dark_masks_and_quiesces_read_broker(self):
        script = read("install-dark.sh")
        # The read broker rides the SAME governance lines as the push broker so
        # it can never be left enabled/active by a governed install.
        for action in ("systemctl mask", "systemctl reset-failed"):
            action_lines = [
                line for line in lines_with(script, action)
                if "paperclip-github-push-broker.service" in line
            ]
            self.assertTrue(action_lines, f"no push-broker {action} line found")
            for line in action_lines:
                self.assertIn(READ_BROKER_UNIT, line,
                              f"read broker missing from '{action}' parity line")
        self.assertIn(
            f"systemctl disable --now {READ_BROKER_UNIT}", script,
            "install-dark must disable the read broker",
        )
        # Refuse-active preflight must include the read broker.
        refuse = [line for line in script.splitlines()
                  if "for unit in" in line and "is-active" not in line]
        self.assertTrue(any(READ_BROKER_UNIT in line for line in refuse),
                        "install-dark refuse-active preflight omits read broker")

    # -- activate (unmask -> start -> verify -> stop -> remask) ---------------

    def test_activate_gives_read_broker_full_service_parity(self):
        script = read("activate-controlled-swarm.sh")
        self.assertIn(f"GITHUB_READ_BROKER='{READ_BROKER_UNIT}'", script)
        self.assertIn('systemctl start "${GITHUB_READ_BROKER}"', script)
        self.assertIn('systemctl is-active --quiet "${GITHUB_READ_BROKER}"', script)
        # unmask + cleanup stop/mask/reset-failed all carry the read broker.
        self.assertTrue(
            any('${GITHUB_READ_BROKER}' in line for line in lines_with(script, "systemctl unmask")),
            "activate unmask omits the read broker",
        )
        for action in ("systemctl stop", "systemctl mask", "systemctl reset-failed"):
            cleanup_lines = [line for line in lines_with(script, action)
                             if "${GITHUB_BROKER}" in line]
            self.assertTrue(cleanup_lines, f"no push-broker {action} cleanup line")
            for line in cleanup_lines:
                self.assertIn('${GITHUB_READ_BROKER}', line,
                              f"read broker missing from activate '{action}' parity")

    def test_activation_receipt_carries_both_file_hashes(self):
        script = read("activate-controlled-swarm.sh")
        # Both hashes are computed from the INSTALLED files ...
        self.assertRegex(
            script,
            rf"read_broker_sha256=\"sha256:\$\(sha256sum [^\n]*{re.escape(READ_BROKER_FILE)}",
        )
        self.assertRegex(
            script,
            rf"read_tool_sha256=\"sha256:\$\(sha256sum [^\n]*{re.escape(READ_TOOL_FILE)}",
        )
        # ... and both are written into the receipt, plus the service entry.
        self.assertIn("installedReadBrokerSha256", script)
        self.assertIn("installedReadToolSha256", script)
        self.assertIn('"githubReadBroker": "active"', script)

    # -- stop -----------------------------------------------------------------

    def test_stop_controlled_swarm_stops_and_masks_read_broker(self):
        script = read("stop-controlled-swarm.sh")
        # Explicit stop, plus mask-block membership and reset-failed loop
        # membership -> exactly the three governance touchpoints the push broker
        # gets in this same script.
        self.assertIn(f"systemctl stop {READ_BROKER_UNIT}", script)
        self.assertGreaterEqual(
            script.count(READ_BROKER_UNIT), 3,
            "stop must stop + mask + reset-failed the read broker",
        )

    # -- dark verify ----------------------------------------------------------

    def test_verify_dark_checks_read_broker_and_tool(self):
        script = read("verify-dark.sh")
        # inactive + masked + socket-absent + both files immutable.
        self.assertTrue(any(READ_BROKER_UNIT in line for line in
                            lines_with(script, "check_inactive") + lines_with(script, "for unit in")))
        self.assertIn(f"{READ_BROKER_UNIT} is masked", script)
        self.assertIn(f"{READ_BROKER_RUNTIME}/broker.sock", script)
        self.assertIn(READ_BROKER_FILE, script)
        self.assertIn(READ_TOOL_FILE, script)

    # -- backup ---------------------------------------------------------------

    def test_backup_dark_refuses_while_read_broker_active(self):
        script = read("backup-dark.sh")
        refuse = [line for line in script.splitlines() if "for unit in" in line]
        self.assertTrue(any(READ_BROKER_UNIT in line for line in refuse),
                        "backup-dark refuse-active loop omits the read broker")

    # -- rollback / verify-rollback -------------------------------------------

    def test_rollback_disables_masks_and_purges_read_broker_state(self):
        script = read("rollback.sh")
        refuse = [line for line in script.splitlines() if "for unit in" in line]
        self.assertTrue(any(READ_BROKER_UNIT in line for line in refuse),
                        "rollback refuse-active loop omits the read broker")
        for action in ("systemctl disable --now", "systemctl mask"):
            lines = [line for line in lines_with(script, action)
                     if "paperclip-github-push-broker.service" in line]
            self.assertTrue(lines, f"no push-broker {action} line in rollback")
            for line in lines:
                self.assertIn(READ_BROKER_UNIT, line,
                              f"read broker missing from rollback '{action}' parity")
        # Both runtime and durable state directories are purged.
        self.assertIn(READ_BROKER_RUNTIME, script)
        self.assertIn(READ_BROKER_STATE, script)

    def test_verify_rollback_requires_read_broker_inactive_and_masked(self):
        script = read("verify-rollback-dark.sh")
        loops = [line for line in script.splitlines() if "for unit in" in line]
        self.assertGreaterEqual(len(loops), 2)
        self.assertTrue(all(READ_BROKER_UNIT in line for line in loops),
                        "verify-rollback loops must all include the read broker")
        # The broker socket PATH (not just "not a socket") must be verified gone.
        self.assertIn(f"{READ_BROKER_RUNTIME}/broker.sock", script)
        # BOTH read-lane files are verified via the delegated snapshot helper,
        # invoked with the backup manifest so restore is checked by HASH.
        self.assertIn("read-lane-snapshot.sh", script)
        self.assertIn('verify_read_lane_restored "${READ_LANE_BACKUP_DIR:-}"', script)

    def test_socket_checks_require_path_absence_not_just_socket_type(self):
        # Adjacent fail-closed seam: a surviving plain file OR symlink at the
        # broker socket path must trip the guard, so both verifiers use path
        # absence (-e / -L), never a socket-type-only (-S) check for it.
        for name in ("verify-dark.sh", "verify-rollback-dark.sh"):
            script = read(name)
            self.assertIn(f"{READ_BROKER_RUNTIME}/broker.sock", script)
            socket_lines = [
                line for line in script.splitlines()
                if f"{READ_BROKER_RUNTIME}/broker.sock" in line
            ]
            self.assertTrue(socket_lines, f"{name} has no read-socket check")
            self.assertTrue(
                any("-e " in line or "! -e" in line for line in socket_lines)
                and any("-L " in line or "! -L" in line for line in socket_lines),
                f"{name} read-socket check is not path-absence (-e/-L)",
            )

    def test_backup_and_rollback_use_the_snapshot_helper(self):
        backup = read("backup-dark.sh")
        rollback = read("rollback.sh")
        install = read("install-dark.sh")
        # The helper is installed immutably and sourced by both scripts.
        self.assertRegex(install, r"install -m 0555 [^\n]*read-lane-snapshot\.sh")
        for script in (backup, rollback):
            self.assertIn("read-lane-snapshot.sh", script)
        self.assertIn("capture_read_lane_snapshot", backup)
        self.assertIn("restore_read_lane_snapshot", rollback)
        # --check semantically reconciles the manifest, not just SHA256SUMS.
        self.assertIn("check_read_lane_snapshot", rollback)
        # The read-lane manifest/snapshots are folded into SHA256SUMS.
        self.assertIn("read-lane.manifest", backup)

    # -- cross-cutting: both halves are always present together ---------------

    def test_neither_half_is_stranded_across_the_lifecycle(self):
        # The receipt binds BOTH halves; install ships BOTH halves.  If either
        # were dropped, one of these assertions fails -> the lane is stranded.
        install = read("install-dark.sh")
        self.assertIn(READ_BROKER_FILE, install)
        self.assertIn(READ_TOOL_FILE, install)
        activate = read("activate-controlled-swarm.sh")
        self.assertIn("installedReadBrokerSha256", activate)
        self.assertIn("installedReadToolSha256", activate)


if __name__ == "__main__":
    unittest.main(verbosity=2)
