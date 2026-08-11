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
    def test_deadman_expiry_preserves_general_services_and_markers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="paperclip-campaign-lifecycle-", dir="/tmp") as raw:
            root = pathlib.Path(raw)
            config = root / "config"
            state = root / "state"
            controlled = root / "controlled"
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
            service_state.write_text(
                json.dumps({
                    "active": [],
                    "masked": sorted(units),
                    "portOwner": None,
                    "generalStartFailuresRemaining": 2,
                }),
                encoding="utf-8",
            )

            systemctl = bin_dir / "systemctl"
            systemctl.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                f"state_path = pathlib.Path({str(service_state)!r})\n"
                f"log_path = pathlib.Path({str(log)!r})\n"
                "args = sys.argv[1:]\n"
                "with log_path.open('a', encoding='utf-8') as fh: fh.write(' '.join(args) + '\\n')\n"
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
                "        elif unit == 'paperclip-gloops.service':\n"
                "            if 'paperclip-controlled-swarm.service' in active: sys.exit(1)\n"
                "            if state.get('generalStartFailuresRemaining', 0) > 0:\n"
                "                state['generalStartFailuresRemaining'] -= 1\n"
                "                state['active'], state['masked'] = sorted(active), sorted(masked)\n"
                "                state_path.write_text(json.dumps(state), encoding='utf-8')\n"
                "                sys.exit(1)\n"
                "            state['portOwner'] = unit\n"
                "        active.add(unit)\n"
                "elif command == 'stop':\n"
                "    active.difference_update(targets)\n"
                "    if state.get('portOwner') in targets: state['portOwner'] = None\n"
                "elif command == 'is-active':\n"
                "    raise SystemExit(0 if targets[-1] in active else 3)\n"
                "state['active'], state['masked'] = sorted(active), sorted(masked)\n"
                "state_path.write_text(json.dumps(state), encoding='utf-8')\n",
                encoding="utf-8",
            )
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            set_commissioning = bin_dir / "set-commissioning"
            set_commissioning.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            verify_deadman = bin_dir / "verify-deadman"
            verify_deadman.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            verify_profile = bin_dir / "verify-profile"
            verify_profile.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            curl = bin_dir / "curl"
            curl.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            for command in (
                systemctl,
                docker,
                set_commissioning,
                verify_deadman,
                verify_profile,
                curl,
            ):
                command.chmod(0o755)
            env = {
                **os.environ,
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
                [str(HERE / "campaign-deadman-stop.sh"), "campaign_epoch_expired"],
                env=env,
                check=False,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

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
            self.assertEqual(receipt["reason"], "campaign_epoch_expired")
            self.assertEqual(receipt["outcome"], "product_restored")


if __name__ == "__main__":
    unittest.main()
