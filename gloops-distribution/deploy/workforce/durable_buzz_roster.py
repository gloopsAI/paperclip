#!/usr/bin/env python3
"""Plan or transactionally apply the Buzz-linked durable Paperclip roster.

No token is accepted on argv or in the environment. Apply mode reads one
opaque bearer token from an already-open file descriptor and never persists or
prints it. Dry-run accepts an agent snapshot and is network-free.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any

SCHEMA = "gloops.durable-buzz-roster@1"
RECEIPT_SCHEMA = "gloops.durable-buzz-roster-receipt@1"


class RosterError(RuntimeError):
    pass


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value: object) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def assert_no_inline_secrets(value: object, path: str = "root") -> None:
    if isinstance(value, list):
        for index, item in enumerate(value): assert_no_inline_secrets(item, f"{path}[{index}]")
        return
    if not isinstance(value, dict): return
    for key, item in value.items():
        lowered = str(key).lower()
        if lowered in {"apikey", "token", "password", "secret"} and isinstance(item, str) and item:
            raise RosterError(f"inline secret-like value refused at {path}.{key}")
        assert_no_inline_secrets(item, f"{path}.{key}")


def load_manifest(path: pathlib.Path) -> dict[str, dict[str, str]]:
    value = json.loads(path.read_text())
    routes = value.get("routes") if isinstance(value, dict) else None
    if value.get("schemaVersion") != SCHEMA or not isinstance(routes, dict) or not routes:
        raise RosterError("durable roster manifest is invalid")
    for name, route in routes.items():
        if not isinstance(name, str) or not name or not isinstance(route, dict):
            raise RosterError("durable roster route is malformed")
        if route.get("model") not in {"gpt-5.6-luna", "gpt-5.6-terra"}:
            raise RosterError(f"durable roster model is invalid for {name}")
        if route.get("reasoning") not in {"medium", "high"}:
            raise RosterError(f"durable roster reasoning is invalid for {name}")
        paperclip_id = route.get("paperclipAgentId")
        try:
            canonical_id = str(uuid.UUID(paperclip_id)) if isinstance(paperclip_id, str) else ""
        except ValueError:
            canonical_id = ""
        if canonical_id != paperclip_id:
            raise RosterError(f"Paperclip identity is invalid for {name}")
        if not isinstance(route.get("buzzPubkey"), str) or len(route["buzzPubkey"]) != 64 or any(char not in "0123456789abcdef" for char in route["buzzPubkey"]):
            raise RosterError(f"Buzz identity is invalid for {name}")
    return routes


def desired_config(route: dict[str, str]) -> dict[str, object]:
    return {
        "engine": "acp",
        "model": route["model"],
        "modelReasoningEffort": route["reasoning"],
        "mode": "persistent",
        "nonInteractivePermissions": "deny",
        "warmHandleIdleMs": 0,
        "timeoutSec": 0,
        "graceSec": 15,
    }


def plan(agents: object, routes: dict[str, dict[str, str]]) -> list[dict[str, object]]:
    if not isinstance(agents, list) or any(not isinstance(agent, dict) for agent in agents):
        raise RosterError("agent configuration response is malformed")
    names = [agent.get("name") for agent in agents]
    if len(names) != len(set(names)):
        raise RosterError("Paperclip agent names are not unique")
    by_name = {agent.get("name"): agent for agent in agents}
    if any(name not in by_name for name in routes):
        missing = sorted(name for name in routes if name not in by_name)
        raise RosterError(f"durable roster identities are missing: {','.join(missing)}")
    out: list[dict[str, object]] = []
    for name in sorted(routes):
        agent = by_name[name]
        if agent.get("id") != routes[name]["paperclipAgentId"]:
            raise RosterError(f"Paperclip identity mismatch for {name}")
        if agent.get("status") == "running":
            raise RosterError(f"refusing to repin running agent {name}")
        agent_id = agent.get("id")
        if not isinstance(agent_id, str) or not agent_id:
            raise RosterError(f"agent id is invalid for {name}")
        desired = desired_config(routes[name])
        current = agent.get("adapterConfig") if isinstance(agent.get("adapterConfig"), dict) else {}
        already = agent.get("adapterType") == "codex_local" and all(current.get(k) == v for k, v in desired.items())
        out.append({
            "name": name,
            "agentId": agent_id,
            "buzzPubkey": routes[name]["buzzPubkey"],
            "alreadyDesired": already,
            "from": {
                "adapterType": agent.get("adapterType"),
                "adapterConfigSha256": digest(current),
            },
            "to": {"adapterType": "codex_local", "adapterConfig": desired},
        })
    return out


@dataclass
class Api:
    base: str
    company_id: str
    token: str

    def request(self, method: str, path: str, body: object | None = None) -> Any:
        data = None if body is None else canonical(body)
        request = urllib.request.Request(
            f"{self.base.rstrip('/')}{path}", data=data, method=method,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return json.loads(response.read() or b"null")
        except (urllib.error.URLError, json.JSONDecodeError) as error:
            raise RosterError("Paperclip roster request failed") from error

    def agents(self) -> object:
        return self.request("GET", f"/api/companies/{self.company_id}/agent-configurations")

    def patch(self, agent_id: str, adapter_type: str, adapter_config: dict[str, object], replace: bool) -> object:
        return self.request("PATCH", f"/api/agents/{agent_id}", {
            "adapterType": adapter_type,
            "adapterConfig": adapter_config,
            "replaceAdapterConfig": replace,
        })


def durable_write(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(canonical(value)); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try: os.fsync(directory)
        finally: os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)


def durable_create(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(canonical(value)); output.flush(); os.fsync(output.fileno())
    directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try: os.fsync(directory)
    finally: os.close(directory)


def is_desired(agent: dict[str, object], desired: dict[str, object]) -> bool:
    config = agent.get("adapterConfig") if isinstance(agent.get("adapterConfig"), dict) else {}
    return agent.get("adapterType") == desired["adapterType"] and all(config.get(k) == v for k, v in desired["adapterConfig"].items())


def recover(api: Api, receipt_path: pathlib.Path) -> dict[str, object]:
    receipt = json.loads(receipt_path.read_text())
    if receipt.get("schemaVersion") != RECEIPT_SCHEMA or receipt.get("status") not in {"initiated", "rollback_failed", "reconciliation_required"}:
        raise RosterError("roster receipt is not recoverable")
    current = api.agents()
    if not isinstance(current, list): raise RosterError("agent configuration response is malformed")
    by_id = {agent.get("id"): agent for agent in current if isinstance(agent, dict)}
    rollback_errors: list[str] = []
    for entry in reversed(receipt.get("targets", [])):
        agent_id = entry["agentId"]
        live = by_id.get(agent_id)
        if not isinstance(live, dict): rollback_errors.append(agent_id); continue
        desired = entry["desired"]
        prior = entry["prior"]
        live_config = live.get("adapterConfig") if isinstance(live.get("adapterConfig"), dict) else {}
        if live.get("adapterType") == prior["adapterType"] and digest(live_config) == prior["adapterConfigSha256"]:
            continue
        if not is_desired(live, desired):
            rollback_errors.append(agent_id); continue
        try:
            restored = api.patch(agent_id, prior["adapterType"], prior["adapterConfig"], True)
            restored_config = restored.get("adapterConfig") if isinstance(restored, dict) and isinstance(restored.get("adapterConfig"), dict) else {}
            if not isinstance(restored, dict) or restored.get("adapterType") != prior["adapterType"] or digest(restored_config) != prior["adapterConfigSha256"]:
                rollback_errors.append(agent_id)
        except Exception:
            rollback_errors.append(agent_id)
    receipt["status"] = "rolled_back" if not rollback_errors else "reconciliation_required"
    receipt["rollbackErrorAgentIds"] = rollback_errors
    durable_write(receipt_path, receipt)
    if rollback_errors: raise RosterError("roster recovery requires operator reconciliation")
    return receipt


def apply(api: Api, routes: dict[str, dict[str, str]], receipt_path: pathlib.Path) -> dict[str, object]:
    agents = api.agents()
    changes = plan(agents, routes)
    by_id = {agent["id"]: agent for agent in agents if isinstance(agent, dict) and isinstance(agent.get("id"), str)}
    targets = []
    for change in changes:
        agent_id = str(change["agentId"]); prior = by_id[agent_id]
        prior_config = prior.get("adapterConfig") if isinstance(prior.get("adapterConfig"), dict) else {}
        assert_no_inline_secrets(prior_config, f"agent.{change['name']}.adapterConfig")
        targets.append({"name": change["name"], "agentId": agent_id, "desired": change["to"], "prior": {"adapterType": prior.get("adapterType"), "adapterConfig": prior_config, "adapterConfigSha256": digest(prior_config)}})
    receipt: dict[str, object] = {"schemaVersion": RECEIPT_SCHEMA, "status": "initiated", "manifestSha256": digest({"schemaVersion": SCHEMA, "routes": routes}), "plan": changes, "targets": targets, "applied": []}
    try: durable_create(receipt_path, receipt)
    except FileExistsError as error: raise RosterError("roster transaction receipt already exists; recover it instead") from error
    applied: list[str] = []
    try:
        for change in changes:
            if change["alreadyDesired"]: continue
            agent_id = str(change["agentId"])
            desired = change["to"]
            result = api.patch(agent_id, str(desired["adapterType"]), desired["adapterConfig"], False)
            if not isinstance(result, dict) or result.get("adapterType") != "codex_local":
                raise RosterError("Paperclip did not confirm durable route")
            config = result.get("adapterConfig") if isinstance(result.get("adapterConfig"), dict) else {}
            if any(config.get(k) != v for k, v in desired["adapterConfig"].items()):
                raise RosterError("Paperclip confirmed a different durable route")
            applied.append(agent_id)
            receipt["applied"] = list(applied); durable_write(receipt_path, receipt)
        verified_agents = api.agents()
        verified_plan = plan(verified_agents, routes)
        if any(not entry["alreadyDesired"] for entry in verified_plan):
            raise RosterError("Paperclip roster did not converge to the durable manifest")
    except Exception as error:
        receipt.update({"failureClass": type(error).__name__})
        durable_write(receipt_path, receipt)
        recover(api, receipt_path)
        raise
    receipt["status"] = "completed"; durable_write(receipt_path, receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=pathlib.Path, default=pathlib.Path(__file__).with_name("durable-buzz-roster.json"))
    parser.add_argument("--agents-json", type=pathlib.Path)
    operation = parser.add_mutually_exclusive_group()
    operation.add_argument("--apply", action="store_true")
    operation.add_argument("--recover", action="store_true")
    parser.add_argument("--api-base")
    parser.add_argument("--company-id")
    parser.add_argument("--token-fd", type=int)
    parser.add_argument("--receipt", type=pathlib.Path)
    args = parser.parse_args()
    routes = load_manifest(args.manifest)
    if not args.apply and not args.recover:
        if not args.agents_json: raise RosterError("dry-run requires --agents-json")
        print(json.dumps({"schemaVersion": RECEIPT_SCHEMA, "status": "planned", "plan": plan(json.loads(args.agents_json.read_text()), routes)}, sort_keys=True))
        return 0
    if not args.api_base or not args.company_id or args.token_fd is None or not args.receipt:
        raise RosterError("apply/recover requires --api-base, --company-id, --token-fd, and --receipt")
    token = os.read(args.token_fd, 65536).decode().strip()
    if not token: raise RosterError("token fd was empty")
    api = Api(args.api_base, args.company_id, token)
    if args.recover: recover(api, args.receipt)
    else: apply(api, routes, args.receipt)
    return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except RosterError as error:
        print(f"durable roster refused: {error}", file=sys.stderr)
        raise SystemExit(2)
