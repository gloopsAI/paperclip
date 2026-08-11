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
            for directory in (config, state, controlled, bin_dir):
                directory.mkdir(parents=True)
            for marker in (
                "ACTIVATION_APPROVED",
                "HERMES_EXECUTION_APPROVED",
                "HERMES_HANDSHAKE_APPROVED",
                "CONTROLLED_SWARM_COMMISSIONING_APPROVED",
            ):
                (config / marker).write_text("approved\n", encoding="utf-8")
            commissioning = controlled / "commissioning.json"
            commissioning.write_text("{}\n", encoding="utf-8")

            systemctl = bin_dir / "systemctl"
            systemctl.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {log}\n"
                "[ \"$1\" = is-active ] && exit 3\n"
                "exit 0\n",
                encoding="utf-8",
            )
            docker = bin_dir / "docker"
            docker.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            set_commissioning = bin_dir / "set-commissioning"
            set_commissioning.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            for command in (systemctl, docker, set_commissioning):
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
            }
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
            self.assertFalse(commissioning.exists())
            commands = log.read_text(encoding="utf-8")
            for general in (
                "paperclip-gloops.service",
                "paperclip-hermes-execution.service",
                "paperclip-github-push-broker.service",
                "paperclip-github-read-broker.service",
                "paperclip-platform-ops-broker.service",
            ):
                self.assertNotIn(general, commands)
            for campaign_only in (
                "paperclip-gloops-handshake.service",
                "paperclip-hermes-handshake.service",
                "paperclip-hermes-handshake-egress.service",
                "paperclip-controlled-swarm-commissioning-recovery.service",
            ):
                self.assertIn(campaign_only, commands)
            receipt = json.loads((state / "last-stop.json").read_text(encoding="utf-8"))
            self.assertEqual(receipt["reason"], "campaign_epoch_expired")
            self.assertEqual(receipt["outcome"], "dark")


if __name__ == "__main__":
    unittest.main()
