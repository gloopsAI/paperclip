#!/usr/bin/env python3
"""Deterministic tests for the one-run/one-push root broker."""

from __future__ import annotations

import importlib.util
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch


MODULE_PATH = Path(__file__).with_name("github-push-broker.py")
SPEC = importlib.util.spec_from_file_location("github_push_broker", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


class GitHubPushBrokerTests(unittest.TestCase):
    def paths(self, root: Path):
        config = root / "config"
        state = root / "state"
        runtime = root / "run"
        return patch.multiple(
            broker,
            CONFIG_DIR=config,
            STATE_DIR=state,
            RUNTIME_DIR=runtime,
            SOCKET_PATH=runtime / "broker.sock",
            INGRESS_DIR=runtime / "ingress",
            AUTHORIZATION=config / "github-push-authorization.json",
            AUTHORIZATION_DIGEST=config / "github-push-authorization.sha256",
            BROKER_TOKEN=config / "github-broker-receipt-token",
            BOARD_TOKEN=config / "operator-board-token",
            APP_CONFIG=config / "github-app.json",
            DATABASE=state / "broker.sqlite3",
            COMMAND_LOCK=state / "command.lock",
            EXPECTED_HERMES_UID=os.getuid(),
            WORKER_UID=os.getuid(),
            WORKER_GID=os.getgid(),
            TEST_MODE=True,
        )

    @staticmethod
    def authorization(run_id: str) -> dict[str, object]:
        return {
            "schemaVersion": "gloops.github-push-authorization.v1",
            "calibrationId": "gate-2.5",
            "campaignId": "controlled-swarm",
            "companyId": "11111111-1111-4111-8111-111111111111",
            "paperclipRunId": run_id,
            "issueId": "22222222-2222-4222-8222-222222222222",
            "agentId": "33333333-3333-4333-8333-333333333333",
            "projectId": "44444444-4444-4444-8444-444444444444",
            "projectWorkspaceId": "55555555-5555-4555-8555-555555555555",
            "repositoryId": 1297008772,
            "repositoryFullName": "gloopsAI/gloops-paperclip-plugin",
            "defaultBranch": "main",
            "branchRef": f"refs/heads/paperclip/{run_id}/calibration",
            "deadline": (
                datetime.now(timezone.utc) + timedelta(minutes=30)
            ).isoformat().replace("+00:00", "Z"),
            "mutationClass": "create_one_branch_ref",
            "maxLeases": 1,
            "maxMutations": 1,
            "expectedOldOid": broker.ZERO_OID,
        }

    def install_authorization(self, authorization: dict[str, object]) -> None:
        broker.CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        broker.AUTHORIZATION.write_text(broker.canonical_json(authorization))
        broker.AUTHORIZATION_DIGEST.write_text(
            broker.digest("gloops.github-push-authorization.v1", authorization) + "\n"
        )
        for path in (broker.AUTHORIZATION, broker.AUTHORIZATION_DIGEST):
            os.chmod(path, 0o600)

    def test_root_authorization_is_exact_digest_bound_and_expiring(self):
        run_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            authorization = self.authorization(run_id)
            self.install_authorization(authorization)
            with patch.object(
                broker,
                "read_root_secret",
                side_effect=lambda path, _label: path.read_text().strip(),
            ):
                loaded, recorded = broker.load_authorization()
            self.assertEqual(loaded, authorization)
            self.assertEqual(
                recorded,
                broker.digest("gloops.github-push-authorization.v1", authorization),
            )

            broker.AUTHORIZATION.write_text(
                broker.canonical_json({**authorization, "companyId": "changed"})
            )
            with patch.object(
                broker,
                "read_root_secret",
                side_effect=lambda path, _label: path.read_text().strip(),
            ), self.assertRaisesRegex(broker.BrokerError, "digest does not match"):
                broker.load_authorization()

    def test_repository_verification_allows_governed_non_default_base_branch(self):
        authorization = {
            **self.authorization("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "repositoryId": 1299155335,
            "repositoryFullName": "gloopsAI/paperclip",
            "defaultBranch": "gloops/stable",
        }
        config = {
            "repositoryId": 1299155335,
            "repository": "gloopsAI/paperclip",
        }
        module = Mock()
        module.request_json.return_value = {
            "id": 1299155335,
            "full_name": "gloopsAI/paperclip",
            "default_branch": "master",
        }

        broker.verify_github_repository(module, config, "token", authorization)

        module.request_json.return_value = {
            "id": 1297008772,
            "full_name": "gloopsAI/gloops-paperclip-plugin",
            "default_branch": "master",
        }
        with self.assertRaisesRegex(broker.BrokerError, "metadata conflicts"):
            broker.verify_github_repository(module, config, "token", authorization)

    def test_allocation_is_durable_single_use_and_journal_is_hash_chained(self):
        run_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        authorization = self.authorization(run_id)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _, _ = broker.create_lease(
                connection, authorization, authorization_digest, "c" * 40
            )
            broker.verify_journal(connection)
            with self.assertRaisesRegex(broker.BrokerError, "already consumed"):
                broker.create_lease(
                    connection, authorization, authorization_digest, "d" * 40
                )

            connection.execute(
                "UPDATE journal SET payload_json = ? WHERE nonce = ?",
                (json.dumps({"tampered": True}), lease["nonce"]),
            )
            connection.commit()
            with self.assertRaisesRegex(broker.BrokerError, "hash chain is invalid"):
                broker.verify_journal(connection)
            connection.close()

    def test_quiescent_precondition_rejects_unresolved_broker_work(self):
        run_id = "abababab-abab-4bab-8bab-abababababab"
        authorization = self.authorization(run_id)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            broker.assert_quiescent(connection)
            broker.create_lease(
                connection, authorization, authorization_digest, "c" * 40
            )
            with self.assertRaisesRegex(broker.BrokerError, "not quiescent"):
                broker.assert_quiescent(connection)
            connection.close()

    def test_paperclip_facts_must_match_every_authorized_identity(self):
        run_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        authorization = self.authorization(run_id)
        context = {
            "schemaVersion": "gloops.repository-mutation-context.v1",
            "heartbeatRunId": run_id,
            "runStatus": "running",
            "companyId": authorization["companyId"],
            "agentId": authorization["agentId"],
            "issueId": authorization["issueId"],
            "issueStatus": "in_progress",
            "projectId": authorization["projectId"],
            "projectWorkspaceId": authorization["projectWorkspaceId"],
            "repositoryFullName": authorization["repositoryFullName"],
            "configuredDefaultBranch": authorization["defaultBranch"],
            "configuredRepositoryRef": "main",
        }
        broker.compare_work_facts(authorization, context)
        with self.assertRaisesRegex(broker.BrokerError, "work facts conflict"):
            broker.compare_work_facts(
                authorization,
                {**context, "agentId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd"},
            )

    def test_bundle_import_rejects_symlink_and_digest_drift(self):
        run_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.INGRESS_DIR.mkdir(parents=True)
            work = Path(directory) / "work"
            work.mkdir()
            pack = broker.INGRESS_DIR / f"{run_id}-{'a' * 32}.pack"
            pack.write_bytes(b"PACK")
            manifest_name = f"{run_id}-{'a' * 32}.json"
            manifest = {
                "schemaVersion": "gloops.github-push-bundle.v1",
                "heartbeatRunId": run_id,
                "expectedNewOid": "e" * 40,
                "objectCount": 1,
                "objectOids": ["e" * 40],
                "packBytes": 4,
                "packName": pack.name,
                "packSha256": "sha256:" + broker.hashlib.sha256(b"PACK").hexdigest(),
            }
            manifest_path = broker.INGRESS_DIR / manifest_name
            manifest_path.write_text(broker.canonical_json(manifest))
            request = {
                "schemaVersion": "gloops.github-push-client-request.v1",
                "heartbeatRunId": run_id,
                "expectedNewOid": "e" * 40,
                "manifestName": manifest_name,
            }
            imported, copied = broker.read_bundle(request, work)
            self.assertEqual(imported, manifest)
            self.assertEqual(copied.read_bytes(), b"PACK")

            pack.unlink()
            pack.symlink_to(Path(directory) / "outside.pack")
            with self.assertRaises((broker.BrokerError, FileNotFoundError)):
                broker.read_bundle(request, work)

    def test_socket_peer_wrong_uid_is_rejected_before_container_inspection(self):
        with patch.object(broker, "TEST_MODE", False), \
                patch.object(
                    broker,
                    "read_peer_credentials",
                    return_value=(1234, broker.EXPECTED_HERMES_UID + 1, 10000),
                ), \
                patch.object(broker.subprocess, "run") as inspect:
            with self.assertRaisesRegex(broker.BrokerError, "fixed Hermes identity"):
                broker.verify_peer(Mock())
        inspect.assert_not_called()

    def test_socket_peer_command_requires_exact_installed_client_argv(self):
        self.assertIsNone(broker.verify_peer_command(
            "/usr/bin/node",
            b"node\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0",
        ))
        run_id = "11111111-1111-4111-8111-111111111111"
        self.assertEqual(
            broker.verify_peer_command(
                "/usr/bin/node",
                (
                    b"node\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0"
                    b"--run-id\0" + run_id.encode() + b"\0"
                ),
            ),
            run_id,
        )
        for command in (
            b"node\0-e\0malicious()\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0",
            b"node\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0--run-id\0spoof\0",
            b"node\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0--run-id\0",
            (
                b"node\0/opt/data/bin/github-push-tool.bundle.cjs\0client\0"
                b"--run-id\0" + run_id.encode() + b"\0extra\0"
            ),
            b"node\0/tmp/github-push-tool.bundle.cjs\0client\0",
        ):
            with self.assertRaises(broker.BrokerError):
                broker.verify_peer_command("/usr/bin/node", command)

        broker.verify_peer_request_run_id(run_id, {"heartbeatRunId": run_id})
        with self.assertRaisesRegex(broker.BrokerError, "conflicts with the bounded request"):
            broker.verify_peer_request_run_id(
                run_id,
                {"heartbeatRunId": "22222222-2222-4222-8222-222222222222"},
            )

    def test_worker_area_is_ephemeral_traversable_and_not_broker_state(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            broker.RUNTIME_DIR.mkdir(mode=0o755)
            broker.STATE_DIR.mkdir(mode=0o700)
            work_dir = broker.create_worker_area()

            self.assertEqual(work_dir.parent, broker.RUNTIME_DIR / "work")
            self.assertNotEqual(broker.STATE_DIR, work_dir.parents[1])
            self.assertEqual(work_dir.stat().st_mode & 0o777, 0o711)
            self.assertEqual(work_dir.parent.stat().st_mode & 0o777, 0o711)

            request_path = work_dir / "worker-request.json"
            pack_path = work_dir / "input.pack"
            request_path.write_text("{}\n")
            pack_path.write_text("pack\n")
            os.chmod(request_path, 0o444)
            os.chmod(pack_path, 0o444)
            self.assertEqual(request_path.stat().st_mode & 0o777, 0o444)
            self.assertEqual(pack_path.stat().st_mode & 0o777, 0o444)
            self.assertEqual(request_path.stat().st_uid, os.getuid())
            self.assertEqual(pack_path.stat().st_uid, os.getuid())

    def test_worker_unit_binds_only_read_only_inputs_and_writable_object_area(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_path = root / "worker-request.json"
            pack_path = root / "input.pack"
            gitdir = root / "repo.git"
            request_path.write_text(json.dumps({"expectedNewOid": "a" * 40}))
            pack_path.write_bytes(b"pack")
            gitdir.mkdir()
            token_fd = os.open(root / "token", os.O_CREAT | os.O_RDWR, 0o600)
            completed = Mock(
                returncode=0,
                stdout=json.dumps({"ok": True, "expectedNewOid": "a" * 40}) + "\n",
                stderr="",
            )
            with patch.object(broker, "sealed_token_fd", return_value=token_fd), \
                    patch.object(broker.subprocess, "run", return_value=completed) as run:
                broker.run_worker(
                    "b" * 32,
                    request_path,
                    pack_path,
                    gitdir,
                    "ghs_ephemeral",
                )
            command = run.call_args.args[0]
            self.assertIn(f"--property=ReadOnlyPaths={request_path}", command)
            self.assertIn(f"--property=ReadOnlyPaths={pack_path}", command)
            self.assertIn(f"--property=ReadWritePaths={gitdir}", command)
            self.assertIn("--property=User=paperclip-git-worker", command)
            self.assertIn("worker", command)
            self.assertTrue(
                any(value.startswith("--property=LoadCredential=github-token:") for value in command)
            )

    def test_validation_worker_has_no_credential_or_network_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            request_path = root / "worker-request.json"
            pack_path = root / "input.pack"
            gitdir = root / "repo.git"
            request_path.write_text(json.dumps({"expectedNewOid": "a" * 40}))
            pack_path.write_bytes(b"pack")
            gitdir.mkdir()
            completed = Mock(
                returncode=0,
                stdout=json.dumps({"ok": True, "expectedNewOid": "a" * 40}) + "\n",
                stderr="",
            )
            with patch.object(broker, "sealed_token_fd") as seal, \
                    patch.object(broker.subprocess, "run", return_value=completed) as run:
                broker.run_worker(
                    "c" * 32,
                    request_path,
                    pack_path,
                    gitdir,
                    None,
                    "validate",
                )
            seal.assert_not_called()
            command = run.call_args.args[0]
            self.assertIn("--property=RestrictAddressFamilies=AF_UNIX", command)
            self.assertFalse(any("LoadCredential" in value for value in command))
            self.assertIn("validate", command)

    def test_recovery_after_in_flight_only_reconciles_and_never_runs_worker(self):
        run_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
        authorization = self.authorization(run_id)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _, prepared = broker.create_lease(
                connection, authorization, authorization_digest, "f" * 40
            )
            broker.mark_posted(connection, lease["nonce"], "prepared_posted")
            broker.transition(
                connection,
                lease["nonce"],
                "prepared",
                "token_minted",
                {},
                token_expires_at="2000-01-01T00:00:00Z",
            )
            broker.transition(
                connection,
                lease["nonce"],
                "token_minted",
                "in_flight",
                {},
            )

            class FakeModule:
                @staticmethod
                def load_config():
                    return {"repository": authorization["repositoryFullName"]}

                @staticmethod
                def mint(_config, permissions):
                    self.assertEqual(permissions, {"contents": "read"})
                    return "ghs_reconcile_only", "2099-01-01T00:00:00Z", {
                        "contents": "read",
                        "metadata": "read",
                    }

                @staticmethod
                def revoke_value(_token):
                    return None

            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "verify_github_repository") as verify_repository, \
                    patch.object(broker, "read_remote_ref", return_value="f" * 40), \
                    patch.object(broker, "paperclip_request", return_value={}) as request, \
                    patch.object(broker, "run_worker") as worker:
                broker.reconcile_pending(connection)
            worker.assert_not_called()
            verify_repository.assert_called_once()
            self.assertTrue(
                any(
                    call.args[0] == "POST"
                    and call.args[2]["state"] == "reconciled_success"
                    for call in request.call_args_list
                )
            )
            state = connection.execute(
                "SELECT state FROM leases WHERE nonce = ?", (lease["nonce"],)
            ).fetchone()["state"]
            self.assertEqual(state, "reconciled_success")
            self.assertEqual(
                broker.completed_response(
                    connection,
                    {
                        "heartbeatRunId": run_id,
                        "expectedNewOid": "f" * 40,
                    },
                ),
                {
                    "ok": True,
                    "schemaVersion": "gloops.github-push-client-response.v1",
                    "heartbeatRunId": run_id,
                    "branchRef": authorization["branchRef"],
                    "remoteNewOid": "f" * 40,
                    "brokerReceiptDigest": request.call_args_list[-1].args[2][
                        "brokerReceiptDigest"
                    ],
                },
            )
            connection.close()

    def test_recovery_persists_terminal_state_while_paperclip_is_unavailable(self):
        run_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        authorization = self.authorization(run_id)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _, prepared = broker.create_lease(
                connection, authorization, authorization_digest, "e" * 40
            )
            broker.mark_posted(connection, lease["nonce"], "prepared_posted")
            broker.transition(
                connection,
                lease["nonce"],
                "prepared",
                "token_minted",
                {},
                token_expires_at="2000-01-01T00:00:00Z",
            )

            class FakeModule:
                pass

            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(
                        broker,
                        "paperclip_request",
                        side_effect=broker.BrokerError("Paperclip unavailable"),
                    ):
                broker.reconcile_pending(connection)

            row = connection.execute(
                """
                SELECT state, terminal_receipt_json, terminal_posted
                FROM leases WHERE nonce = ?
                """,
                (lease["nonce"],),
            ).fetchone()
            self.assertEqual(row["state"], "bounded_failure")
            self.assertIsNotNone(row["terminal_receipt_json"])
            self.assertEqual(row["terminal_posted"], 0)
            self.assertIsNone(
                broker.completed_response(
                    connection,
                    {
                        "heartbeatRunId": run_id,
                        "expectedNewOid": "e" * 40,
                    },
                )
            )
            self.assertEqual(broker.reconciliation_delay(connection), 15.0)
            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "paperclip_request", return_value={}):
                broker.reconcile_pending(connection)
            self.assertEqual(
                connection.execute(
                    "SELECT terminal_posted FROM leases WHERE nonce = ?",
                    (lease["nonce"],),
                ).fetchone()["terminal_posted"],
                1,
            )
            connection.close()

    def test_root_authorization_accepts_only_exact_draft_pull_request_field(self):
        run_id = "12121212-1212-4121-8121-121212121212"
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            authorization = self.authorization(run_id)
            authorization["draftPullRequest"] = {
                "base": "main",
                "titlePrefix": "feat(gym): leased calibration",
            }
            self.install_authorization(authorization)
            with patch.object(
                broker,
                "read_root_secret",
                side_effect=lambda path, _label: path.read_text().strip(),
            ):
                loaded, _digest = broker.load_authorization()
            self.assertEqual(loaded, authorization)

            for malformed in (
                {"base": "release", "titlePrefix": "feat(gym): leased calibration"},
                {"base": "main"},
                {"base": "main", "titlePrefix": "feat", "extra": True},
                {"base": "main", "titlePrefix": "bad\ntitle"},
                {"base": "main", "titlePrefix": ""},
                "main",
            ):
                authorization["draftPullRequest"] = malformed
                self.install_authorization(authorization)
                with patch.object(
                    broker,
                    "read_root_secret",
                    side_effect=lambda path, _label: path.read_text().strip(),
                ), self.assertRaises(broker.BrokerError):
                    broker.load_authorization()

    def test_terminal_receipt_binds_optional_draft_pull_request_evidence(self):
        prepared = {"state": "prepared", "nonce": "a" * 64}
        push_only = broker.terminal_receipt(prepared, "reconciled_success", "0" * 40, "b" * 40)
        self.assertNotIn("draftPullRequest", push_only)
        record = {
            "disposition": "created",
            "prNumber": 7,
            "prUrl": "https://github.com/gloopsAI/paperclip-gym/pull/7",
        }
        receipt = broker.terminal_receipt(prepared, "reconciled_success", "0" * 40, "b" * 40, record)
        self.assertEqual(receipt["draftPullRequest"], record)
        projection = {key: value for key, value in receipt.items() if key != "brokerReceiptDigest"}
        self.assertEqual(
            receipt["brokerReceiptDigest"],
            broker.digest("gloops.github-push-terminal-receipt.v1", projection),
        )

    def draft_pr_fixture(self, run_id: str, number: int = 12) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
        authorization = self.authorization(run_id)
        authorization["draftPullRequest"] = {
            "base": "main",
            "titlePrefix": "feat(gym): leased calibration",
        }
        pull_request = {
            "number": number,
            "html_url": f"https://github.com/{authorization['repositoryFullName']}/pull/{number}",
            "draft": True,
            "head": {"ref": f"paperclip/{run_id}/calibration"},
            "base": {"ref": "main"},
        }
        lease = {
            "nonce": "e" * 64,
            "rootAuthorizationDigest": broker.digest(
                "gloops.github-push-authorization.v1", authorization
            ),
        }
        return authorization, pull_request, lease

    @staticmethod
    def reconciling_lease(
        connection,
        authorization: dict[str, object],
        expected_new_oid: str,
        push_token_expires_at: str = "2000-01-01T00:00:00Z",
    ) -> tuple[dict[str, object], dict[str, object]]:
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        lease, _, prepared = broker.create_lease(
            connection, authorization, authorization_digest, expected_new_oid
        )
        broker.mark_posted(connection, lease["nonce"], "prepared_posted")
        broker.transition(
            connection,
            lease["nonce"],
            "prepared",
            "token_minted",
            {},
            token_expires_at=push_token_expires_at,
        )
        broker.transition(connection, lease["nonce"], "token_minted", "in_flight", {})
        broker.transition(connection, lease["nonce"], "in_flight", "reconciling", {})
        return lease, prepared

    def test_draft_pr_step_mints_scoped_token_and_posts_exactly_once(self):
        run_id = "13131313-1313-4131-8131-131313131313"
        authorization, pull_request, lease = self.draft_pr_fixture(run_id)
        test = self
        calls: list[tuple[str, str, object]] = []
        revoked: list[str] = []

        class FakeModule:
            class GitHubAPIError(Exception):
                def __init__(self, status: int):
                    self.status = status

            class CredentialError(Exception):
                pass

            @staticmethod
            def mint(_config, permissions):
                test.assertEqual(permissions, {"contents": "read", "pull_requests": "write"})
                return "ghs_draft_pr", "2099-01-01T00:00:00Z", {}

            @staticmethod
            def request_json(method, path, token, body=None):
                test.assertEqual(token, "ghs_draft_pr")
                calls.append((method, path, body))
                return pull_request

            @staticmethod
            def revoke_value(token):
                revoked.append(token)

        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _prepared = self.reconciling_lease(connection, authorization, "c" * 40)
            record = broker.execute_draft_pull_request(
                connection,
                FakeModule,
                {},
                authorization,
                lease,
                authorization["draftPullRequest"],
            )
            self.assertEqual(record, {
                "disposition": "created",
                "prNumber": pull_request["number"],
                "prUrl": pull_request["html_url"],
            })
            self.assertEqual(len(calls), 1)
            method, path, body = calls[0]
            self.assertEqual(method, "POST")
            self.assertEqual(path, f"/repos/{authorization['repositoryFullName']}/pulls")
            self.assertEqual(body["draft"], True)
            self.assertEqual(body["head"], f"paperclip/{run_id}/calibration")
            self.assertEqual(body["base"], "main")
            self.assertEqual(body["title"], f"feat(gym): leased calibration {run_id}")
            self.assertIn(lease["rootAuthorizationDigest"], body["body"])
            self.assertEqual(revoked, ["ghs_draft_pr"])
            # The draft-PR mint re-armed the conservative recovery envelope.
            self.assertEqual(
                connection.execute(
                    "SELECT token_expires_at FROM leases WHERE nonce = ?",
                    (lease["nonce"],),
                ).fetchone()["token_expires_at"],
                "2099-01-01T00:00:00Z",
            )
            broker.verify_journal(connection)
            events = [
                json.loads(row["payload_json"]).get("event")
                for row in connection.execute("SELECT * FROM journal ORDER BY sequence")
            ]
            self.assertEqual(
                [event for event in events if event],
                ["draft_pr_intent", "draft_pr_reconciled"],
            )
            connection.close()

    def test_draft_pr_ambiguity_is_resolved_by_listing_and_never_reposted(self):
        run_id = "14141414-1414-4141-8141-141414141414"
        for listed, expected in (
            (True, "created"),
            (False, "none"),
        ):
            authorization, pull_request, lease = self.draft_pr_fixture(run_id)
            test = self
            posts: list[str] = []
            lists: list[str] = []

            class FakeModule:
                class GitHubAPIError(Exception):
                    def __init__(self, status: int):
                        self.status = status

                class CredentialError(Exception):
                    pass

                @staticmethod
                def mint(_config, permissions):
                    test.assertEqual(permissions, {"contents": "read", "pull_requests": "write"})
                    return "ghs_draft_pr", "2099-01-01T00:00:00Z", {}

                @staticmethod
                def request_json(method, path, _token, body=None):
                    if method == "POST":
                        posts.append(path)
                        raise FakeModule.GitHubAPIError(502)
                    test.assertEqual(method, "GET")
                    test.assertIn("head=gloopsAI%3Apaperclip%2F", path)
                    test.assertIn("base=main", path)
                    lists.append(path)
                    return [pull_request] if listed else []

                @staticmethod
                def revoke_value(_token):
                    return None

            with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
                connection = broker.connect_database()
                lease, _prepared = self.reconciling_lease(connection, authorization, "c" * 40)
                record = broker.execute_draft_pull_request(
                    connection,
                    FakeModule,
                    {},
                    authorization,
                    lease,
                    authorization["draftPullRequest"],
                )
                self.assertEqual(record["disposition"], expected)
                self.assertEqual(len(posts), 1)
                self.assertEqual(len(lists), 1)
                connection.close()

    def test_recovery_observes_draft_pr_by_listing_only(self):
        run_id = "15151515-1515-4151-8151-151515151515"
        authorization, pull_request, _fixture_lease = self.draft_pr_fixture(run_id, 9)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        test = self
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _, prepared = broker.create_lease(
                connection, authorization, authorization_digest, "f" * 40
            )
            broker.mark_posted(connection, lease["nonce"], "prepared_posted")
            broker.transition(
                connection,
                lease["nonce"],
                "prepared",
                "token_minted",
                {},
                token_expires_at="2000-01-01T00:00:00Z",
            )
            broker.transition(connection, lease["nonce"], "token_minted", "in_flight", {})

            mints: list[dict[str, str]] = []
            requests: list[str] = []

            class FakeModule:
                class GitHubAPIError(Exception):
                    def __init__(self, status: int):
                        self.status = status

                class CredentialError(Exception):
                    pass

                @staticmethod
                def load_config():
                    return {"repository": authorization["repositoryFullName"]}

                @staticmethod
                def mint(_config, permissions):
                    mints.append(permissions)
                    return "ghs_reconcile_only", "2099-01-01T00:00:00Z", {}

                @staticmethod
                def request_json(method, path, _token, body=None):
                    test.assertEqual(method, "GET")
                    requests.append(path)
                    return [pull_request]

                @staticmethod
                def revoke_value(_token):
                    return None

            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "verify_github_repository"), \
                    patch.object(broker, "read_remote_ref", return_value="f" * 40), \
                    patch.object(broker, "paperclip_request", return_value={}), \
                    patch.object(broker, "run_worker") as worker:
                broker.reconcile_pending(connection)
            worker.assert_not_called()
            self.assertEqual(mints, [{"contents": "read"}, {"pull_requests": "read"}])
            self.assertEqual(len(requests), 1)
            row = connection.execute(
                "SELECT state, terminal_receipt_json FROM leases WHERE nonce = ?",
                (lease["nonce"],),
            ).fetchone()
            self.assertEqual(row["state"], "reconciled_success")
            receipt = json.loads(row["terminal_receipt_json"])
            self.assertEqual(receipt["draftPullRequest"], {
                "disposition": "created",
                "prNumber": 9,
                "prUrl": pull_request["html_url"],
            })
            connection.close()

    def test_recovery_waits_for_the_draft_pr_token_envelope(self):
        run_id = "16161616-1616-4161-8161-161616161616"
        authorization, pull_request, _fixture_lease = self.draft_pr_fixture(run_id, 21)
        test = self
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            authorization_digest = broker.digest(
                "gloops.github-push-authorization.v1", authorization
            )
            lease, _, _prepared = broker.create_lease(
                connection, authorization, authorization_digest, "f" * 40
            )
            broker.mark_posted(connection, lease["nonce"], "prepared_posted")
            future = (
                datetime.now(timezone.utc) + timedelta(minutes=50)
            ).isoformat().replace("+00:00", "Z")
            # The envelope is bound to the reconciling state only.
            with self.assertRaisesRegex(broker.BrokerError, "no reconciling lease"):
                broker.record_draft_pr_envelope(
                    connection, lease["nonce"], future, {"event": "draft_pr_intent"}
                )
            broker.transition(
                connection,
                lease["nonce"],
                "prepared",
                "token_minted",
                {},
                token_expires_at="2000-01-01T00:00:00Z",
            )
            broker.transition(connection, lease["nonce"], "token_minted", "in_flight", {})
            broker.transition(connection, lease["nonce"], "in_flight", "reconciling", {})
            broker.record_draft_pr_envelope(
                connection,
                lease["nonce"],
                future,
                {"event": "draft_pr_intent", "tokenExpiresAt": future},
            )
            # The envelope is the LATER of push-token and draft-PR-token
            # expiries; an older value never shrinks it.
            broker.record_draft_pr_envelope(
                connection,
                lease["nonce"],
                "2000-01-03T00:00:00Z",
                {"event": "draft_pr_intent", "tokenExpiresAt": "2000-01-03T00:00:00Z"},
            )
            self.assertEqual(
                connection.execute(
                    "SELECT token_expires_at FROM leases WHERE nonce = ?",
                    (lease["nonce"],),
                ).fetchone()["token_expires_at"],
                future,
            )
            broker.verify_journal(connection)

            mints: list[dict[str, str]] = []
            requests: list[str] = []

            class FakeModule:
                class GitHubAPIError(Exception):
                    def __init__(self, status: int):
                        self.status = status

                class CredentialError(Exception):
                    pass

                @staticmethod
                def load_config():
                    return {"repository": authorization["repositoryFullName"]}

                @staticmethod
                def mint(_config, permissions):
                    mints.append(permissions)
                    return "ghs_reconcile_only", "2099-01-01T00:00:00Z", {}

                @staticmethod
                def request_json(method, path, _token, body=None):
                    test.assertEqual(method, "GET")
                    requests.append(path)
                    return [pull_request]

                @staticmethod
                def revoke_value(_token):
                    return None

            # While the draft-PR token may still be live at GitHub, recovery
            # must refuse to observe-and-finalize: a crashed create attempt
            # could still land and contradict a premature pr:none receipt.
            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "verify_github_repository"), \
                    patch.object(broker, "read_remote_ref", return_value="f" * 40), \
                    patch.object(broker, "paperclip_request", return_value={}), \
                    patch.object(broker, "run_worker") as worker:
                broker.reconcile_pending(connection)
            worker.assert_not_called()
            self.assertEqual(mints, [])
            self.assertEqual(requests, [])
            row = connection.execute(
                "SELECT state, terminal_receipt_json FROM leases WHERE nonce = ?",
                (lease["nonce"],),
            ).fetchone()
            self.assertEqual(row["state"], "reconciling")
            self.assertIsNone(row["terminal_receipt_json"])
            delay = broker.reconciliation_delay(connection)
            self.assertIsNotNone(delay)
            self.assertGreater(delay, 60 * 40)

            # Once the draft-PR envelope has passed, the same recovery pass
            # observes by listing and finalizes with the found draft PR.
            connection.execute(
                "UPDATE leases SET token_expires_at = ? WHERE nonce = ?",
                ("2000-01-02T00:00:00Z", lease["nonce"]),
            )
            connection.commit()
            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "verify_github_repository"), \
                    patch.object(broker, "read_remote_ref", return_value="f" * 40), \
                    patch.object(broker, "paperclip_request", return_value={}), \
                    patch.object(broker, "run_worker") as worker:
                broker.reconcile_pending(connection)
            worker.assert_not_called()
            self.assertEqual(mints, [{"contents": "read"}, {"pull_requests": "read"}])
            self.assertEqual(len(requests), 1)
            row = connection.execute(
                "SELECT state, terminal_receipt_json FROM leases WHERE nonce = ?",
                (lease["nonce"],),
            ).fetchone()
            self.assertEqual(row["state"], "reconciled_success")
            self.assertEqual(
                json.loads(row["terminal_receipt_json"])["draftPullRequest"],
                {
                    "disposition": "created",
                    "prNumber": 21,
                    "prUrl": pull_request["html_url"],
                },
            )
            connection.close()

    def test_broker_database_has_no_token_storage_column_or_token_artifact(self):
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(leases)").fetchall()
            }
            self.assertNotIn("token_path", columns)
            self.assertFalse((broker.STATE_DIR / "tokens").exists())
            connection.close()

    def test_uncertain_token_mint_holds_until_expiry_without_releasing_allocation(self):
        run_id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
        authorization = self.authorization(run_id)
        authorization_digest = broker.digest(
            "gloops.github-push-authorization.v1", authorization
        )
        with tempfile.TemporaryDirectory() as directory, self.paths(Path(directory)):
            connection = broker.connect_database()
            lease, _, _ = broker.create_lease(
                connection, authorization, authorization_digest, "a" * 40
            )
            broker.mark_posted(connection, lease["nonce"], "prepared_posted")
            broker.record_mint_intent(connection, lease["nonce"])

            class FakeModule:
                pass

            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "paperclip_request", return_value={}):
                broker.reconcile_pending(connection)
            state = connection.execute(
                "SELECT state FROM leases WHERE nonce = ?", (lease["nonce"],)
            ).fetchone()["state"]
            self.assertEqual(state, "prepared")
            self.assertGreater(broker.reconciliation_delay(connection), 60 * 60)

            connection.execute(
                "UPDATE leases SET mint_safe_after = ? WHERE nonce = ?",
                ("2000-01-01T00:00:00Z", lease["nonce"]),
            )
            connection.commit()
            with patch.object(broker, "load_app_module", return_value=FakeModule), \
                    patch.object(broker, "paperclip_request", return_value={}):
                broker.reconcile_pending(connection)
            state = connection.execute(
                "SELECT state FROM leases WHERE nonce = ?", (lease["nonce"],)
            ).fetchone()["state"]
            self.assertEqual(state, "bounded_failure")
            connection.close()


if __name__ == "__main__":
    unittest.main()
