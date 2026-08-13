import importlib.util
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("durable_buzz_roster", HERE / "durable_buzz_roster.py")
module = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = module
SPEC.loader.exec_module(module)


def agents(status="idle"):
    routes = module.load_manifest(HERE / "durable-buzz-roster.json")
    return [{"id": route["paperclipAgentId"], "name": name, "status": status if name == "Wren" else "idle", "adapterType": "hermes_gateway", "adapterConfig": {"instructions": name}} for name, route in routes.items()]


class FakeApi:
    def __init__(self, rows, fail_name=None):
        self.rows = rows
        self.fail_name = fail_name
        self.calls = []
    def agents(self): return self.rows
    def patch(self, agent_id, adapter_type, adapter_config, replace):
        self.calls.append((agent_id, adapter_type, adapter_config, replace))
        failed_id = None if self.fail_name is None else module.load_manifest(HERE / "durable-buzz-roster.json")[self.fail_name]["paperclipAgentId"]
        if agent_id == failed_id and adapter_type == "codex_local": raise module.RosterError("injected")
        for row in self.rows:
            if row["id"] == agent_id:
                row["adapterType"] = adapter_type
                row["adapterConfig"] = adapter_config
        return {"id": agent_id, "adapterType": adapter_type, "adapterConfig": adapter_config}


class DurableRosterTest(unittest.TestCase):
    def setUp(self): self.routes = module.load_manifest(HERE / "durable-buzz-roster.json")
    def test_exact_durable_mapping(self):
        plan = module.plan(agents(), self.routes)
        self.assertEqual(len(plan), 8)
        self.assertEqual({entry["to"]["adapterConfig"]["model"] for entry in plan}, {"gpt-5.6-luna", "gpt-5.6-terra"})
    def test_refuses_running_target(self):
        with self.assertRaises(module.RosterError): module.plan(agents("running"), self.routes)
    def test_refuses_name_match_with_wrong_paperclip_identity(self):
        rows = agents(); rows[0]["id"] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaises(module.RosterError): module.plan(rows, self.routes)
    def test_apply_receipts_and_never_persists_token(self):
        api = FakeApi(agents())
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "receipt.json"
            receipt = module.apply(api, self.routes, path)
            self.assertEqual(receipt["status"], "completed")
            self.assertNotIn("token", path.read_text().lower())
            self.assertEqual(len(api.calls), 8)
    def test_failure_rolls_back_in_reverse(self):
        api = FakeApi(agents(), fail_name="Mason")
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "receipt.json"
            with self.assertRaises(module.RosterError): module.apply(api, self.routes, path)
            self.assertEqual(__import__("json").loads(path.read_text())["status"], "rolled_back")
            rollback_calls = [call for call in api.calls if call[3] is True]
            self.assertTrue(rollback_calls)
    def test_crash_recovery_uses_live_state_not_applied_hint(self):
        rows = agents(); api = FakeApi(rows)
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td) / "receipt.json"
            changes = module.plan(rows, self.routes)
            targets = []
            for change in changes:
                prior = next(row for row in rows if row["id"] == change["agentId"])
                config = dict(prior["adapterConfig"])
                targets.append({"name": change["name"], "agentId": change["agentId"], "desired": change["to"], "prior": {"adapterType": prior["adapterType"], "adapterConfig": config, "adapterConfigSha256": module.digest(config)}})
            receipt = {"schemaVersion": module.RECEIPT_SCHEMA, "status": "initiated", "targets": targets, "applied": []}
            module.durable_create(path, receipt)
            first = targets[0]
            api.patch(first["agentId"], "codex_local", first["desired"]["adapterConfig"], False)
            result = module.recover(api, path)
            self.assertEqual(result["status"], "rolled_back")
            self.assertEqual(next(row for row in rows if row["id"] == first["agentId"])["adapterType"], "hermes_gateway")


if __name__ == "__main__": unittest.main()
