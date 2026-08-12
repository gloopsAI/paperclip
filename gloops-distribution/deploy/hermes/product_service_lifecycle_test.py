#!/usr/bin/env python3
"""Network-free behavioral proof for campaign/product lifecycle separation."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess
import tempfile
import unittest


HERE = pathlib.Path(__file__).resolve().parent


class ProductServiceLifecycleTest(unittest.TestCase):
    def test_restore_obligation_survives_broker_retries_and_failures(self) -> None:
        with tempfile.TemporaryDirectory(prefix="paperclip-campaign-lifecycle-", dir="/tmp") as raw:
            root = pathlib.Path(raw)
            config = root / "config"
            state = root / "state"
            controlled = root / "controlled"
            manual_state = root / "manual-stop"
            bin_dir = root / "bin"
            log = root / "commands.log"
            service_state = root / "service-state.json"
            for directory in (config, state, controlled, bin_dir):
                directory.mkdir(parents=True)
            commissioning = controlled / "commissioning.json"
            units = {
                "paperclip-gloops.service",
                "paperclip-controlled-swarm.service",
                "paperclip-hermes-execution.service",
                "paperclip-github-push-broker.service",
                "paperclip-github-read-broker.service",
                "paperclip-platform-ops-broker.service",
                "paperclip-campaign-deadman.service",
                "paperclip-controlled-swarm-commissioning-recovery.service",
                "paperclip-gloops-handshake.service",
                "paperclip-hermes-handshake.service",
                "paperclip-hermes-handshake-egress.service",
            }
            campaign_unit = (HERE / "paperclip-controlled-swarm.service").read_text(
                encoding="utf-8"
            )
            clear_hook = (
                "ExecStop=/usr/local/lib/paperclip-gloops/"
                "github-app-credentials.py clear-projector"
            )
            revoke_hook = (
                "ExecStopPost=-/usr/local/lib/paperclip-gloops/"
                "github-app-credentials.py revoke-projector"
            )
            self.assertIn(clear_hook, campaign_unit)
            self.assertIn(revoke_hook, campaign_unit)
            self.assertLess(
                campaign_unit.index(clear_hook),
                campaign_unit.index("ExecStop=/usr/bin/docker stop"),
            )
            self.assertLess(
                campaign_unit.index(revoke_hook),
                campaign_unit.index("ExecStopPost=-/usr/bin/docker rm"),
            )
            service_state.write_text(
                json.dumps({
                    "active": [],
                    "masked": sorted(units),
                    "portOwner": None,
                    "generalStartFailuresRemaining": 100,
                    "projectorOwner": None,
                    "projectorTokenPresent": False,
                    "projectorMarkerPresent": False,
                    "projectorCleanupEvents": [],
                }),
                encoding="utf-8",
            )

            systemctl = bin_dir / "systemctl"
            systemctl.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                f"state_path = pathlib.Path({str(service_state)!r})\n"
                f"log_path = pathlib.Path({str(log)!r})\n"
                f"campaign_clear_hook = {bool(clear_hook in campaign_unit)!r}\n"
                f"campaign_revoke_hook = {bool(revoke_hook in campaign_unit)!r}\n"
                "args = sys.argv[1:]\n"
                "def record(message):\n"
                "    with log_path.open('a', encoding='utf-8') as fh: fh.write(message + '\\n')\n"
                "record(' '.join(args))\n"
                "state = json.loads(state_path.read_text(encoding='utf-8'))\n"
                "active, masked = set(state['active']), set(state['masked'])\n"
                "command = args[0]\n"
                "targets = [value for value in args[1:] if not value.startswith('-')]\n"
                "if command == 'unmask': masked.difference_update(targets)\n"
                "elif command == 'mask':\n"
                "    masked.update(targets); active.difference_update(targets)\n"
                "elif command == 'start':\n"
                "    for unit in targets:\n"
                "        if unit in masked: sys.exit(1)\n"
                "        if unit == 'paperclip-controlled-swarm.service':\n"
                "            active.discard('paperclip-gloops.service'); state['portOwner'] = unit\n"
                "            state['projectorOwner'] = 'campaign'\n"
                "            state['projectorTokenPresent'] = True\n"
                "            state['projectorMarkerPresent'] = True\n"
                "        elif unit == 'paperclip-gloops.service':\n"
                "            if 'paperclip-controlled-swarm.service' in active: sys.exit(1)\n"
                "            if state.get('generalStartFailuresRemaining', 0) > 0:\n"
                "                state['generalStartFailuresRemaining'] -= 1\n"
                "                state['active'], state['masked'] = sorted(active), sorted(masked)\n"
                "                state_path.write_text(json.dumps(state), encoding='utf-8')\n"
                "                sys.exit(1)\n"
                "            state['portOwner'] = unit\n"
                "            state['projectorOwner'] = 'general'\n"
                "            state['projectorTokenPresent'] = True\n"
                "            state['projectorMarkerPresent'] = True\n"
                "        active.add(unit)\n"
                "elif command == 'stop':\n"
                "    for unit in targets:\n"
                "        if unit == 'paperclip-controlled-swarm.service' and unit in active:\n"
                "            if campaign_clear_hook:\n"
                "                record('hook clear-projector paperclip-controlled-swarm.service')\n"
                "                state['projectorTokenPresent'] = False\n"
                "                state['projectorMarkerPresent'] = False\n"
                "                state['projectorCleanupEvents'].append('clear-projector')\n"
                "            if campaign_revoke_hook:\n"
                "                record('hook revoke-projector paperclip-controlled-swarm.service')\n"
                "                state['projectorTokenPresent'] = False\n"
                "                state['projectorMarkerPresent'] = False\n"
                "                state['projectorOwner'] = None\n"
                "                state['projectorCleanupEvents'].append('revoke-projector')\n"
                "        active.discard(unit)\n"
                "    if state.get('portOwner') in targets: state['portOwner'] = None\n"
                "elif command == 'is-active':\n"
                "    raise SystemExit(0 if targets[-1] in active else 3)\n"
                "state['active'], state['masked'] = sorted(active), sorted(masked)\n"
                "state_path.write_text(json.dumps(state), encoding='utf-8')\n",
                encoding="utf-8",
            )
            docker = bin_dir / "docker"
            docker.write_text(
                "#!/bin/sh\n"
                f"printf 'docker %s\\n' \"$*\" >> {str(log)!r}\n"
                "exit 0\n",
                encoding="utf-8",
            )
            set_commissioning = bin_dir / "set-commissioning"
            set_commissioning.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            verify_deadman = bin_dir / "verify-deadman"
            verify_deadman.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            verify_profile = bin_dir / "verify-profile"
            verify_profile.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            curl = bin_dir / "curl"
            curl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            flock = bin_dir / "flock"
            flock.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            for command in (
                systemctl,
                docker,
                set_commissioning,
                verify_deadman,
                verify_profile,
                curl,
                flock,
            ):
                command.chmod(0o755)
            env = {
                **os.environ,
                "PATH": f"{bin_dir}:{os.environ['PATH']}",
                "PAPERCLIP_CAMPAIGN_TEST_MODE": "network-free",
                "PAPERCLIP_CAMPAIGN_CONFIG_DIR": str(config),
                "PAPERCLIP_CAMPAIGN_STATE_DIR": str(state),
                "PAPERCLIP_CAMPAIGN_SYSTEMCTL": str(systemctl),
                "PAPERCLIP_CAMPAIGN_DOCKER": str(docker),
                "PAPERCLIP_CAMPAIGN_COMMISSIONING_MARKER": str(
                    config / "CONTROLLED_SWARM_COMMISSIONING_APPROVED"
                ),
                "PAPERCLIP_CAMPAIGN_COMMISSIONING_RECEIPT": str(commissioning),
                "PAPERCLIP_CAMPAIGN_SET_COMMISSIONING": str(set_commissioning),
                "PAPERCLIP_CAMPAIGN_EPOCH_PATH": str(state / "epoch.json"),
                "PAPERCLIP_CAMPAIGN_VERIFY_DEADMAN": str(verify_deadman),
                "PAPERCLIP_CAMPAIGN_VERIFY_PROFILE": str(verify_profile),
                "PAPERCLIP_CAMPAIGN_CURL": str(curl),
                "PAPERCLIP_CONTROLLED_SWARM_TEST_MODE": "network-free",
                "PAPERCLIP_CONTROLLED_SWARM_CONFIG_DIR": str(config),
                "PAPERCLIP_CONTROLLED_SWARM_LIB_DIR": str(HERE),
                "PAPERCLIP_CONTROLLED_SWARM_STATE_DIR": str(manual_state),
                "PAPERCLIP_CONTROLLED_SWARM_LOCK": str(root / "controlled-swarm.lock"),
                "PAPERCLIP_CONTROLLED_SWARM_STOP_ACTUATOR": str(
                    HERE / "campaign-deadman-stop.sh"
                ),
                "PAPERCLIP_CONTROLLED_SWARM_SET_COMMISSIONING": str(
                    set_commissioning
                ),
            }
            activation = subprocess.run(
                [str(HERE / "activate-controlled-swarm-runtime.sh")],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(activation.returncode, 0, activation.stderr)
            self.assertTrue((config / "CONTROLLED_SWARM_RUNTIME_APPROVED").exists())
            activation_commands = log.read_text(encoding="utf-8")
            self.assertIn("start paperclip-controlled-swarm.service", activation_commands)
            self.assertNotIn("start paperclip-gloops.service", activation_commands)
            self.assertIn("start paperclip-hermes-execution.service", activation_commands)
            for broker in (
                "paperclip-github-push-broker.service",
                "paperclip-github-read-broker.service",
                "paperclip-platform-ops-broker.service",
            ):
                self.assertIn(f"start {broker}", activation_commands)
            active_after_activation = json.loads(service_state.read_text(encoding="utf-8"))
            self.assertEqual(
                active_after_activation["portOwner"],
                "paperclip-controlled-swarm.service",
            )
            self.assertNotIn("paperclip-gloops.service", active_after_activation["active"])
            result = subprocess.run(
                [str(HERE / "stop-controlled-swarm.sh")],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0, result.stderr)
            pending = state / "product-restore-pending.json"
            self.assertTrue(pending.exists())
            self.assertEqual(pending.stat().st_mode & 0o777, 0o600)
            self.assertFalse((config / "CONTROLLED_SWARM_RUNTIME_APPROVED").exists())
            first_obligation = json.loads(pending.read_text(encoding="utf-8"))[
                "obligationId"
            ]
            failed_receipt = json.loads((state / "last-stop.json").read_text(encoding="utf-8"))
            self.assertEqual(failed_receipt["outcome"], "product_restore_failed")
            self.assertFalse((manual_state / "last-manual-stop.json").exists())
            failed_state = json.loads(service_state.read_text(encoding="utf-8"))
            self.assertNotIn("paperclip-gloops.service", failed_state["active"])
            self.assertIsNone(failed_state["projectorOwner"])
            self.assertFalse(failed_state["projectorTokenPresent"])
            self.assertFalse(failed_state["projectorMarkerPresent"])
            self.assertEqual(
                failed_state["projectorCleanupEvents"],
                ["clear-projector", "revoke-projector"],
            )
            failed_commands = log.read_text(encoding="utf-8")
            self.assertLess(
                failed_commands.index("hook clear-projector"),
                failed_commands.index("start paperclip-gloops.service"),
            )
            self.assertLess(
                failed_commands.index("hook revoke-projector"),
                failed_commands.index("start paperclip-gloops.service"),
            )

            # Model the broker retrying the same actuator after the campaign
            # marker has already been removed. Two transient failures remain,
            # so the retry must consume them and restore on its third attempt.
            failed_state["generalStartFailuresRemaining"] = 2
            service_state.write_text(json.dumps(failed_state), encoding="utf-8")
            retry = subprocess.run(
                [str(HERE / "stop-controlled-swarm.sh")],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(retry.returncode, 0, retry.stderr)
            self.assertFalse(pending.exists())
            self.assertTrue(first_obligation)

            self.assertTrue((config / "ACTIVATION_APPROVED").exists())
            self.assertTrue((config / "HERMES_EXECUTION_APPROVED").exists())
            self.assertFalse((config / "HERMES_HANDSHAKE_APPROVED").exists())
            self.assertFalse((config / "CONTROLLED_SWARM_RUNTIME_APPROVED").exists())
            self.assertFalse(commissioning.exists())
            final_state = json.loads(service_state.read_text(encoding="utf-8"))
            self.assertEqual(final_state["portOwner"], "paperclip-gloops.service")
            self.assertIn("paperclip-gloops.service", final_state["active"])
            self.assertNotIn("paperclip-controlled-swarm.service", final_state["active"])
            self.assertNotIn("paperclip-gloops.service", final_state["masked"])
            self.assertEqual(final_state["generalStartFailuresRemaining"], 0)
            self.assertEqual(final_state["projectorOwner"], "general")
            commands = log.read_text(encoding="utf-8")
            stop_commands = "\n".join(
                line for line in commands.splitlines() if line.startswith("stop ")
            )
            for general in (
                "paperclip-gloops.service",
                "paperclip-hermes-execution.service",
                "paperclip-github-push-broker.service",
                "paperclip-github-read-broker.service",
                "paperclip-platform-ops-broker.service",
            ):
                self.assertNotIn(general, stop_commands)
            for campaign_only in (
                "paperclip-controlled-swarm.service",
                "paperclip-gloops-handshake.service",
                "paperclip-hermes-handshake.service",
                "paperclip-hermes-handshake-egress.service",
                "paperclip-controlled-swarm-commissioning-recovery.service",
            ):
                self.assertIn(campaign_only, commands)
            receipt = json.loads((state / "last-stop.json").read_text(encoding="utf-8"))
            self.assertEqual(receipt["reason"], "operator_requested_stop")
            self.assertEqual(receipt["outcome"], "product_restored")
            manual_receipt = json.loads(
                (manual_state / "last-manual-stop.json").read_text(encoding="utf-8")
            )
            self.assertEqual(manual_receipt["outcome"], "product_continues")

            # A redundant retry after success has no campaign marker or
            # pending obligation; it must preserve the product-restored truth.
            receipt_bytes = (state / "last-stop.json").read_bytes()
            settled_retry = subprocess.run(
                [str(HERE / "stop-controlled-swarm.sh")],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(settled_retry.returncode, 0, settled_retry.stderr)
            self.assertEqual((state / "last-stop.json").read_bytes(), receipt_bytes)
            docker_commands = [
                line
                for line in log.read_text(encoding="utf-8").splitlines()
                if line.startswith("docker ")
            ]
            self.assertNotIn(
                "docker rm -f paperclip-gloops",
                docker_commands,
                "a campaign stop retry must never delete the general product container",
            )

            # A new campaign creates a new restoration obligation. Permanent
            # start failure must remain nonzero and truthful on every retry.
            second_activation = subprocess.run(
                [str(HERE / "activate-controlled-swarm-runtime.sh")],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(second_activation.returncode, 0, second_activation.stderr)
            persistent_state = json.loads(service_state.read_text(encoding="utf-8"))
            persistent_state["generalStartFailuresRemaining"] = 100
            service_state.write_text(json.dumps(persistent_state), encoding="utf-8")
            persistent_obligation = None
            for _ in range(2):
                persistent = subprocess.run(
                    [str(HERE / "stop-controlled-swarm.sh")],
                    env=env,
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(persistent.returncode, 0, persistent.stderr)
                self.assertTrue(pending.exists())
                obligation = json.loads(pending.read_text(encoding="utf-8"))[
                    "obligationId"
                ]
                if persistent_obligation is None:
                    persistent_obligation = obligation
                self.assertEqual(obligation, persistent_obligation)
                persistent_receipt = json.loads(
                    (state / "last-stop.json").read_text(encoding="utf-8")
                )
                self.assertEqual(
                    persistent_receipt["outcome"], "product_restore_failed"
                )
            still_failed = json.loads(service_state.read_text(encoding="utf-8"))
            self.assertEqual(still_failed["generalStartFailuresRemaining"], 94)
            self.assertIsNone(still_failed["projectorOwner"])
            self.assertFalse(still_failed["projectorTokenPresent"])
            self.assertFalse(still_failed["projectorMarkerPresent"])
            self.assertEqual(
                still_failed["projectorCleanupEvents"],
                [
                    "clear-projector",
                    "revoke-projector",
                    "clear-projector",
                    "revoke-projector",
                ],
            )


if __name__ == "__main__":
    unittest.main()
