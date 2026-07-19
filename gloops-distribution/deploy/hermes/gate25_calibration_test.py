#!/usr/bin/env python3

from __future__ import annotations

import datetime as dt
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("run-gate25-calibration.py")
SPEC = importlib.util.spec_from_file_location("gate25_calibration", SCRIPT)
assert SPEC and SPEC.loader
gate25 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate25)


class Gate25CalibrationTests(unittest.TestCase):
    def approval(self) -> dict[str, object]:
        at = dt.datetime(2026, 7, 19, 20, 0, tzinfo=dt.timezone.utc)
        return {
            "schemaVersion": gate25.SCHEMA,
            "authorization": "execute_one_implementation_one_review_one_push",
            "calibrationId": "gate25-" + "a" * 32,
            "approvedImage": gate25.EXPECTED_IMAGE,
            "companyId": gate25.COMPANY_ID,
            "projectId": gate25.PROJECT_ID,
            "projectWorkspaceId": gate25.PROJECT_WORKSPACE_ID,
            "implementationAgentId": gate25.IMPLEMENTER_ID,
            "reviewAgentId": gate25.REVIEWER_ID,
            "repositoryId": gate25.REPOSITORY_ID,
            "repositoryFullName": gate25.REPOSITORY,
            "defaultBranch": gate25.DEFAULT_BRANCH,
            "baseSha": "b" * 40,
            "authorizedAt": gate25.timestamp(at),
            "expiresAt": gate25.timestamp(at + dt.timedelta(hours=1)),
            "maxWallSeconds": 3600,
        }

    def test_approval_is_exact_bounded_and_artifact_bound(self) -> None:
        at = dt.datetime(2026, 7, 19, 20, 30, tzinfo=dt.timezone.utc)
        expected = self.approval()
        self.assertEqual(
            gate25.validate_approval(expected, at, gate25.EXPECTED_IMAGE),
            expected,
        )
        for changed in (
            {**expected, "reviewAgentId": gate25.IMPLEMENTER_ID},
            {**expected, "repositoryFullName": "gloopsAI/paperclip"},
            {**expected, "maxWallSeconds": 7200},
            {**expected, "unexpected": True},
        ):
            with self.assertRaises(gate25.CalibrationError):
                gate25.validate_approval(changed, at, gate25.EXPECTED_IMAGE)

    def test_runtime_is_zero_retry_two_stage_and_has_no_campaign(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runtime = Path(directory) / "runtime.env"
            runtime.write_text(
                "HOST=0.0.0.0\n"
                "PAPERCLIP_CAMPAIGN_ID=forbidden\n"
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n"
                "PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=2\n",
                encoding="utf-8",
            )
            with patch.object(gate25, "BASE_RUNTIME", runtime):
                value = gate25.runtime_environment(self.approval())
        self.assertNotIn("PAPERCLIP_CAMPAIGN_ID", value)
        self.assertIn("PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true", value)
        self.assertIn("PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS=1", value)
        self.assertIn("PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK=2", value)
        self.assertIn("PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK=0", value)

    def test_roles_are_separate_and_only_implementer_can_push(self) -> None:
        approval = self.approval()
        implementer = gate25.calibration_instructions("implementer", approval)
        reviewer = gate25.calibration_instructions("reviewer", approval)
        self.assertIn("github-push-tool.bundle.cjs client", implementer)
        self.assertIn("Do not modify or push", reviewer)
        self.assertIn("Do not inspect unrelated work", implementer)
        self.assertIn("Do not inspect unrelated work", reviewer)

    def test_github_authorization_is_one_run_one_new_ref(self) -> None:
        approval = self.approval()
        run_id = "11111111-1111-4111-8111-111111111111"
        issue = {"id": "22222222-2222-4222-8222-222222222222"}
        with tempfile.TemporaryDirectory() as directory, patch.object(
            gate25, "CONFIG_DIR", Path(directory),
        ):
            digest = gate25.install_authorization(approval, issue, run_id)
            value = json.loads((Path(directory) / "github-push-authorization.json").read_text())
        self.assertEqual(value["branchRef"], f"refs/heads/paperclip/{run_id}/calibration")
        self.assertEqual(value["expectedOldOid"], gate25.ZERO_OID)
        self.assertEqual(value["maxLeases"], 1)
        self.assertEqual(value["maxMutations"], 1)
        self.assertTrue(digest.startswith("sha256:"))

    def test_atomic_root_write_removes_staging_file_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "authority.json"
            with patch.object(gate25.os, "replace", side_effect=OSError("injected")):
                with self.assertRaises(OSError):
                    gate25.atomic_root_write(destination, b"authority")
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_review_run_uses_activity_run_id(self) -> None:
        calls = 0

        def fake_api(_token: str, _method: str, path: str, _body=None):
            nonlocal calls
            if path.endswith("/runs"):
                calls += 1
                return [{
                    "runId": "33333333-3333-4333-8333-333333333333",
                    "agentId": gate25.REVIEWER_ID,
                }]
            return {
                "id": "33333333-3333-4333-8333-333333333333",
                "status": "succeeded",
            }

        with patch.object(gate25, "api", fake_api):
            result = gate25.wait_review_run(
                "token",
                "issue",
                "implementation",
                10**12,
            )
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(calls, 1)

    def test_receipt_projection_excludes_raw_result_and_logs(self) -> None:
        value = gate25.run_receipt({
            "id": "run",
            "status": "succeeded",
            "agentId": gate25.IMPLEMENTER_ID,
            "usageJson": {"inputTokens": 10},
            "resultJson": {"raw": "must not persist"},
            "stdout": "must not persist",
        })
        self.assertEqual(
            value,
            {
                "id": "run",
                "status": "succeeded",
                "agentId": gate25.IMPLEMENTER_ID,
                "usageJson": {"inputTokens": 10},
            },
        )

    def test_broker_receipt_requires_one_posted_successful_lease(self) -> None:
        run_id = "33333333-3333-4333-8333-333333333333"
        authorization_digest = "sha256:" + "a" * 64
        terminal = {
            "heartbeatRunId": run_id,
            "branchRef": f"refs/heads/paperclip/{run_id}/calibration",
            "rootAuthorizationDigest": authorization_digest,
            "expectedOldOid": gate25.ZERO_OID,
            "expectedNewOid": "b" * 40,
            "remoteOldOid": gate25.ZERO_OID,
            "remoteNewOid": "b" * 40,
            "state": "reconciled_success",
            "brokerReceiptDigest": "sha256:" + "c" * 64,
        }
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "broker.sqlite3"
            connection = sqlite3.connect(database)
            connection.execute(
                """
                CREATE TABLE leases (
                  authorization_digest TEXT,
                  state TEXT,
                  lease_json TEXT,
                  terminal_receipt_json TEXT,
                  terminal_posted INTEGER
                )
                """,
            )
            connection.execute(
                "INSERT INTO leases VALUES (?, ?, ?, ?, 1)",
                (
                    authorization_digest,
                    "reconciled_success",
                    json.dumps({"paperclipRunId": run_id}),
                    json.dumps(terminal),
                ),
            )
            connection.commit()
            connection.close()
            with patch.object(gate25, "BROKER_DATABASE", database):
                result = gate25.broker_receipt(run_id, authorization_digest)
        self.assertEqual(result["state"], "reconciled_success")
        self.assertEqual(result["remoteNewOid"], "b" * 40)


if __name__ == "__main__":
    unittest.main()
