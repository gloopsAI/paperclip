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
    for index, (name, agent_id) in enumerate(MODULE.ADMITTED.items(), start=1):
        agents.append(
            {
                "name": name,
                "id": agent_id,
                "status": "paused",
                "adapterType": "hermes_gateway",
                "adapterConfig": {
                    **MODULE.EXECUTION_ROUTE,
                    "apiKey": {
                        "type": "secret_ref",
                        "secretId": (
                            f"00000000-0000-4000-8000-{index:012d}"
                        ),
                        "version": "latest",
                    },
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
            agent["adapterConfig"] = {
                "apiBaseUrl": "http://127.0.0.1:8642",
                "apiKey": copy.deepcopy(agent["adapterConfig"]["apiKey"]),
                "payloadTemplate": {
                    "input": "legacy payload override",
                },
                "provider": "unused-legacy-provider",
                "timeoutSec": 600,
                "instructions": (
                    "legacy autonomous-agent context\n" * 400
                    + f"{MODULE.PROTOCOL_START}\n"
                    + f"campaign {MODULE.CAMPAIGN_ID}\n"
                    + f"{MODULE.PROTOCOL_END}"
                ),
            }
    return agents


class FakePlatform:
    def __init__(
        self,
        rosters: list[list[dict[str, object]]] | None = None,
        *,
        fail_first_restart: bool = False,
        fail_enable_barrier: bool = False,
        fail_restore: bool = False,
        create_epoch_after_restart: Path | None = None,
    ) -> None:
        self.rosters = rosters or [
            legacy_roster(),
            exact_roster(),
            exact_roster(),
        ]
        self.fail_first_restart = fail_first_restart
        self.fail_enable_barrier = fail_enable_barrier
        self.fail_restore = fail_restore
        self.create_epoch_after_restart = create_epoch_after_restart
        self.restart_count = 0
        self.barrier = False
        self.calls: list[str] = []
        self.config_updates: list[tuple[str, dict[str, object], bool]] = []
        self.expected_journal: Path | None = None

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

    def set_agent_adapter_config(
        self,
        token: str,
        agent_id: str,
        adapter_config: dict[str, object],
        *,
        replace: bool,
    ) -> None:
        if (
            self.fail_restore
            and "legacy autonomous-agent context"
            in str(adapter_config.get("instructions", ""))
        ):
            raise RuntimeError("stubbed rollback failure")
        if (
            adapter_config.get("instructions", "").startswith(
                "# GLoops controlled-swarm role",
            )
            and self.expected_journal is not None
        ):
            if not self.expected_journal.exists():
                raise AssertionError("adapter mutation occurred before durable journal")
        self.calls.append(f"set_adapter_config:{agent_id}:{str(replace).lower()}")
        self.config_updates.append(
            (agent_id, copy.deepcopy(adapter_config), replace),
        )
        for roster in self.rosters:
            for agent in roster:
                if agent["id"] == agent_id:
                    if replace:
                        agent["adapterConfig"] = copy.deepcopy(adapter_config)
                    else:
                        agent["adapterConfig"].update(
                            copy.deepcopy(adapter_config),
                        )

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
            sidecar_config=root / "hermes-execution-config.yaml",
            sidecar_policy=root / "hermes-execution-policy.json",
        )
        self.paths.config_dir.mkdir()
        self.paths.runtime_env.write_text(
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
            encoding="utf-8",
        )
        self.paths.image.write_text("ghcr.io/gloopsai/paperclip-gloops@sha256:test\n")
        self.paths.token.write_text("board-token\n")
        self.paths.token.chmod(0o600)
        self.paths.sidecar_config.write_bytes(
            SCRIPT.with_name("hermes-execution-config.yaml").read_bytes(),
        )
        self.paths.sidecar_config.chmod(0o600)
        self.paths.sidecar_policy.write_bytes(
            SCRIPT.with_name("hermes-execution-policy.json").read_bytes(),
        )
        self.paths.sidecar_policy.chmod(0o600)
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
        platform.expected_journal = self.paths.rollback_journal
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
            sum(call.startswith("set_adapter_config:") for call in platform.calls),
            len(MODULE.ADMITTED),
        )
        self.assertTrue(self.paths.receipt.exists())
        self.assertFalse(self.paths.rollback_journal.exists())
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
        self.assertEqual(receipt["executionRoute"], MODULE.EXECUTION_ROUTE)
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

    def test_compact_roster_rejects_provider_or_gateway_drift(self) -> None:
        for key, value in (
            ("provider", "grok"),
            ("apiBaseUrl", "http://127.0.0.1:8642"),
            ("model", "unexpected"),
        ):
            with self.subTest(key=key):
                roster = exact_roster()
                mason = next(
                    agent for agent in roster
                    if agent["name"] == "Mason"
                )
                mason["adapterConfig"][key] = value
                with self.assertRaisesRegex(
                    MODULE.CommissioningError,
                    "exact paused charter",
                ):
                    MODULE.validate_roster(
                        roster,
                        require_compact_instructions=True,
                    )

    def test_gateway_secret_binding_is_required_and_payload_overrides_are_removed(
        self,
    ) -> None:
        roster = legacy_roster()
        mason = next(agent for agent in roster if agent["name"] == "Mason")
        del mason["adapterConfig"]["apiKey"]
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "exact paused charter",
        ):
            MODULE.validate_roster(
                roster,
                require_compact_instructions=False,
            )

        platform = FakePlatform()
        self.commissioner(platform).run()
        applied = platform.config_updates[:len(MODULE.ADMITTED)]
        self.assertTrue(all(replace for _, _, replace in applied))
        for _, config, _ in applied:
            self.assertEqual(
                set(config),
                set(MODULE.EXECUTION_ROUTE) | {"apiKey", "instructions"},
            )
            self.assertNotIn("payloadTemplate", config)
            self.assertNotIn("provider", config)
            self.assertNotIn("model", config)

    def test_existing_compact_instructions_are_revalidated_without_rewrite(self) -> None:
        platform = FakePlatform([
            exact_roster(),
            exact_roster(),
            exact_roster(),
        ])
        self.commissioner(platform).run()
        self.assertEqual(platform.config_updates, [])
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
        platform = FakePlatform([
            legacy_roster(),
            exact_roster(),
            drifted,
            exact_roster(),
        ])
        with self.assertRaises(MODULE.CommissioningError):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 2)
        self.assertFalse(self.paths.receipt.exists())

    def test_receipt_and_live_verification_reject_route_or_instruction_drift(
        self,
    ) -> None:
        platform = FakePlatform()
        self.commissioner(platform).run()
        MODULE.verify_commissioned_state(
            self.paths,
            FakePlatform([exact_roster()]),
            live=True,
            enforce_root_ownership=False,
        )

        original = json.loads(self.paths.receipt.read_text(encoding="utf-8"))
        for mutation in ("route", "instructions", "malformed-agent-list"):
            with self.subTest(mutation=mutation):
                receipt = copy.deepcopy(original)
                if mutation == "route":
                    receipt["executionRoute"]["provider"] = "grok"
                elif mutation == "instructions":
                    receipt["instructionSet"]["agents"]["Mason"]["sha256"] = (
                        "sha256:" + "0" * 64
                    )
                else:
                    receipt["admittedAgentIds"] = None
                self.paths.receipt.write_text(
                    json.dumps(receipt),
                    encoding="utf-8",
                )
                with self.assertRaises(MODULE.CommissioningError):
                    MODULE.verify_commissioned_state(
                        self.paths,
                        FakePlatform([exact_roster()]),
                        live=False,
                        enforce_root_ownership=False,
                    )
        self.paths.receipt.write_text(json.dumps(original), encoding="utf-8")

        drifted = exact_roster()
        mason = next(agent for agent in drifted if agent["name"] == "Mason")
        mason["adapterConfig"]["instructions"] += "\ndrift"
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "exact paused charter",
        ):
            MODULE.verify_commissioned_state(
                self.paths,
                FakePlatform([drifted]),
                live=True,
                enforce_root_ownership=False,
            )

        self.paths.sidecar_config.write_text(
            "model:\n  provider: grok\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "Ollama-only route evidence",
        ):
            MODULE.verify_commissioned_state(
                self.paths,
                FakePlatform([exact_roster()]),
                live=False,
                enforce_root_ownership=False,
            )

    def test_interrupted_journal_recovers_exact_configs_and_consumes_approval(self) -> None:
        prior_roster = legacy_roster()
        prior_configs = {
            agent["name"]: copy.deepcopy(agent["adapterConfig"])
            for agent in prior_roster
            if agent["name"] in MODULE.ADMITTED
        }
        platform = FakePlatform([copy.deepcopy(prior_roster)])
        commissioner = self.commissioner(platform)
        commissioner._write_rollback_journal(
            self.paths.approval,
            prior_configs,
        )
        stale = self.paths.config_dir / (
            ".CONTROLLED_SWARM_COMMISSIONING_APPROVED.123"
        )
        stale.write_text("{}\n", encoding="utf-8")
        stale.chmod(0o600)
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "recovered interrupted commissioning",
        ):
            commissioner.run()
        self.assertFalse(self.paths.rollback_journal.exists())
        self.assertFalse(self.paths.approval.exists())
        self.assertFalse(stale.exists())
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 1)
        self.assertEqual(len(platform.config_updates), len(MODULE.ADMITTED))
        self.assertTrue(all(replace for _, _, replace in platform.config_updates))

    def test_journal_phase_is_versioned_durable_and_monotonic(self) -> None:
        prior_roster = legacy_roster()
        prior_configs = {
            agent["name"]: copy.deepcopy(agent["adapterConfig"])
            for agent in prior_roster
            if agent["name"] in MODULE.ADMITTED
        }
        commissioner = self.commissioner(FakePlatform())
        commissioner._write_rollback_journal(
            self.paths.approval,
            prior_configs,
        )
        journal = json.loads(
            self.paths.rollback_journal.read_text(encoding="utf-8"),
        )
        self.assertEqual(journal["schemaVersion"], MODULE.ROLLBACK_JOURNAL_VERSION)
        self.assertEqual(journal["phase"], "journal_recorded")
        self.assertIn("updatedAt", journal)

        commissioner._advance_rollback_journal("configs_applied")
        advanced = json.loads(
            self.paths.rollback_journal.read_text(encoding="utf-8"),
        )
        self.assertEqual(advanced["phase"], "configs_applied")
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "cannot move",
        ):
            commissioner._advance_rollback_journal("journal_recorded")

    def test_recovery_is_idempotent_after_first_exact_restore(self) -> None:
        prior_roster = legacy_roster()
        prior_configs = {
            agent["name"]: copy.deepcopy(agent["adapterConfig"])
            for agent in prior_roster
            if agent["name"] in MODULE.ADMITTED
        }
        platform = FakePlatform([copy.deepcopy(prior_roster)])
        commissioner = self.commissioner(platform)
        commissioner._write_rollback_journal(
            self.paths.approval,
            prior_configs,
        )

        self.assertTrue(commissioner.recover())
        calls_after_first = list(platform.calls)
        self.assertFalse(commissioner.recover())
        self.assertEqual(platform.calls, calls_after_first)
        self.assertFalse(self.paths.rollback_journal.exists())
        self.assertFalse(platform.barrier)

    def test_corrupt_journal_refuses_recovery_without_mutation(self) -> None:
        self.paths.state_dir.mkdir(mode=0o700)
        self.paths.rollback_journal.write_text("{not-json\n", encoding="utf-8")
        self.paths.rollback_journal.chmod(0o600)
        platform = FakePlatform()
        with self.assertRaisesRegex(
            MODULE.CommissioningError,
            "unreadable or corrupt",
        ):
            self.commissioner(platform).recover()
        self.assertTrue(self.paths.rollback_journal.exists())
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.config_updates, [])

    def test_rollback_failure_remains_false_and_preserves_journal(self) -> None:
        prior_roster = legacy_roster()
        prior_configs = {
            agent["name"]: copy.deepcopy(agent["adapterConfig"])
            for agent in prior_roster
            if agent["name"] in MODULE.ADMITTED
        }
        platform = FakePlatform(
            [copy.deepcopy(prior_roster)],
            fail_restore=True,
        )
        commissioner = self.commissioner(platform)
        commissioner._write_rollback_journal(
            self.paths.approval,
            prior_configs,
        )

        with self.assertRaisesRegex(RuntimeError, "rollback failure"):
            commissioner.recover()
        self.assertFalse(platform.barrier)
        self.assertTrue(self.paths.rollback_journal.exists())

    def test_recovery_unit_is_root_only_bounded_and_false_barrier_conditioned(
        self,
    ) -> None:
        unit = SCRIPT.with_name(
            "paperclip-controlled-swarm-commissioning-recovery.service",
        ).read_text(encoding="utf-8")
        wrapper = SCRIPT.with_name("commission-controlled-swarm.sh").read_text(
            encoding="utf-8",
        )
        self.assertIn("User=root", unit)
        self.assertIn("Group=root", unit)
        self.assertIn(
            "ConditionPathExists=/var/lib/paperclip-gloops/controlled-swarm/"
            "commissioning-rollback.json",
            unit,
        )
        self.assertIn(
            "ExecCondition=/usr/bin/grep -Fxq "
            "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
            unit,
        )
        self.assertIn("--recover-interrupted", unit)
        self.assertIn("set-controlled-swarm-commissioning.py\" false", wrapper)
        self.assertIn("systemctl start --wait", wrapper)

    def test_restart_failure_rolls_back_false_and_removes_receipt(self) -> None:
        platform = FakePlatform(fail_first_restart=True)
        with self.assertRaisesRegex(RuntimeError, "restart failure"):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 2)
        self.assertEqual(
            len(platform.config_updates),
            len(MODULE.ADMITTED) * 2,
        )
        restored = platform.config_updates[len(MODULE.ADMITTED):]
        self.assertTrue(
            all(
                replace
                and "legacy autonomous-agent context"
                in str(config.get("instructions"))
                for _, config, replace in restored
            ),
        )
        self.assertFalse(self.paths.receipt.exists())

    def test_partial_barrier_failure_restores_barrier_and_instructions(self) -> None:
        platform = FakePlatform(fail_enable_barrier=True)
        with self.assertRaisesRegex(RuntimeError, "barrier failure"):
            self.commissioner(platform).run()
        self.assertFalse(platform.barrier)
        self.assertEqual(platform.restart_count, 1)
        self.assertEqual(
            len(platform.config_updates),
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
