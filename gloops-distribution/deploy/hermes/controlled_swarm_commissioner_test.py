from __future__ import annotations

import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("controlled-swarm-commissioner.py")
SPEC = importlib.util.spec_from_file_location("controlled_swarm_commissioner", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def exact_roster() -> list[dict[str, object]]:
    agents: list[dict[str, object]] = []
    for name, agent_id in MODULE.ADMITTED.items():
        agents.append(
            {
                "name": name,
                "id": agent_id,
                "status": "paused",
                "adapterType": "hermes_gateway",
                "adapterConfig": {
                    "instructions": MODULE.compact_instructions(name),
                },
                "runtimeConfig": {
                    "heartbeat": {
                        "enabled": False,
                        "intervalSec": 3600,
                        "wakeOnDemand": True,
                        "maxConcurrentRuns": 1,
                    },
                },
            },
        )
    for name, (agent_id, status, adapter_type) in MODULE.EXCLUDED.items():
        agents.append(
            {
                "name": name,
                "id": agent_id,
                "status": status,
                "adapterType": adapter_type,
                "adapterConfig": {},
                "runtimeConfig": {},
            },
        )
    return agents


def legacy_roster() -> list[dict[str, object]]:
    agents = exact_roster()
    for agent in agents:
        if agent["name"] in MODULE.ADMITTED:
            agent["adapterConfig"]["instructions"] = (
                "legacy autonomous-agent context\n" * 400
                + f"{MODULE.PROTOCOL_START}\n"
                + f"campaign {MODULE.CAMPAIGN_ID}\n"
                + f"{MODULE.PROTOCOL_END}"
            )
    return agents


class FakePlatform:
    def __init__(
        self,
        rosters: list[list[dict[str, object]]] | None = None,
        *,
        fail_first_restart: bool = False,
        fail_enable_barrier: bool = False,
        create_epoch_after_restart: Path | None = None,
    ) -> None:
        self.rosters = rosters or [
            legacy_roster(),
            exact_roster(),
            exact_roster(),
        ]
        self.fail_first_restart = fail_first_restart
        self.fail_enable_barrier = fail_enable_barrier
        self.create_epoch_after_restart = create_epoch_after_restart
        self.restart_count = 0
        self.barrier = False
        self.calls: list[str] = []
        self.instruction_updates: list[tuple[str, str]] = []

    def is_active(self, unit: str) -> bool:
        self.calls.append(f"is_active:{unit}")
        return True

    def restart_paperclip(self) -> None:
        self.calls.append("restart")
        self.restart_count += 1
        if self.restart_count == 1 and self.fail_first_restart:
            raise RuntimeError("stubbed restart failure")
        if self.restart_count == 1 and self.create_epoch_after_restart is not None:
            self.create_epoch_after_restart.parent.mkdir(parents=True, exist_ok=True)
            self.create_epoch_after_restart.write_text("{}\n", encoding="utf-8")

    def health(self) -> None:
        self.calls.append("health")

    def fetch_agents(self, token: str) -> object:
        self.calls.append("fetch_agents")
        return self.rosters.pop(0)

    def set_agent_instructions(
        self,
        token: str,
        agent_id: str,
        instructions: str,
    ) -> None:
        self.calls.append(f"set_instructions:{agent_id}")
        self.instruction_updates.append((agent_id, instructions))
        for roster in self.rosters:
            for agent in roster:
                if agent["id"] == agent_id:
                    agent["adapterConfig"]["instructions"] = instructions

    def inspect_commissioned(self) -> bool:
        self.calls.append("inspect")
        return self.barrier

    def set_barrier(self, commissioned: bool) -> None:
        self.calls.append(f"set_barrier:{str(commissioned).lower()}")
        self.barrier = commissioned
        if commissioned and self.fail_enable_barrier:
            raise RuntimeError("stubbed barrier failure after mutation")


class CommissionerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.paths = MODULE.CommissioningPaths(
            config_dir=root / "etc",
            state_dir=root / "state",
            epoch=root / "epoch.json",
            lock=root / "commission.lock",
            helper=root / "helper",
        )
        self.paths.config_dir.mkdir()
        self.paths.runtime_env.write_text(
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
            encoding="utf-8",
        )
        self.paths.image.write_text("ghcr.io/gloopsai/paperclip-gloops@sha256:test\n")
        self.paths.token.write_text("board-token\n")
        self.paths.token.chmod(0o600)
        self.write_approval()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write_approval(self, **overrides: object) -> None:
        now = dt.datetime.now(dt.timezone.utc)
        approval: dict[str, object] = {
            "schemaVersion": "gloops.controlled-swarm-commissioning-approval.v1",
            "authorization": MODULE.AUTHORIZATION,
            "campaignId": MODULE.CAMPAIGN_ID,
            "approvedImage": "ghcr.io/gloopsai/paperclip-gloops@sha256:test",
            "governanceMerge": MODULE.GOVERNANCE_MERGE,
            "authorizedAt": (now - dt.timedelta(minutes=1)).isoformat(),
            "expiresAt": (now + dt.timedelta(hours=1)).isoformat(),
        }
        approval.update(overrides)
        self.paths.approval.write_text(json.dumps(approval), encoding="utf-8")
        self.paths.approval.chmod(0o600)

    def commissioner(self, platform: FakePlatform) -> object:
        return MODULE.Commissioner(
            self.paths,
            platform,
            enforce_root_ownership=False,
        )

    def test_happy_path_revalidates_and_never_invokes_a_provider(self) -> None:
        platform = FakePlatform()
        self.commissioner(platform).run()
        self.assertTrue(platform.barrier)
        self.assertEqual(platform.restart_count, 1)
        self.assertEqual(platform.calls.count("fetch_agents"), 3)
        self.assertEqual(
            sum(call.startswith("set_instructions:") for call in platform.calls),
            len(MODULE.ADMITTED),
        )
        self.assertTrue(self.paths.receipt.exists())
        receipt = json.loads(self.paths.receipt.read_text(encoding="utf-8"))
        self.assertEqual(
            receipt["instructionSet"]["schemaVersion"],
            MODULE.INSTRUCTION_VERSION,
        )
        self.assertGreater(
            receipt["instructionSet"]["beforeBytes"],
            receipt["instructionSet"]["afterBytes"],
        )
        self.assertGreater(
            receipt["instructionSet"]["reductionBasisPoints"],
            5000,
        )
        self.assertFalse(self.paths.approval.exists())
        self.assertFalse(
            any("provider" in call.lower() for call in platform.calls),
        )

    def test_compact_charters_are_role_specific_bounded_and_content_addressed(self) -> None:
        values = {
            name: MODULE.compact_instructions(name)
            for name in MODULE.ADMITTED
        }
        self.assertEqual(len(values), len(set(values.values())))
        for name, value in values.items():
            with self.subTest(name=name):
                self.assertLess(len(value.encode("utf-8")), 4_000)
                self.assertEqual(value.count(MODULE.PROTOCOL_START), 1)
                self.assertEqual(value.count(MODULE.PROTOCOL_END), 1)
                self.assertIn(MODULE.CAMPAIGN_ID, value)
                self.assertIn(f"Identity: {name}", value)
                self.assertRegex(
                    MODULE.instruction_digest(value),
                    r"^sha256:[0-9a-f]{64}$",
                )

    def test_existing_compact_instructions_are_revalidated_without_rewrite(self) -> None:
        platform = FakePlatform([
            exact_roster(),
            exact_roster(),
            exact_roster(),
        ])
        self.commissioner(platform).run()
        self.assertEqual(platform.instruction_updates, [])
        self.assertTrue(platform.barrier)
        receipt = json.loads(self.paths.receipt.read_text(encoding="utf-8"))
        self.assertFalse(receipt["instructionSet"]["changed"])
        self.assertEqual(receipt["instructionSet"]["reductionBasisPoints"], 0)

    def test_stale_or_malformed_approval_fails_before_restart(self) -> None:
        stale = dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=5)
        for overrides in (
            {"expiresAt": stale.isoformat()},
            {"authorization": "wrong"},
            {"unexpected": True},
        ):
            with self.subTest(overrides=overrides):
                self.write_approval(**overrides)
                platform = FakePlatform()
                with self.assertRaises(MODULE.CommissioningError):
                    self.commissioner(platform).run()
                self.assertEqual(platform.restart_count, 0)
                self.assertFalse(platform.barrier)
                self.assertFalse(self.paths.receipt.exists())

    def test_extra_or_runnable_identity_fails_closed(self) -> None:
        for roster in (
            exact_roster()
            + [
                {
                    "name": "Unexpected",
                    "id": "unexpected",
                    "status": "idle",
                    "adapterType": "hermes_gateway",
                },
            ],
            [
                {
                    **agent,
                    **({"status": "idle"} if agent["name"] == "Mason" else {}),
                }
                for agent in exact_roster()
            ],
        ):
            with self.subTest(size=len(roster)):
                self.write_approval()
                platform = FakePlatform([roster])
                with self.assertRaises(MODULE.CommissioningError):
                    self.commissioner(platform).run()
                self.assertEqual(platform.restart_count, 0)
                self.assertFalse(platform.barrier)

    def test_post_restart_config_drift_rolls_back(self) -> None:
        drifted = copy.deepcopy(exact_roster())
        mason = next(agent for agent in drifted if agent["name"] == "Mason")
        mason["runtimeConfig"]["heartbeat"]["maxConcurrentRuns"] = 2
        platform = FakePlatform([legacy_roster(), exact_roster(), drifted])
        with self.assertRaises(MODULE.CommissioningError):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 2)
        self.assertFalse(self.paths.receipt.exists())

    def test_restart_failure_rolls_back_false_and_removes_receipt(self) -> None:
        platform = FakePlatform(fail_first_restart=True)
        with self.assertRaisesRegex(RuntimeError, "restart failure"):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 2)
        self.assertEqual(
            len(platform.instruction_updates),
            len(MODULE.ADMITTED) * 2,
        )
        restored = platform.instruction_updates[len(MODULE.ADMITTED):]
        self.assertTrue(
            all("legacy autonomous-agent context" in value for _, value in restored),
        )
        self.assertFalse(self.paths.receipt.exists())

    def test_partial_barrier_failure_restores_barrier_and_instructions(self) -> None:
        platform = FakePlatform(fail_enable_barrier=True)
        with self.assertRaisesRegex(RuntimeError, "barrier failure"):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 1)
        self.assertEqual(
            len(platform.instruction_updates),
            len(MODULE.ADMITTED) * 2,
        )
        self.assertFalse(self.paths.receipt.exists())

    def test_existing_epoch_refuses_without_restart(self) -> None:
        self.paths.epoch.write_text("{}\n", encoding="utf-8")
        platform = FakePlatform()
        with self.assertRaisesRegex(MODULE.CommissioningError, "existing campaign epoch"):
            self.commissioner(platform).run()
        self.assertEqual(platform.restart_count, 0)
        self.assertFalse(platform.barrier)

    def test_new_epoch_during_restart_rolls_back(self) -> None:
        platform = FakePlatform(create_epoch_after_restart=self.paths.epoch)
        with self.assertRaisesRegex(MODULE.CommissioningError, "unexpectedly armed"):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 2)
        self.assertFalse(self.paths.receipt.exists())


if __name__ == "__main__":
    unittest.main()
