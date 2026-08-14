import importlib.util
import io
import json
import os
import pathlib
import stat
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

MODULE_PATH = pathlib.Path(__file__).with_name("github-webhook-receiver-deploy.py")
SPEC = importlib.util.spec_from_file_location("github_webhook_receiver_deploy", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)

CURRENT = b'''{
\tadmin off
}

hermes.gloops.ai {
\tbind 157.230.55.208

\tlog {
\t\toutput file /var/log/caddy/hermes-dashboard-public-access.log
\t}

\tbasicauth /* {
\t\thermes $2a$14$example
\t}

\treverse_proxy 127.0.0.1:3100 {
\t\theader_up Host {host}
\t\theader_up -Origin
\t}
}
'''

ROUTE = b'''# BEGIN GLOOPS PAPERCLIP GITHUB WEBHOOK
\t@paperclip_github_webhook path /github-webhooks/paperclip-check-suite
\thandle @paperclip_github_webhook {
\t\treverse_proxy 127.0.0.1:8766
\t}
# END GLOOPS PAPERCLIP GITHUB WEBHOOK
'''


class DeployTest(unittest.TestCase):
    @staticmethod
    def inactive_subprocess(command, **_kwargs):
        return mock.Mock(returncode=1 if command[1] == "is-active" else 0)

    def deployment_fixture(self, root: pathlib.Path):
        receiver = root / "installed" / "receiver.py"
        unit = root / "installed" / "receiver.service"
        secret = root / "installed" / "secret"
        caddy = root / "installed" / "Caddyfile"
        transactions = root / "transactions"
        sources = root / "sources"
        for directory in (receiver.parent, transactions, sources):
            directory.mkdir(parents=True, exist_ok=True)
        caddy.write_bytes(CURRENT)
        receiver_source = sources / "receiver.py"
        unit_source = sources / "receiver.service"
        route_source = sources / "route.txt"
        receiver_source.write_text("print('receiver')\n")
        unit_source.write_text(
            "[Service]\nExecStart=/receiver\n"
            "Environment=PAPERCLIP_PLUGIN_WEBHOOK_URL=http://127.0.0.1:3100/api/plugins/"
            "__PAPERCLIP_PLUGIN_ID__/webhooks/github-checks\n"
        )
        route_source.write_bytes(ROUTE)
        args = SimpleNamespace(
            transaction_id="tx-20260814T120000Z-test",
            receiver_source=str(receiver_source),
            unit_source=str(unit_source),
            route_source=str(route_source),
            plugin_id="eeb2d7a2-298e-4a59-8ee5-ca8b16de4bd4",
        )
        patches = mock.patch.multiple(
            MODULE,
            ROOT=transactions,
            RECEIVER=receiver,
            UNIT=unit,
            SECRET=secret,
            CADDY=caddy,
        )
        return args, patches, receiver, unit, secret, caddy, transactions

    def test_caddy_patch_adds_one_public_route_and_wraps_existing_auth(self):
        result = MODULE.patch_caddy(CURRENT, ROUTE).decode()
        self.assertEqual(result.count(MODULE.MARKER), 1)
        self.assertIn("handle @paperclip_github_webhook", result)
        self.assertIn("\thandle {\n\t\tbasicauth /*", result)
        self.assertIn("\t\treverse_proxy 127.0.0.1:3100", result)
        self.assertNotIn("github_webhook_hmac", result)

    def test_caddy_patch_rejects_reapply_and_unknown_shapes(self):
        patched = MODULE.patch_caddy(CURRENT, ROUTE)
        with self.assertRaisesRegex(RuntimeError, "already exists"):
            MODULE.patch_caddy(patched, ROUTE)
        with self.assertRaisesRegex(RuntimeError, "site not found"):
            MODULE.patch_caddy(b"example.com {}\n", ROUTE)
        with self.assertRaisesRegex(RuntimeError, "protection block"):
            MODULE.patch_caddy(CURRENT.replace(b"basicauth", b"removed"), ROUTE)
        with self.assertRaisesRegex(RuntimeError, "upstream not found"):
            MODULE.patch_caddy(CURRENT.replace(b"127.0.0.1:3100", b"127.0.0.1:9999"), ROUTE)

    def test_snapshot_restore_preserves_bytes_and_mode(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root, "artifact")
            path.write_bytes(b"prior")
            path.chmod(0o640)
            entry = MODULE.snapshot(path)
            path.write_bytes(b"candidate")
            path.chmod(0o600)
            with mock.patch.object(MODULE, "trusted_root_directory"):
                MODULE.restore(entry)
            self.assertEqual(path.read_bytes(), b"prior")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertEqual(path.stat().st_uid, os.getuid())
            self.assertEqual(path.stat().st_gid, os.getgid())

    def test_absent_snapshot_removes_candidate_and_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root, "artifact")
            entry = MODULE.snapshot(path)
            path.write_bytes(b"candidate")
            MODULE.restore(entry)
            self.assertFalse(path.exists())
            target = pathlib.Path(root, "target")
            target.write_bytes(b"value")
            path.symlink_to(target)
            with self.assertRaisesRegex(RuntimeError, "unsafe snapshot"):
                MODULE.snapshot(path)

    def test_transaction_id_is_bounded(self):
        self.assertTrue(MODULE.re_full_transaction("tx-20260814T120000Z-public-webhook"))
        self.assertFalse(MODULE.re_full_transaction("../escape"))
        self.assertFalse(MODULE.re_full_transaction("tx-20260814T120000Z-UPPER"))

    def test_unit_render_binds_one_valid_provisioned_plugin_id(self):
        template = b"url=/api/plugins/__PAPERCLIP_PLUGIN_ID__/webhooks/github-checks\n"
        plugin_id = "eeb2d7a2-298e-4a59-8ee5-ca8b16de4bd4"
        rendered = MODULE.render_unit(template, plugin_id)
        self.assertEqual(rendered, f"url=/api/plugins/{plugin_id}/webhooks/github-checks\n".encode())
        self.assertNotIn(MODULE.PLUGIN_ID_PLACEHOLDER, rendered)
        with self.assertRaisesRegex(RuntimeError, "plugin id is invalid"):
            MODULE.render_unit(template, "not-a-uuid")
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            MODULE.render_unit(b"url=/api/plugins/no-placeholder\n", plugin_id)

    def test_invalid_plugin_id_fails_before_transaction_or_host_effects(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.deployment_fixture(pathlib.Path(temporary))
            args, patches, receiver, unit, secret, _caddy, transactions = fixture
            args.plugin_id = "not-a-uuid"
            with patches, \
                 mock.patch.object(MODULE, "ensure_root"), \
                 self.assertRaisesRegex(RuntimeError, "plugin id is invalid"):
                MODULE.install(args)
            self.assertEqual(list(transactions.iterdir()), [])
            self.assertFalse(receiver.exists())
            self.assertFalse(unit.exists())
            self.assertFalse(secret.exists())

    def test_network_free_install_and_explicit_rollback_restore_exact_prior_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.deployment_fixture(pathlib.Path(temporary))
            args, patches, receiver, unit, secret, caddy, transactions = fixture
            stdin = io.TextIOWrapper(io.BytesIO(b"s" * 32))
            with patches, \
                 mock.patch.object(MODULE, "ensure_root"), \
                 mock.patch.object(MODULE, "trusted_root_directory"), \
                 mock.patch.object(MODULE, "validate_caddy"), \
                 mock.patch.object(MODULE, "health"), \
                 mock.patch.object(MODULE, "service_state", return_value={"active": False, "enabled": False}), \
                 mock.patch.object(MODULE, "run"), \
                 mock.patch.object(MODULE.subprocess, "run", side_effect=self.inactive_subprocess), \
                 mock.patch.object(MODULE.os, "fchown"), \
                 mock.patch.object(MODULE.sys, "stdin", stdin):
                MODULE.install(args)
                self.assertTrue(receiver.exists())
                self.assertTrue(unit.exists())
                self.assertIn(args.plugin_id.encode(), unit.read_bytes())
                self.assertNotIn(MODULE.PLUGIN_ID_PLACEHOLDER, unit.read_bytes())
                self.assertEqual(secret.read_bytes(), b"s" * 32)
                self.assertIn(MODULE.MARKER.encode(), caddy.read_bytes())
                deployment = json.loads(
                    (transactions / args.transaction_id / "receipt.json").read_text()
                )
                self.assertEqual(deployment["pluginId"], args.plugin_id)
                MODULE.rollback(SimpleNamespace(transaction_id=args.transaction_id))

            self.assertFalse(receiver.exists())
            self.assertFalse(unit.exists())
            self.assertFalse(secret.exists())
            self.assertEqual(caddy.read_bytes(), CURRENT)
            tx = transactions / args.transaction_id
            self.assertEqual(__import__("json").loads((tx / "receipt.json").read_text())["status"], "activated")
            self.assertEqual(__import__("json").loads((tx / "rollback-receipt.json").read_text())["status"], "restored")

    def test_network_free_health_failure_rolls_back_before_reporting(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.deployment_fixture(pathlib.Path(temporary))
            args, patches, receiver, unit, secret, caddy, transactions = fixture
            stdin = io.TextIOWrapper(io.BytesIO(b"s" * 32))
            with patches, \
                 mock.patch.object(MODULE, "ensure_root"), \
                 mock.patch.object(MODULE, "trusted_root_directory"), \
                 mock.patch.object(MODULE, "validate_caddy"), \
                 mock.patch.object(MODULE, "health", side_effect=RuntimeError("injected")), \
                 mock.patch.object(MODULE, "service_state", return_value={"active": False, "enabled": False}), \
                 mock.patch.object(MODULE, "run"), \
                 mock.patch.object(MODULE.subprocess, "run", side_effect=self.inactive_subprocess), \
                 mock.patch.object(MODULE.os, "fchown"), \
                 mock.patch.object(MODULE.sys, "stdin", stdin), \
                 self.assertRaisesRegex(RuntimeError, "rolled_back"):
                MODULE.install(args)

            self.assertFalse(receiver.exists())
            self.assertFalse(unit.exists())
            self.assertFalse(secret.exists())
            self.assertEqual(caddy.read_bytes(), CURRENT)
            receipt = __import__("json").loads(
                (transactions / args.transaction_id / "receipt.json").read_text()
            )
            self.assertEqual(receipt["status"], "rolled_back")
            self.assertEqual(receipt["errorClass"], "RuntimeError")
            self.assertNotIn("injected", str(receipt))

    def test_corrupt_backup_after_durable_claim_writes_failure_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = self.deployment_fixture(pathlib.Path(temporary))
            args, patches, _receiver, _unit, _secret, _caddy, transactions = fixture
            stdin = io.TextIOWrapper(io.BytesIO(b"s" * 32))
            with patches, \
                 mock.patch.object(MODULE, "ensure_root"), \
                 mock.patch.object(MODULE, "trusted_root_directory"), \
                 mock.patch.object(MODULE, "validate_caddy"), \
                 mock.patch.object(MODULE, "health"), \
                 mock.patch.object(MODULE, "service_state", return_value={"active": False, "enabled": False}), \
                 mock.patch.object(MODULE, "run"), \
                 mock.patch.object(MODULE.subprocess, "run", side_effect=self.inactive_subprocess), \
                 mock.patch.object(MODULE.os, "fchown"), \
                 mock.patch.object(MODULE.sys, "stdin", stdin):
                MODULE.install(args)
                tx = transactions / args.transaction_id
                (tx / "backup.json").write_text("{broken", encoding="utf-8")
                with self.assertRaises(json.JSONDecodeError):
                    MODULE.rollback(SimpleNamespace(transaction_id=args.transaction_id))

            self.assertTrue((tx / "rollback-claim.json").exists())
            failure = json.loads((tx / "rollback-failure-receipt.json").read_text())
            self.assertEqual(failure["status"], "rollback_failed")
            self.assertEqual(failure["errorClass"], "JSONDecodeError")
            self.assertFalse((tx / "rollback-receipt.json").exists())


if __name__ == "__main__":
    unittest.main()
