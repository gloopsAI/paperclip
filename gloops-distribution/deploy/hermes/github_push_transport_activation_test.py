#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("github-push-transport-activation.py")
SPEC = importlib.util.spec_from_file_location("github_push_transport_activation", MODULE_PATH)
assert SPEC and SPEC.loader
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


class FakeOperations:
    def __init__(self, fail: str | None = None):
        self.fail = fail
        self.events: list[str] = []
        self.active = True
        self.on_start = None

    def _event(self, name: str) -> None:
        self.events.append(name)
        if self.fail == name:
            self.fail = None
            raise activation.ActivationError(f"injected {name}")

    def service_state(self):
        return {
            "ActiveState": "active" if self.active else "inactive",
            "SubState": "running" if self.active else "dead",
            "UnitFileState": "enabled",
            "HermesActiveState": "active" if self.active else "inactive",
            "HermesSubState": "running" if self.active else "dead",
            "HermesUnitFileState": "disabled",
        }

    def quiescent(self, _broker):
        self._event("quiescent")

    def stop(self, _prior):
        self._event("stop")
        self.active = False

    def start(self, _prior):
        self._event("start")
        self.active = True
        if self.on_start is not None:
            self.on_start()

    def healthy(self, _broker, _prior):
        self._event("health")
        if not self.active:
            raise activation.ActivationError("inactive")


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.fchown = patch.object(activation.os, "fchown", return_value=None)
        self.chown = patch.object(activation.os, "chown", return_value=None)
        self.fchown.start()
        self.chown.start()

    def tearDown(self):
        self.chown.stop()
        self.fchown.stop()

    def fixture(self, root: Path):
        source = root / "source"
        install = root / "install"
        workspace_root = root / "workspace"
        tx_root = root / "transactions"
        source.mkdir(); install.mkdir(); workspace_root.mkdir(); tx_root.mkdir()
        os.chmod(workspace_root, 0o2770)
        artifacts = {}
        expected = {}
        old = {}
        for index, name in enumerate(activation.ARTIFACTS):
            target = install / name
            source_path = source / name
            old_value = f"old-{index}\n".encode()
            new_value = f"new-{index}\n".encode()
            target.write_bytes(old_value); os.chmod(target, 0o540)
            source_path.write_bytes(new_value)
            artifacts[name] = target
            expected[name] = activation.sha256_bytes(new_value)
            old[name] = (old_value, target.stat().st_mode, target.stat().st_uid, target.stat().st_gid)
        args = type("Args", (), {
            "source_dir": str(source), "transaction_dir": str(tx_root / "tx-1"),
            "transaction_root": str(tx_root), "expected": expected, "test_mode": True,
            "reviewed_head": "a" * 40,
            "workspace_root": str(workspace_root),
            "workspace_root_policy": {"uid": os.getuid(), "gid": os.getgid(), "mode": 0o3770},
        })()
        return args, artifacts, old

    def test_production_operations_stop_dependent_before_broker_and_start_broker_first(self):
        commands: list[tuple[str, ...]] = []
        ops = activation.Operations()
        with patch.object(ops, "command", side_effect=lambda *argv: commands.append(argv) or ""):
            prior = {
                "ActiveState": "active", "SubState": "running", "UnitFileState": "disabled",
                "HermesActiveState": "active", "HermesSubState": "running",
                "HermesUnitFileState": "disabled",
            }
            ops.stop(prior)
            ops.start(prior)
        self.assertEqual(commands, [
            ("systemctl", "stop", activation.HERMES_SERVICE),
            ("systemctl", "stop", activation.SERVICE),
            ("systemctl", "reset-failed", activation.SERVICE),
            ("systemctl", "start", activation.SERVICE),
            ("systemctl", "reset-failed", activation.HERMES_SERVICE),
            ("systemctl", "start", activation.HERMES_SERVICE),
        ])

    def test_existing_lineage_can_bind_the_prior_artifact_subset_during_contract_growth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tx_root = root / "transactions"; tx_root.mkdir()
            transaction = tx_root / "prior"; transaction.mkdir()
            workspace = root / "workspace"; workspace.mkdir(); os.chmod(workspace, 0o3770)
            first = root / "broker.py"; first.write_text("prior\n"); os.chmod(first, 0o555)
            added = root / "credentials.py"; added.write_text("current\n"); os.chmod(added, 0o755)
            artifacts = {"broker.py": first, "credentials.py": added}
            prior_artifacts = activation.installed_artifact_evidence({"broker.py": first})
            ops = FakeOperations()
            receipt = {
                "receiptDigest": "a" * 64,
                "reviewedHead": "b" * 40,
                "installedArtifacts": prior_artifacts,
                "workspaceRoot": activation.snapshot_workspace_root(workspace),
                "priorServiceState": ops.service_state(),
            }
            lineage = activation.write_active_lineage(tx_root, transaction, receipt)
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(
                activation, "WORKSPACE_ROOT", workspace,
            ):
                self.assertEqual(
                    activation.verify_current_activation(tx_root, transaction, receipt, ops),
                    lineage,
                )

    def test_activate_and_explicit_rollback_restore_exact_files(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                receipt = activation.activate(args, ops)
                self.assertEqual(receipt["disposition"], "activated")
                self.assertEqual(ops.events, ["stop", "quiescent", "start", "health"])
                self.assertTrue(all(path.read_bytes().startswith(b"new-") for path in artifacts.values()))
                for name, path in artifacts.items():
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), activation.ARTIFACT_MODES[name])
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o3770)
                rolled = activation.explicit_rollback(args, ops)
                self.assertEqual(rolled["disposition"], "rolled_back")
                stored_rollback = json.loads((Path(args.transaction_dir) / "rollback-receipt.json").read_text())
                stored_claim = json.loads((Path(args.transaction_dir) / "rollback-claim.json").read_text())
                self.assertEqual(rolled, stored_rollback)
                self.assertEqual(stored_rollback["receiptDigest"], activation.canonical_digest(stored_rollback))
                self.assertEqual(stored_rollback["claimDigest"], stored_claim["receiptDigest"])
                stored_manifest = json.loads((Path(args.transaction_dir) / "backup.json").read_text())
                self.assertEqual(stored_rollback["restoredArtifacts"], activation.restored_artifact_evidence(stored_manifest))
                self.assertEqual(stored_rollback["workspaceRoot"], activation.snapshot_workspace_root(Path(args.workspace_root)))
                self.assertFalse((Path(args.transaction_root) / activation.ACTIVE_LINEAGE_FILENAME).exists())
                for name, path in artifacts.items():
                    value, mode, uid, gid = old[name]
                    observed = path.stat()
                    self.assertEqual(path.read_bytes(), value)
                    self.assertEqual((observed.st_mode, observed.st_uid, observed.st_gid), (mode, uid, gid))
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o2770)

    def test_explicit_rollback_refuses_to_restore_over_candidate_durable_work(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(
                activation, "WORKSPACE_ROOT", Path(args.workspace_root),
            ):
                activation.activate(args, ops)
                ops.fail = "quiescent"
                with self.assertRaisesRegex(activation.ActivationError, "reconciliation required"):
                    activation.explicit_rollback(args, ops)
                self.assertTrue(all(path.read_bytes().startswith(b"new-") for path in artifacts.values()))
                state = activation.read_state(Path(args.transaction_dir))
                self.assertEqual(state["phase"], "reconciliation_required")
                failed = json.loads((Path(args.transaction_dir) / "rollback-receipt.json").read_text())
                self.assertFalse(failed["candidateQuiescent"])

    def test_automatic_rollback_refuses_incompatible_restore_when_candidate_is_not_quiescent(self):
        class CandidateWorkOperations(FakeOperations):
            def __init__(self):
                super().__init__()
                self.quiescent_calls = 0

            def quiescent(self, _broker):
                self.quiescent_calls += 1
                self._event("quiescent")
                if self.quiescent_calls == 2:
                    raise activation.ActivationError("candidate has in-flight work")

            def healthy(self, _broker, _prior):
                self._event("health")
                raise activation.ActivationError("candidate health failure")

        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = CandidateWorkOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(
                activation, "WORKSPACE_ROOT", Path(args.workspace_root),
            ), self.assertRaisesRegex(activation.ActivationError, "reconciliation required"):
                activation.activate(args, ops)
            self.assertTrue(all(path.read_bytes().startswith(b"new-") for path in artifacts.values()))
            failed = json.loads((Path(args.transaction_dir) / "rollback-receipt.json").read_text())
            self.assertTrue(failed["automatic"])
            self.assertFalse(failed["candidateQuiescent"])

    def test_explicit_rollback_receipts_an_exact_absent_prior_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            absent_name = "reconcile-governed-workspace.py"
            artifacts[absent_name].unlink()
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                self.assertTrue(artifacts[absent_name].is_file())
                receipt = activation.explicit_rollback(args, ops)
                self.assertFalse(artifacts[absent_name].exists())
                self.assertEqual(receipt["restoredArtifacts"][absent_name], {
                    "target": str(artifacts[absent_name]), "existed": False,
                })

    def test_health_failure_automatically_restores_all_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations("health")
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                with self.assertRaisesRegex(activation.ActivationError, "injected health"):
                    activation.activate(args, ops)
                for name, path in artifacts.items():
                    self.assertEqual(path.read_bytes(), old[name][0])
                receipt = json.loads((Path(args.transaction_dir) / "rollback-receipt.json").read_text())
                self.assertEqual(receipt["disposition"], "rolled_back")
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o2770)

    def test_post_start_workspace_drift_causes_activation_compensation(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations()
            starts = 0
            def mutate_first_start():
                nonlocal starts
                starts += 1
                if starts == 1:
                    os.chmod(args.workspace_root, 0o2770)
            ops.on_start = mutate_first_start
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                with self.assertRaisesRegex(activation.ActivationError, "terminal evidence has drifted"):
                    activation.activate(args, ops)
                self.assertEqual(activation.read_state(Path(args.transaction_dir))["phase"], "rolled_back")
                for name, path in artifacts.items():
                    self.assertEqual(path.read_bytes(), old[name][0])
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o2770)

    def test_post_start_workspace_drift_makes_explicit_rollback_reconciliation_required(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                ops.on_start = lambda: os.chmod(args.workspace_root, 0o1770)
                with self.assertRaisesRegex(activation.ActivationError, "reconciliation required"):
                    activation.explicit_rollback(args, ops)
                state = activation.read_state(Path(args.transaction_dir))
                receipt = json.loads((Path(args.transaction_dir) / "rollback-receipt.json").read_text())
                self.assertEqual(state["phase"], "reconciliation_required")
                self.assertEqual(receipt["disposition"], "rollback_failed")
                self.assertIsNone(receipt["restoredArtifacts"])
                self.assertIsNone(receipt["workspaceRoot"])

                # An operator may repair only the already-proven prior state;
                # reconciliation then clears the stale lineage and terminalizes.
                manifest = json.loads((Path(args.transaction_dir) / "backup.json").read_text())
                activation.set_workspace_root_metadata(
                    activation.snapshot_workspace_root(Path(args.workspace_root)),
                    {
                        "uid": manifest["workspaceRoot"]["uid"],
                        "gid": manifest["workspaceRoot"]["gid"],
                        "mode": manifest["workspaceRoot"]["mode"],
                    },
                )
                ops.on_start = None
                reconciled = activation.reconcile_rollback(args, ops)
                self.assertEqual(reconciled["disposition"], "reconciled_rolled_back")
                self.assertEqual(activation.read_state(Path(args.transaction_dir))["phase"], "rolled_back")
                self.assertFalse((Path(args.transaction_root) / activation.ACTIVE_LINEAGE_FILENAME).exists())

    def test_receipt_failure_automatically_restores_before_success(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations()
            real = activation.write_receipt
            calls = 0
            def fail_activation_receipt(*values, **kwargs):
                nonlocal calls
                calls += 1
                if calls == 1:
                    raise OSError("injected receipt")
                return real(*values, **kwargs)
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)), patch.object(activation, "write_receipt", side_effect=fail_activation_receipt):
                with self.assertRaisesRegex(OSError, "injected receipt"):
                    activation.activate(args, ops)
                for name, path in artifacts.items():
                    self.assertEqual(path.read_bytes(), old[name][0])
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o2770)

    def test_invalid_source_hash_fails_before_transaction_or_service_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            args.expected[next(iter(args.expected))] = "0" * 64
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                with self.assertRaisesRegex(activation.ActivationError, "reviewed sha256 mismatch"):
                    activation.activate(args, ops)
                self.assertFalse(Path(args.transaction_dir).exists())
                self.assertEqual(ops.events, [])

    def test_explicit_rollback_replay_has_zero_service_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                activation.explicit_rollback(args, ops)
                events = list(ops.events)
                with self.assertRaisesRegex(activation.ActivationError, "already claimed"):
                    activation.explicit_rollback(args, ops)
                self.assertEqual(events, ops.events)

    def test_next_activation_recovers_crash_left_mutation_before_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations()
            tx_root = Path(args.transaction_root)
            abandoned = tx_root / "tx-abandoned"
            abandoned.mkdir(mode=0o700)
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                manifest = activation.snapshot_installed(abandoned, artifacts, Path(args.workspace_root))
                prior = ops.service_state()
                activation.write_state(abandoned, "mutation_started", {
                    "backupDigest": manifest["receiptDigest"],
                    "priorServiceState": prior,
                    "reviewedHead": "b" * 40,
                    "recoveredTransactions": [],
                })
                first = next(iter(artifacts.values()))
                activation.durable_write(first, b"crash-left-partial-candidate\n", 0o555)
                activation.set_workspace_root_metadata(
                    manifest["workspaceRoot"], args.workspace_root_policy,
                )
                ops.active = False

                args.transaction_dir = str(tx_root / "tx-after-recovery")
                receipt = activation.activate(args, ops)
                self.assertEqual(receipt["recoveredTransactions"], [str(abandoned.resolve())])
                recovered_state = activation.read_state(abandoned)
                self.assertEqual(recovered_state["phase"], "rolled_back")
                self.assertTrue((abandoned / "rollback-receipt.json").is_file())

                activation.explicit_rollback(args, ops)
                for name, path in artifacts.items():
                    self.assertEqual(path.read_bytes(), old[name][0])
                self.assertEqual(stat.S_IMODE(Path(args.workspace_root).stat().st_mode), 0o2770)

    def test_reconciliation_required_transaction_blocks_new_activation(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            blocked = Path(args.transaction_root) / "tx-blocked"
            blocked.mkdir(mode=0o700)
            activation.write_state(blocked, "reconciliation_required", {
                "backupDigest": "unproved", "priorServiceState": ops.service_state(),
                "rollbackReceiptDigest": "unproved",
            })
            args.transaction_dir = str(Path(args.transaction_root) / "tx-refused")
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                with self.assertRaisesRegex(activation.ActivationError, "unresolved activation transaction"):
                    activation.activate(args, ops)
            self.assertFalse(Path(args.transaction_dir).exists())
            self.assertEqual(ops.events, [])

    def test_next_activation_recovers_crash_during_explicit_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                first_transaction = Path(args.transaction_dir)
                manifest = json.loads((first_transaction / "backup.json").read_text())
                activated = json.loads((first_transaction / "activation-receipt.json").read_text())
                activation.write_state(first_transaction, "rollback_started", {
                    "backupDigest": manifest["receiptDigest"],
                    "priorServiceState": ops.service_state(),
                    "activationReceiptDigest": activated["receiptDigest"],
                    "rollbackClaimDigest": None,
                })
                claim = activation.write_receipt(first_transaction, "rollback_claimed", {
                    "backupDigest": manifest["receiptDigest"],
                    "activationDigest": activated["receiptDigest"],
                }, "rollback-claim.json")
                first_name = next(iter(artifacts))
                first_backup = Path(manifest["artifacts"][first_name]["backup"]).read_bytes()
                activation.durable_write(artifacts[first_name], first_backup, manifest["artifacts"][first_name]["mode"])
                activation.set_workspace_root_metadata(manifest["workspaceRoot"], {
                    "uid": manifest["workspaceRoot"]["uid"],
                    "gid": manifest["workspaceRoot"]["gid"],
                    "mode": manifest["workspaceRoot"]["mode"],
                })
                ops.active = False

                args.transaction_dir = str(Path(args.transaction_root) / "tx-after-rollback-crash")
                receipt = activation.activate(args, ops)
                self.assertEqual(receipt["recoveredTransactions"], [str(first_transaction.resolve())])
                self.assertEqual(activation.read_state(first_transaction)["phase"], "rolled_back")
                recovered = json.loads((first_transaction / "rollback-receipt.json").read_text())
                self.assertFalse(recovered["automatic"])
                self.assertEqual(recovered["claimDigest"], claim["receiptDigest"])
                activation.explicit_rollback(args, ops)
                for name, path in artifacts.items():
                    self.assertEqual(path.read_bytes(), old[name][0])

    def test_next_activation_recovers_explicit_rollback_before_claim_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                first_transaction = Path(args.transaction_dir)
                manifest = json.loads((first_transaction / "backup.json").read_text())
                activated = json.loads((first_transaction / "activation-receipt.json").read_text())
                activation.write_state(first_transaction, "rollback_started", {
                    "backupDigest": manifest["receiptDigest"],
                    "priorServiceState": activated["priorServiceState"],
                    "activationReceiptDigest": activated["receiptDigest"],
                    "rollbackClaimDigest": None,
                })

                args.transaction_dir = str(Path(args.transaction_root) / "tx-after-preclaim-crash")
                receipt = activation.activate(args, ops)
                self.assertEqual(receipt["recoveredTransactions"], [str(first_transaction.resolve())])
                claim = json.loads((first_transaction / "rollback-claim.json").read_text())
                recovered = json.loads((first_transaction / "rollback-receipt.json").read_text())
                self.assertFalse(recovered["automatic"])
                self.assertEqual(recovered["claimDigest"], claim["receiptDigest"])

    def test_explicit_rollback_rejects_noncurrent_transaction_without_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                first_transaction = Path(args.transaction_dir)
                args.transaction_dir = str(Path(args.transaction_root) / "tx-2")
                activation.activate(args, ops)
                values_before = {name: path.read_bytes() for name, path in artifacts.items()}
                events_before = list(ops.events)

                args.transaction_dir = str(first_transaction)
                with self.assertRaisesRegex(activation.ActivationError, "not the active release lineage"):
                    activation.explicit_rollback(args, ops)
                self.assertEqual(ops.events, events_before)
                self.assertEqual({name: path.read_bytes() for name, path in artifacts.items()}, values_before)
                self.assertFalse((first_transaction / "rollback-claim.json").exists())

    def test_explicit_rollback_rejects_live_artifact_drift_without_effects(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                drifted = next(iter(artifacts.values()))
                activation.durable_write(drifted, b"unreviewed-live-drift\n", 0o555)
                events_before = list(ops.events)

                with self.assertRaisesRegex(activation.ActivationError, "artifact evidence has drifted"):
                    activation.explicit_rollback(args, ops)
                self.assertEqual(ops.events, events_before)
                self.assertEqual(drifted.read_bytes(), b"unreviewed-live-drift\n")
                self.assertFalse((Path(args.transaction_dir) / "rollback-claim.json").exists())

    def test_next_activation_rejects_live_active_release_drift_before_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            args, artifacts, _old = self.fixture(Path(directory))
            ops = FakeOperations()
            with patch.object(activation, "ARTIFACTS", artifacts), patch.object(activation, "WORKSPACE_ROOT", Path(args.workspace_root)):
                activation.activate(args, ops)
                drifted = next(iter(artifacts.values()))
                activation.durable_write(drifted, b"unreviewed-live-drift\n", 0o555)
                events_before = list(ops.events)
                args.transaction_dir = str(Path(args.transaction_root) / "tx-drift-refused")

                with self.assertRaisesRegex(activation.ActivationError, "artifact evidence has drifted"):
                    activation.activate(args, ops)
                self.assertEqual(ops.events, events_before)
                self.assertFalse(Path(args.transaction_dir).exists())


if __name__ == "__main__":
    unittest.main()
