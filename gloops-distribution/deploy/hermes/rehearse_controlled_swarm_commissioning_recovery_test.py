from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest


SCRIPT = Path(__file__).with_name(
    "rehearse-controlled-swarm-commissioning-recovery.py",
)


def load_rehearsal() -> object:
    spec = importlib.util.spec_from_file_location(
        "controlled_swarm_commissioning_recovery_rehearsal_test",
        SCRIPT,
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def exact_fixture(rehearsal: object, phases: tuple[str, ...]) -> tuple[object, dict, dict]:
    digest = "sha256:" + "a" * 64
    image = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "b" * 64
    module = SimpleNamespace(ROLLBACK_JOURNAL_PHASES=phases)
    split = {
        "systemdUnitExecuted": True,
        "outcome": "split_artifact_matrix_passed",
        "phaseMatrix": [{"phase": phase} for phase in phases],
    }
    exact = {
        "systemdUnitExecuted": True,
        "installedWrapperExecuted": True,
        "realHostCommissionerSigkilled": True,
        "allDurablePhasesSigkilled": True,
        "wrapperStartedRecoveryUnit": True,
        "repeatedRecoveryNoOp": True,
        "persistedBarrier": "false",
        "effectiveBarrier": "false",
        "providersInvoked": False,
        "repositoriesMutated": False,
        "approvedImage": image,
        "repositoryContentBeforeSha256": digest,
        "repositoryContentAfterSha256": digest,
        "effectiveRecoveryUnit": {
            "unitFileState": "enabled",
            "fragmentPath": str(rehearsal.INSTALLED_UNIT),
            "dropInPaths": [],
            "diskExecCommands": [rehearsal.RECOVERY_EXEC_ARGV],
            "diskConditions": rehearsal.RECOVERY_CONDITIONS,
            "diskTimeoutStartSec": 180,
            "diskTimeoutStopSec": 180,
            "diskReadWritePaths": rehearsal.RECOVERY_READ_WRITE_PATHS,
            "diskSecurityProperties": (
                rehearsal.RECOVERY_SECURITY_PROPERTIES
            ),
            "loadedExecCommands": [rehearsal.RECOVERY_EXEC_ARGV],
            "loadedConditions": rehearsal.RECOVERY_CONDITIONS,
            "loadedConditionsRaw": "[unprintable]",
            "loadedTimeoutStartUSec": "3min",
            "loadedTimeoutStopUSec": "3min",
            "loadedTimeoutStartMicroseconds": (
                rehearsal.RECOVERY_TIMEOUT_START_USEC
            ),
            "loadedTimeoutStopMicroseconds": (
                rehearsal.RECOVERY_TIMEOUT_STOP_USEC
            ),
            "loadedReadWritePaths": rehearsal.RECOVERY_READ_WRITE_PATHS,
            "loadedSecurityProperties": (
                rehearsal.RECOVERY_LOADED_SECURITY_PROPERTIES
            ),
            "canonicalExpectedSha256": (
                rehearsal.EXPECTED_RECOVERY_UNIT_SHA256
            ),
            "fragmentSha256": rehearsal.EXPECTED_RECOVERY_UNIT_SHA256,
            "loadedRawPropertiesSha256": digest,
            "effectivePropertiesSha256": digest,
        },
        "paperclipRuntime": {
            "approvedImage": image,
            "paperclipUnitSha256": digest,
            "paperclipEffectivePropertiesSha256": digest,
            "runtimeEnvSha256": digest,
            "sidecarConfigSha256": digest,
            "sidecarPolicySha256": digest,
            "credentialBrokerSha256": digest,
            "githubAppConfigSha256": digest,
            "globalSchedulersDisabled": True,
            "projectorPermissionsExpected": rehearsal.PROJECTOR_PERMISSIONS,
            "credentialLifecycleCommands": {
                "mint": "refresh-projector",
                "project": "rotate-projector",
                "clear": "clear-projector",
                "revoke": "revoke-projector",
            },
        },
        "providerInvocationProof": {
            "campaignEpochAbsent": True,
            "admittedAgentsRemainPaused": True,
            "globalSchedulersRemainDisabled": True,
        },
        "phaseMatrix": [
            {
                "phase": phase,
                "commissionerCrashSignal": "SIGKILL",
                "wrapperExitCode": 137,
                "wrapperStartedRecoveryUnit": True,
                "conditionResult": "yes",
                "result": "success",
                "invocationId": f"invocation-{index}",
                "execMainCode": "exited",
                "execMainStatus": "0",
                "execMainStartTimestamp": "Sat 2026-07-18 20:00:00 UTC",
                "execMainExitTimestamp": "Sat 2026-07-18 20:00:01 UTC",
                "execMainStartTimestampMonotonic": str(index * 10 + 1),
                "execMainExitTimestampMonotonic": str(index * 10 + 2),
                "repeatedConditionResult": "no",
                "repeatedInvocationId": f"invocation-{index}",
                "repeatedRecoveryNoOp": True,
                "persistedBarrier": "false",
                "effectiveBarrier": "false",
                "priorConfigsSha256": digest,
                "restoredConfigsSha256": digest,
                "repositoryContentSha256": digest,
                "campaignEpochAbsent": True,
                "credentialLifecycle": {
                    "priorLifecycleId": f"lifecycle-{index}",
                    "priorCredentialReceiptSha256": digest,
                    "priorProjectorTokenFingerprintSha256": (
                        "sha256:" + format(index + 2, "x") * 64
                    ),
                    "revokeProjectorArgv": [
                        str(rehearsal.GITHUB_BROKER),
                        "revoke-projector",
                    ],
                    "revokeProjectorCommandSucceeded": True,
                    "preHistoryRecordCount": index - 1,
                    "preHistoryLogSha256": digest,
                    "preHistoryRawSha256": digest,
                    "priorAbsentFromPreHistory": True,
                    "postHistoryRecordCount": index,
                    "postHistoryPrefixSha256": digest,
                    "postHistoryPrefixRawSha256": digest,
                    "postHistoryLogSha256": digest,
                    "archiveAppendedExactlyOnce": True,
                    "revokedHistorySequence": index,
                    "revokedLifecycleId": f"lifecycle-{index}",
                    "revokedHistoryReceiptSha256": digest,
                    "revokedProjectorAt": "2026-07-18T20:00:02+00:00",
                    "revokedProjectorPermissions": (
                        rehearsal.PROJECTOR_PERMISSIONS
                    ),
                    "newLifecycleId": f"lifecycle-{index + 1}",
                    "newCredentialReceiptSha256": digest,
                    "newProjectorTokenFingerprintSha256": (
                        "sha256:" + format(index + 3, "x") * 64
                    ),
                    "newProjectorPermissions": (
                        rehearsal.PROJECTOR_PERMISSIONS
                    ),
                    "newAbsentFromPostHistory": True,
                    "newAbsentFromPriorTransitions": True,
                    "durableLifecycleTransition": True,
                },
            }
            for index, phase in enumerate(phases, start=1)
        ],
    }
    exact["effectiveRecoveryUnit"]["effectivePropertiesSha256"] = (
        rehearsal.loaded_unit_contract_digest(
            exact["effectiveRecoveryUnit"],
        )
    )
    return module, split, exact


class CommissioningRecoveryRehearsalTest(unittest.TestCase):
    def test_sigkill_rehearsal_emits_content_addressed_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "--allow-source-root",
                    str(SCRIPT.parent),
                    "--receipt-dir",
                    str(output),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=30,
            )
            receipt_path = Path(result.stdout.strip())
            payload = receipt_path.read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(
                receipt_path.name,
                f"controlled-swarm-commissioning-recovery-{digest}.json",
            )
            receipt = json.loads(payload)
            self.assertEqual(receipt["outcome"], "source_harness_passed")
            self.assertFalse(receipt["providersInvoked"])
            self.assertFalse(receipt["productionStateMutated"])
            self.assertFalse(
                receipt["installedSystemdProof"]["systemdUnitExecuted"],
            )
            self.assertFalse(
                receipt["installedWrapperProof"]["systemdUnitExecuted"],
            )
            self.assertFalse(
                receipt["installedWrapperProof"]["installedWrapperExecuted"],
            )
            self.assertFalse(
                receipt["installedWrapperProof"]["realHostCommissionerSigkilled"],
            )
            self.assertIn(
                "source-only harness",
                receipt["installedSystemdProof"]["reason"],
            )
            self.assertIn(
                "source-only harness",
                receipt["installedWrapperProof"]["reason"],
            )
            self.assertTrue(receipt["recoveryUnitRootOnly"])
            self.assertTrue(receipt["recoveryUnitRequiresOrphanJournal"])
            self.assertFalse(receipt["recoveryUnitRequiresFalseBarrier"])
            self.assertTrue(receipt["recoveryUnitFencesBeforeRollback"])
            self.assertTrue(receipt["wrapperDelegatesFencingToRecovery"])
            self.assertTrue(receipt["sourceCommissionerSigkillMatrix"])
            self.assertFalse(receipt["splitArtifactMatrixPassed"])
            self.assertFalse(receipt["gate2ExactTopologyClaimed"])
            self.assertIsNone(receipt["approvedImage"])
            self.assertTrue(receipt["corruptJournalRefused"])
            self.assertTrue(receipt["rollbackFailureRemainedDark"])
            self.assertEqual(
                [row["phase"] for row in receipt["phases"]],
                [
                    "journal_recorded",
                    "configs_applied",
                    "configs_verified",
                    "receipt_written",
                    "barrier_enabled",
                    "control_plane_restarted",
                    "live_verified",
                ],
            )
            self.assertTrue(
                all(row["crashSignal"] == "SIGKILL" for row in receipt["phases"]),
            )
            self.assertTrue(
                all(row["repeatedRecoveryNoOp"] for row in receipt["phases"]),
            )
            self.assertTrue(
                all(row["persistedBarrier"] == "false" for row in receipt["phases"]),
            )
            self.assertTrue(
                all(row["effectiveBarrier"] == "false" for row in receipt["phases"]),
            )
            pre_states = {
                row["phase"]: (
                    row["preRecoveryPersistedBarrier"],
                    row["preRecoveryEffectiveBarrier"],
                )
                for row in receipt["phases"]
            }
            self.assertEqual(
                pre_states,
                {
                    "journal_recorded": ("false", "false"),
                    "configs_applied": ("false", "false"),
                    "configs_verified": ("false", "false"),
                    "receipt_written": ("false", "false"),
                    "barrier_enabled": ("true", "false"),
                    "control_plane_restarted": ("true", "true"),
                    "live_verified": ("true", "true"),
                },
            )

    def test_exact_host_claim_requires_both_matrices_and_failure_proofs(
        self,
    ) -> None:
        rehearsal = load_rehearsal()
        phases = ("journal_recorded", "barrier_enabled", "live_verified")
        module, split, exact = exact_fixture(rehearsal, phases)
        self.assertTrue(
            rehearsal.exact_host_proof_passed(
                module,
                split,
                exact,
                corrupt_journal_refused=True,
                rollback_failure_remained_dark=True,
            ),
        )
        exact["phaseMatrix"][1]["restoredConfigsSha256"] = (
            "sha256:" + "c" * 64
        )
        self.assertFalse(
            rehearsal.exact_host_proof_passed(
                module,
                split,
                exact,
                corrupt_journal_refused=True,
                rollback_failure_remained_dark=True,
            ),
        )

    def test_exact_host_claim_rejects_missing_failure_path_proof(self) -> None:
        rehearsal = load_rehearsal()
        module, split, exact = exact_fixture(
            rehearsal,
            ("journal_recorded",),
        )
        self.assertFalse(
            rehearsal.exact_host_proof_passed(
                module,
                split,
                exact,
                corrupt_journal_refused=False,
                rollback_failure_remained_dark=True,
            ),
        )

    def test_exact_host_claim_rejects_every_critical_evidence_drift(self) -> None:
        rehearsal = load_rehearsal()
        module, split, exact = exact_fixture(
            rehearsal,
            ("journal_recorded", "live_verified"),
        )
        mutations = {
            "wrapper exit": lambda value: value["phaseMatrix"][0].update(
                wrapperExitCode=0,
            ),
            "condition skipped": lambda value: value["phaseMatrix"][0].update(
                conditionResult="no",
            ),
            "unit failed": lambda value: value["phaseMatrix"][0].update(
                result="exit-code",
            ),
            "replay occurred": lambda value: value["phaseMatrix"][0].update(
                repeatedConditionResult="yes",
            ),
            "invalid config digest": lambda value: value["phaseMatrix"][0].update(
                priorConfigsSha256="sha256:not-a-digest",
            ),
            "duplicate invocation": lambda value: value["phaseMatrix"][1].update(
                invocationId="invocation-1",
                repeatedInvocationId="invocation-1",
            ),
            "repository mutation": lambda value: value.update(
                repositoryContentAfterSha256="sha256:" + "d" * 64,
            ),
            "provider attempt": lambda value: value.update(
                providersInvoked=True,
            ),
            "projector write scope": lambda value: value["phaseMatrix"][0][
                "credentialLifecycle"
            ].update(newProjectorPermissions={"contents": "write"}),
            "unit drop-in": lambda value: value["effectiveRecoveryUnit"].update(
                dropInPaths=["/etc/systemd/system/recovery.d/override.conf"],
            ),
            "unit extra argument": lambda value: value[
                "effectiveRecoveryUnit"
            ]["loadedExecCommands"][0].append("--unexpected"),
            "unit extra command": lambda value: value[
                "effectiveRecoveryUnit"
            ]["loadedExecCommands"].append(["/usr/bin/true"]),
            "unit extra condition": lambda value: value[
                "effectiveRecoveryUnit"
            ]["loadedConditions"].append("ConditionPathExists=/tmp/untrusted"),
            "unit wrong expected digest": lambda value: value[
                "effectiveRecoveryUnit"
            ].update(canonicalExpectedSha256="sha256:" + "f" * 64),
            "unit weakened security": lambda value: value[
                "effectiveRecoveryUnit"
            ]["loadedSecurityProperties"].update(NoNewPrivileges="false"),
            "unit 99-year stop timeout": lambda value: value[
                "effectiveRecoveryUnit"
            ].update(
                loadedTimeoutStopUSec="99year",
                loadedTimeoutStopMicroseconds=(
                    99 * 31_557_600_000_000
                ),
            ),
            "missing revoke evidence": lambda value: value["phaseMatrix"][0][
                "credentialLifecycle"
            ].update(revokeProjectorCommandSucceeded=False),
            "pre-existing lifecycle archive": lambda value: value[
                "phaseMatrix"
            ][0]["credentialLifecycle"].update(
                priorAbsentFromPreHistory=False,
            ),
            "lifecycle recycling": lambda value: value["phaseMatrix"][1][
                "credentialLifecycle"
            ].update(
                newLifecycleId=value["phaseMatrix"][0][
                    "credentialLifecycle"
                ]["priorLifecycleId"],
                newProjectorTokenFingerprintSha256=value["phaseMatrix"][0][
                    "credentialLifecycle"
                ]["priorProjectorTokenFingerprintSha256"],
            ),
            "duplicate archive sequence": lambda value: value[
                "phaseMatrix"
            ][1]["credentialLifecycle"].update(revokedHistorySequence=1),
            "out-of-order archive sequence": lambda value: value[
                "phaseMatrix"
            ][1]["credentialLifecycle"].update(revokedHistorySequence=0),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                candidate = copy.deepcopy(exact)
                mutate(candidate)
                self.assertFalse(
                    rehearsal.exact_host_proof_passed(
                        module,
                        split,
                        candidate,
                        corrupt_journal_refused=True,
                        rollback_failure_remained_dark=True,
                    ),
                )

    def test_command_specific_revoke_rejects_unrelated_success(self) -> None:
        rehearsal = load_rehearsal()
        revoke = [
            "/usr/local/lib/paperclip-gloops/github-app-credentials.py",
            "revoke-projector",
        ]
        raw = (
            "{ path=/usr/local/lib/paperclip-gloops/"
            "github-app-credentials.py ; "
            "argv[]=/usr/local/lib/paperclip-gloops/"
            "github-app-credentials.py revoke-projector ; "
            "status=1/FAILURE } "
            "{ path=/usr/bin/docker ; "
            "argv[]=/usr/bin/docker rm -f paperclip-gloops ; "
            "status=0/SUCCESS }"
        )
        self.assertFalse(
            rehearsal.exec_status_for_argv(
                raw,
                revoke,
            ),
        )
        self.assertTrue(
            rehearsal.exec_status_for_argv(
                raw.replace("status=1/FAILURE", "status=0/SUCCESS", 1),
                revoke,
            ),
        )
        self.assertFalse(
            rehearsal.exec_status_for_argv(
                raw.replace("status=1/FAILURE", "status=0/SUCCESS", 1)
                + " { path=/usr/local/lib/paperclip-gloops/"
                "github-app-credentials.py ; "
                "argv[]=/usr/local/lib/paperclip-gloops/"
                "github-app-credentials.py revoke-projector ; "
                "status=0/SUCCESS }",
                revoke,
            ),
        )

    def test_history_snapshot_cannot_mix_raw_and_logical_chains(self) -> None:
        rehearsal = load_rehearsal()

        def encoded(lifecycle: str) -> bytes:
            record = {
                "sequence": 1,
                "previousReceiptDigest": None,
                "lifecycleId": lifecycle,
                "hermes": {"revokedAt": "2026-07-18T20:00:00+00:00"},
                "projector": {"revokedAt": "2026-07-18T20:00:01+00:00"},
            }
            record["receiptDigest"] = rehearsal.credential_history_digest(
                record,
            )
            return (json.dumps(record, sort_keys=True) + "\n").encode("utf-8")

        raw_chain = encoded("raw-chain")
        different_logical_chain = encoded("different-logical-chain")

        class SnapshotPath:
            byte_reads = 0
            text_reads = 0

            def exists(self) -> bool:
                return True

            def stat(self) -> SimpleNamespace:
                return SimpleNamespace(st_mode=0o600, st_uid=0)

            def read_bytes(self) -> bytes:
                self.byte_reads += 1
                return raw_chain

            def read_text(self, **_kwargs: object) -> str:
                self.text_reads += 1
                return different_logical_chain.decode("utf-8")

        snapshot_path = SnapshotPath()
        original = rehearsal.GITHUB_CREDENTIAL_HISTORY
        rehearsal.GITHUB_CREDENTIAL_HISTORY = snapshot_path
        try:
            raw, records = rehearsal.credential_history_snapshot()
        finally:
            rehearsal.GITHUB_CREDENTIAL_HISTORY = original
        self.assertEqual(raw, raw_chain)
        self.assertEqual(records[0]["lifecycleId"], "raw-chain")
        self.assertNotEqual(
            records[0]["lifecycleId"],
            json.loads(different_logical_chain)["lifecycleId"],
        )
        self.assertEqual(snapshot_path.byte_reads, 1)
        self.assertEqual(snapshot_path.text_reads, 0)

    def test_history_snapshot_rejects_duplicate_keys_and_nan(self) -> None:
        rehearsal = load_rehearsal()
        valid = {
            "sequence": 1,
            "previousReceiptDigest": None,
            "lifecycleId": "strict-chain",
            "hermes": {"revokedAt": "2026-07-18T20:00:00+00:00"},
            "projector": {"revokedAt": "2026-07-18T20:00:01+00:00"},
        }
        valid["receiptDigest"] = rehearsal.credential_history_digest(valid)
        valid_json = json.dumps(valid, sort_keys=True)
        duplicate = valid_json.replace(
            '"lifecycleId": "strict-chain"',
            '"lifecycleId": "shadow", "lifecycleId": "strict-chain"',
            1,
        ).encode("utf-8") + b"\n"

        nan_record = {
            **valid,
            "probe": float("nan"),
        }
        unsigned_nan = dict(nan_record)
        unsigned_nan.pop("receiptDigest", None)
        nan_record["receiptDigest"] = hashlib.sha256(
            json.dumps(
                unsigned_nan,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8"),
        ).hexdigest()
        nan_value = (
            json.dumps(nan_record, sort_keys=True) + "\n"
        ).encode("utf-8")

        for label, raw in (("duplicate", duplicate), ("NaN", nan_value)):
            with self.subTest(label=label):
                class SnapshotPath:
                    byte_reads = 0
                    text_reads = 0

                    def exists(self) -> bool:
                        return True

                    def stat(self) -> SimpleNamespace:
                        return SimpleNamespace(st_mode=0o600, st_uid=0)

                    def read_bytes(self) -> bytes:
                        self.byte_reads += 1
                        return raw

                    def read_text(self, **_kwargs: object) -> str:
                        self.text_reads += 1
                        raise AssertionError("split history read is forbidden")

                snapshot_path = SnapshotPath()
                original = rehearsal.GITHUB_CREDENTIAL_HISTORY
                rehearsal.GITHUB_CREDENTIAL_HISTORY = snapshot_path
                try:
                    with self.assertRaises(RuntimeError):
                        rehearsal.credential_history_snapshot()
                finally:
                    rehearsal.GITHUB_CREDENTIAL_HISTORY = original
                self.assertEqual(snapshot_path.byte_reads, 1)
                self.assertEqual(snapshot_path.text_reads, 0)

        with self.assertRaises(ValueError):
            rehearsal.credential_history_digest(
                {"lifecycleId": "nan", "probe": float("nan")},
            )
        with self.assertRaises(ValueError):
            rehearsal.credential_history_log_digest(
                [{"lifecycleId": "nan", "probe": float("nan")}],
            )

    def test_active_receipt_is_one_strict_semantic_hash_snapshot(self) -> None:
        rehearsal = load_rehearsal()

        def receipt(lifecycle: str, fingerprint: str) -> dict[str, object]:
            return {
                "lifecycleId": lifecycle,
                "projector": {
                    "mintedAt": "2026-07-18T20:00:00+00:00",
                    "expiresAt": "2026-07-18T21:00:00+00:00",
                    "revokedAt": None,
                    "expiredAt": None,
                    "tokenFingerprint": fingerprint,
                    "permissions": rehearsal.PROJECTOR_PERMISSIONS,
                },
            }

        raw_receipt = (
            json.dumps(receipt("raw-lifecycle", "a" * 64), sort_keys=True)
            + "\n"
        ).encode("utf-8")
        divergent_receipt = (
            json.dumps(
                receipt("divergent-lifecycle", "b" * 64),
                sort_keys=True,
            )
            + "\n"
        ).encode("utf-8")

        class SnapshotPath:
            byte_reads = 0
            text_reads = 0

            def stat(self) -> SimpleNamespace:
                return SimpleNamespace(st_mode=0o600, st_uid=0)

            def read_bytes(self) -> bytes:
                self.byte_reads += 1
                return (
                    raw_receipt
                    if self.byte_reads == 1
                    else divergent_receipt
                )

            def read_text(self, **_kwargs: object) -> str:
                self.text_reads += 1
                return divergent_receipt.decode("utf-8")

        snapshot_path = SnapshotPath()
        original = rehearsal.GITHUB_CREDENTIAL_RECEIPT
        rehearsal.GITHUB_CREDENTIAL_RECEIPT = snapshot_path
        try:
            evidence = rehearsal.active_projector_credential()
        finally:
            rehearsal.GITHUB_CREDENTIAL_RECEIPT = original
        self.assertEqual(evidence["lifecycleId"], "raw-lifecycle")
        self.assertEqual(
            evidence["receiptSha256"],
            "sha256:" + hashlib.sha256(raw_receipt).hexdigest(),
        )
        self.assertEqual(snapshot_path.byte_reads, 1)
        self.assertEqual(snapshot_path.text_reads, 0)

    def test_active_receipt_rejects_nested_duplicate_and_nonfinite(
        self,
    ) -> None:
        rehearsal = load_rehearsal()
        receipt = {
            "lifecycleId": "strict-active",
            "projector": {
                "mintedAt": "2026-07-18T20:00:00+00:00",
                "expiresAt": "2026-07-18T21:00:00+00:00",
                "revokedAt": None,
                "expiredAt": None,
                "tokenFingerprint": "a" * 64,
                "permissions": rehearsal.PROJECTOR_PERMISSIONS,
            },
        }
        valid_json = json.dumps(receipt, sort_keys=True)
        duplicate = valid_json.replace(
            '"contents": "read"',
            '"contents": "write", "contents": "read"',
            1,
        ).encode("utf-8") + b"\n"
        nonfinite_receipt = copy.deepcopy(receipt)
        nonfinite_receipt["projector"]["probe"] = float("nan")
        nonfinite = (
            json.dumps(nonfinite_receipt, sort_keys=True) + "\n"
        ).encode("utf-8")

        for label, raw in (("nested duplicate", duplicate), ("NaN", nonfinite)):
            with self.subTest(label=label):
                class SnapshotPath:
                    byte_reads = 0
                    text_reads = 0

                    def stat(self) -> SimpleNamespace:
                        return SimpleNamespace(st_mode=0o600, st_uid=0)

                    def read_bytes(self) -> bytes:
                        self.byte_reads += 1
                        return raw

                    def read_text(self, **_kwargs: object) -> str:
                        self.text_reads += 1
                        raise AssertionError("split receipt read is forbidden")

                snapshot_path = SnapshotPath()
                original = rehearsal.GITHUB_CREDENTIAL_RECEIPT
                rehearsal.GITHUB_CREDENTIAL_RECEIPT = snapshot_path
                try:
                    with self.assertRaises(RuntimeError):
                        rehearsal.active_projector_credential()
                finally:
                    rehearsal.GITHUB_CREDENTIAL_RECEIPT = original
                self.assertEqual(snapshot_path.byte_reads, 1)
                self.assertEqual(snapshot_path.text_reads, 0)

    def test_fail_closed_fence_attempts_false_after_stop_failure(self) -> None:
        rehearsal = load_rehearsal()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            runtime_env = root / "runtime.env"
            runtime_env.write_text(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true\n",
                encoding="utf-8",
            )
            paths = SimpleNamespace(runtime_env=runtime_env)

            class Platform:
                active = True
                barrier_calls: list[bool] = []

                def stop_paperclip(self) -> None:
                    raise RuntimeError("simulated stop failure")

                def is_active(self, _unit: str) -> bool:
                    return self.active

                def set_barrier(self, value: bool) -> None:
                    self.barrier_calls.append(value)
                    runtime_env.write_text(
                        "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                        encoding="utf-8",
                    )

            platform = Platform()
            with self.assertRaisesRegex(RuntimeError, "stop failed"):
                rehearsal.fail_closed_fence(paths, platform)
            self.assertEqual(platform.barrier_calls, [False])
            self.assertTrue(platform.active)

    def test_approval_cleanup_preserves_unresolved_journal(self) -> None:
        rehearsal = load_rehearsal()
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / "config"
            state = Path(temporary) / "state"
            config.mkdir()
            state.mkdir()
            approval = config / "CONTROLLED_SWARM_COMMISSIONING_APPROVED"
            in_progress = config / (
                ".CONTROLLED_SWARM_COMMISSIONING_APPROVED.123"
            )
            journal = state / "commissioning-rollback.json"
            approval.write_text("approval", encoding="utf-8")
            in_progress.write_text("in-progress", encoding="utf-8")
            journal.write_text("journal", encoding="utf-8")
            paths = SimpleNamespace(
                approval=approval,
                config_dir=config,
                rollback_journal=journal,
            )
            rehearsal.cleanup_one_use_approvals(paths)
            self.assertFalse(approval.exists())
            self.assertFalse(in_progress.exists())
            self.assertTrue(journal.exists())


if __name__ == "__main__":
    unittest.main()
