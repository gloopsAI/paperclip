#!/usr/bin/env python3
"""Apply ONE Plane Steward recipe (C5). Dry-run by default.

Requires ``--apply`` to mutate. Enforces allowlist path checks, exclusive-writer
hints, issue-bound wake only, and never enables HEARTBEAT_SCHEDULER.

Authority bounds (fail closed):
  - hostctl apply (READMIT one UUID, scheduler guard)
  - board issue patch (resourceBudget only)
  - agent wakeup with payload.issueId
  - local git reset/clean/checkout on allowlisted workspace paths
  - ACL fix for node/995 on allowlisted paths

Forbidden:
  - free product code edits
  - whole-company unfreeze
  - Induct unpause
  - naked wakeup
  - HEARTBEAT_SCHEDULER_ENABLED=true
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import UUID


HERE = Path(__file__).resolve().parent
RECIPES_PATH = HERE / "recipes.json"
HOSTCTL_DEFAULT = HERE.parent / "paperclip-hostctl.py"

SHA40_RE = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_PATH_ROOTS = (
    "/opt/data/workspace/",
    "/opt/paperclip/hermes-execution-state/workspace/",
)
DEFAULT_NODE_UID = 995
DEFAULT_NODE_GID = 995

# Env overrides for tests / non-hermes dry paths
ENV_PATH_ROOTS = "PLANE_STEWARD_PATH_ROOTS"
ENV_HOSTCTL = "PLANE_STEWARD_HOSTCTL"
ENV_API_BASE = "PAPERCLIP_API_BASE"
ENV_API_TOKEN = "PAPERCLIP_API_TOKEN"
ENV_RUNTIME_ENV = "PLANE_STEWARD_RUNTIME_ENV"
ENV_EXCLUSIVE_WRITER = "PLANE_STEWARD_EXCLUSIVE_WRITER"  # "1" to assert held
ENV_TEST_MODE = "PLANE_STEWARD_TEST_MODE"


class RecipeError(RuntimeError):
    """Typed fail-closed error."""


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_recipes(path: Path = RECIPES_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "gloops.plane-steward.recipes.v1":
        raise RecipeError("recipes schemaVersion mismatch")
    return data


def get_recipe(pack: dict[str, Any], recipe_id: str) -> dict[str, Any]:
    for recipe in pack.get("recipes", []):
        if recipe.get("id") == recipe_id:
            return recipe
    raise RecipeError(f"unknown recipe id: {recipe_id}")


def path_roots(pack: dict[str, Any] | None = None) -> list[Path]:
    raw = os.environ.get(ENV_PATH_ROOTS)
    if raw:
        parts = [p.strip() for p in raw.split(":") if p.strip()]
    elif pack and pack.get("pathAllowlistRoots"):
        parts = list(pack["pathAllowlistRoots"])
    else:
        parts = list(DEFAULT_PATH_ROOTS)
    return [Path(p).resolve() for p in parts]


def is_allowlisted_path(target: Path, roots: list[Path]) -> bool:
    try:
        resolved = target.resolve()
    except OSError as error:
        raise RecipeError(f"path unresolvable: {target}: {error}") from error
    for root in roots:
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def require_allowlisted(cwd: Path, roots: list[Path]) -> Path:
    resolved = cwd.expanduser()
    if not is_allowlisted_path(resolved, roots):
        raise RecipeError(
            f"path outside allowlist roots: {resolved} (roots={','.join(str(r) for r in roots)})"
        )
    return resolved.resolve()


def require_uuid(value: str | None, label: str = "issueId") -> str:
    if value is None or value == "" or value == "null":
        raise RecipeError(f"{label} is required (null/empty rejected — issue-bound only)")
    try:
        return str(UUID(str(value)))
    except (ValueError, AttributeError, TypeError) as error:
        raise RecipeError(f"{label} must be a UUID: {value!r}") from error


def require_sha40(value: str | None, label: str = "expectedSha") -> str:
    if not value or not isinstance(value, str):
        raise RecipeError(f"{label} is required")
    normalized = value.strip().lower()
    if not SHA40_RE.fullmatch(normalized):
        raise RecipeError(
            f"{label} must be full 40-char lowercase hex SHA (got {value!r}); "
            "branch names like 'main' are forbidden"
        )
    return normalized


def exclusive_writer_ok() -> bool:
    """Exclusive-writer gate.

    In production, operator/Sentinel must set PLANE_STEWARD_EXCLUSIVE_WRITER=1
    after confirming hostctl holder or campaign exclusive-writer pin. Test mode
    may set it. Missing flag fails closed for mutating recipes that require it.
    """
    return os.environ.get(ENV_EXCLUSIVE_WRITER, "") in {"1", "true", "yes"}


def run_cmd(
    argv: list[str],
    *,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        env=env,
        text=True,
        capture_output=True,
        check=check,
    )


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run_cmd(["git", *args], cwd=cwd, check=check)


def result(
    *,
    recipe_id: str,
    dry_run: bool,
    ok: bool,
    planned: list[str],
    executed: list[str],
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": ok,
        "ts": timestamp(),
        "recipeId": recipe_id,
        "dryRun": dry_run,
        "planned": planned,
        "executed": executed,
    }
    if error:
        payload["error"] = error
    if extra:
        payload.update(extra)
    return payload


# ---------------------------------------------------------------------------
# Recipe implementations
# ---------------------------------------------------------------------------

def recipe_dirty_tree_clean(
    *,
    dry_run: bool,
    params: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    recipe_id = "dirty-tree-clean"
    roots = path_roots(pack)
    cwd = require_allowlisted(Path(params["cwd"]), roots)
    planned = [
        f"verify allowlisted: {cwd}",
        "require exclusive-writer",
        "git status --porcelain",
        "git reset --hard HEAD",
        "git clean -fdx",
    ]
    executed: list[str] = []
    if not exclusive_writer_ok():
        raise RecipeError("exclusive-writer required (set PLANE_STEWARD_EXCLUSIVE_WRITER=1)")
    if not (cwd / ".git").exists() and not (cwd / ".git").is_file():
        # also accept gitdir file for worktrees
        probe = git(cwd, "rev-parse", "--is-inside-work-tree", check=False)
        if probe.returncode != 0 or probe.stdout.strip() != "true":
            raise RecipeError(f"not a git worktree: {cwd}")
    status = git(cwd, "status", "--porcelain", check=False)
    porcelain = status.stdout
    executed.append("git status --porcelain")
    if dry_run:
        return result(
            recipe_id=recipe_id,
            dry_run=True,
            ok=True,
            planned=planned,
            executed=executed,
            extra={"porcelain": porcelain, "wouldMutate": bool(porcelain.strip())},
        )
    git(cwd, "reset", "--hard", "HEAD")
    executed.append("git reset --hard HEAD")
    git(cwd, "clean", "-fdx")
    executed.append("git clean -fdx")
    after = git(cwd, "status", "--porcelain")
    executed.append("git status --porcelain (verify)")
    if after.stdout.strip():
        raise RecipeError("tree still dirty after clean")
    return result(
        recipe_id=recipe_id,
        dry_run=False,
        ok=True,
        planned=planned,
        executed=executed,
        extra={"porcelainBefore": porcelain, "porcelainAfter": ""},
    )


def recipe_wrong_head_rebase(
    *,
    dry_run: bool,
    params: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    recipe_id = "wrong-head-rebase"
    roots = path_roots(pack)
    cwd = require_allowlisted(Path(params["cwd"]), roots)
    sha = require_sha40(params.get("expectedSha") or params.get("sha"))
    planned = [
        f"verify allowlisted: {cwd}",
        "require exclusive-writer",
        f"git cat-file -e {sha}^{{commit}} (or fetch)",
        f"git checkout --detach {sha}",
        "verify HEAD == expectedSha",
    ]
    executed: list[str] = []
    if not exclusive_writer_ok():
        raise RecipeError("exclusive-writer required (set PLANE_STEWARD_EXCLUSIVE_WRITER=1)")
    probe = git(cwd, "rev-parse", "--is-inside-work-tree", check=False)
    if probe.returncode != 0:
        raise RecipeError(f"not a git worktree: {cwd}")
    head = git(cwd, "rev-parse", "HEAD", check=False)
    executed.append("git rev-parse HEAD")
    current = head.stdout.strip().lower() if head.returncode == 0 else None
    if dry_run:
        return result(
            recipe_id=recipe_id,
            dry_run=True,
            ok=True,
            planned=planned,
            executed=executed,
            extra={"currentHead": current, "expectedSha": sha, "alreadyAtHead": current == sha},
        )
    has = git(cwd, "cat-file", "-e", f"{sha}^{{commit}}", check=False)
    if has.returncode != 0:
        fetch = git(cwd, "fetch", "--no-tags", "origin", sha, check=False)
        executed.append(f"git fetch origin {sha} (rc={fetch.returncode})")
        if fetch.returncode != 0:
            raise RecipeError(
                f"SHA {sha} not present locally and fetch failed; use repo-bootstrap first"
            )
    git(cwd, "checkout", "--detach", sha)
    executed.append(f"git checkout --detach {sha}")
    new_head = git(cwd, "rev-parse", "HEAD").stdout.strip().lower()
    executed.append("git rev-parse HEAD (verify)")
    if new_head != sha:
        raise RecipeError(f"HEAD {new_head} != expected {sha}")
    return result(
        recipe_id=recipe_id,
        dry_run=False,
        ok=True,
        planned=planned,
        executed=executed,
        extra={"previousHead": current, "head": new_head},
    )


def recipe_acl_fix(
    *,
    dry_run: bool,
    params: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    recipe_id = "acl-fix"
    roots = path_roots(pack)
    cwd = require_allowlisted(Path(params["cwd"]), roots)
    uid = int(params.get("uid", DEFAULT_NODE_UID))
    gid = int(params.get("gid", DEFAULT_NODE_GID))
    if uid != DEFAULT_NODE_UID:
        raise RecipeError(f"acl-fix only allows node uid {DEFAULT_NODE_UID}, got {uid}")
    planned = [
        f"verify allowlisted: {cwd}",
        "require exclusive-writer",
        f"chmod -R u+rwX,g+rX,o+rX {cwd}",
        f"setfacl -R -m u:{uid}:rx {cwd} (if setfacl available)",
        f"verify readable for uid {uid}",
    ]
    executed: list[str] = []
    if not exclusive_writer_ok():
        raise RecipeError("exclusive-writer required (set PLANE_STEWARD_EXCLUSIVE_WRITER=1)")
    if not cwd.exists():
        raise RecipeError(f"cwd does not exist: {cwd}")
    if dry_run:
        mode = stat.S_IMODE(cwd.stat().st_mode)
        return result(
            recipe_id=recipe_id,
            dry_run=True,
            ok=True,
            planned=planned,
            executed=executed,
            extra={"cwdMode": oct(mode), "uid": uid, "gid": gid},
        )
    # Bounded chmod: directories u+rwx,g+rx,o+rx; files u+rw,g+r,o+r (+x if already x)
    for root, dirs, files in os.walk(cwd):
        root_path = Path(root)
        os.chmod(root_path, 0o755)
        for name in files:
            fp = root_path / name
            try:
                current = stat.S_IMODE(fp.stat().st_mode)
                new_mode = 0o644 | (0o111 if current & 0o111 else 0)
                os.chmod(fp, new_mode)
            except OSError:
                continue
    executed.append("chmod walk u+rwX,g+rX,o+rX")
    setfacl = run_cmd(["setfacl", "-R", "-m", f"u:{uid}:rx", str(cwd)], check=False)
    executed.append(f"setfacl rc={setfacl.returncode}")
    return result(
        recipe_id=recipe_id,
        dry_run=False,
        ok=True,
        planned=planned,
        executed=executed,
        extra={"uid": uid, "gid": gid},
    )


def _hostctl_bin() -> Path:
    override = os.environ.get(ENV_HOSTCTL)
    return Path(override) if override else HOSTCTL_DEFAULT


def _runtime_env_path() -> Path:
    return Path(os.environ.get(ENV_RUNTIME_ENV, "/etc/paperclip-gloops/runtime.env"))


def _read_runtime_key(key: str) -> str | None:
    path = _runtime_env_path()
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


def _hostctl_identity(params: dict[str, Any]) -> dict[str, str]:
    ident = params.get("hostctlIdentity") or {}
    if not isinstance(ident, dict):
        raise RecipeError("hostctlIdentity must be an object")
    agent = ident.get("agentSlug") or params.get("agentSlug") or "plane-steward"
    session = ident.get("sessionId") or params.get("sessionId") or "plane-steward-session"
    mission = ident.get("missionId") or params.get("missionId") or "plane-steward"
    return {"agentSlug": str(agent), "sessionId": str(session), "missionId": str(mission)}


def _hostctl_apply(sets: list[str], identity: dict[str, str], intent: str) -> dict[str, Any]:
    hostctl = _hostctl_bin()
    argv = [
        sys.executable,
        str(hostctl),
        "apply",
        "--agent-slug",
        identity["agentSlug"],
        "--session-id",
        identity["sessionId"],
        "--mission-id",
        identity["missionId"],
        "--intent",
        intent,
    ]
    for assignment in sets:
        argv.extend(["--set", assignment])
    proc = run_cmd(argv, check=False)
    if proc.returncode != 0:
        raise RecipeError(f"hostctl apply failed: {proc.stderr.strip() or proc.stdout.strip()}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": True, "raw": proc.stdout}


def _api_request(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    base = os.environ.get(ENV_API_BASE, "").rstrip("/")
    if not base:
        raise RecipeError(f"{ENV_API_BASE} required for board/agent API mutations")
    token = os.environ.get(ENV_API_TOKEN)
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {
        "Accept": "application/json",
        "User-Agent": "plane-steward-apply/1.0",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8")
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:400]
        raise RecipeError(f"API {method} {path} returned {error.code}: {detail}") from error
    except urllib.error.URLError as error:
        raise RecipeError(f"API {method} {path} unavailable: {error}") from error


def recipe_never_enable_scheduler(
    *,
    dry_run: bool,
    params: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    recipe_id = "never-enable-global-heartbeat-scheduler"
    # Explicit refuse if someone tries to pass enable=true
    if str(params.get("enable", "")).lower() in {"1", "true", "yes"}:
        raise RecipeError(
            "refusing to enable HEARTBEAT_SCHEDULER under controlled-swarm (hard rule)"
        )
    current = _read_runtime_key("HEARTBEAT_SCHEDULER_ENABLED")
    planned = [
        f"observe HEARTBEAT_SCHEDULER_ENABLED={current!r}",
        "if true → hostctl set false",
        "never set true",
    ]
    executed: list[str] = []
    if dry_run:
        return result(
            recipe_id=recipe_id,
            dry_run=True,
            ok=True,
            planned=planned,
            executed=executed,
            extra={
                "heartbeatSchedulerEnabled": current,
                "wouldForceFalse": current is not None and current.lower() == "true",
            },
        )
    if current is not None and current.lower() == "true":
        identity = _hostctl_identity(params)
        _hostctl_apply(
            ["HEARTBEAT_SCHEDULER_ENABLED=false"],
            identity,
            intent="plane-steward: disable heartbeat scheduler under controlled-swarm",
        )
        executed.append("hostctl HEARTBEAT_SCHEDULER_ENABLED=false")
    else:
        executed.append("already false or unset — no mutation")
    return result(
        recipe_id=recipe_id,
        dry_run=False,
        ok=True,
        planned=planned,
        executed=executed,
        extra={"heartbeatSchedulerEnabled": _read_runtime_key("HEARTBEAT_SCHEDULER_ENABLED")},
    )


def recipe_null_issue_wake_reject(
    *,
    dry_run: bool,
    params: dict[str, Any],
    pack: dict[str, Any],
) -> dict[str, Any]:
    recipe_id = "null-issueId-wake-reject"
    issue_id = require_uuid(params.get("issueId"), "issueId")
    agent_id = params.get("agentId")
    if not agent_id or not isinstance(agent_id, str):
        raise RecipeError("agentId is required to re-issue bound wake")
    planned = [
        "reject naked/null issueId wake (no company unfreeze)",
        f"POST /agents/{agent_id}/wakeup payload.issueId={issue_id}",
    ]
    executed: list[str] = []
    if dry_run:
        return result(
            recipe_id=recipe_id,
            dry_run=True,
            ok=True,
            planned=planned,
            executed=executed,
            extra={"issueId": issue_id, "agentId": agent_id, "companyUnfreeze": False},
        )
    wake_body = {"payload": {"issueId": issue_id}}
    woken = False
    for path in (f"/api/agents/{agent_id}/wakeup", f"/agents/{agent_id}/wakeup"):
        try:
            _api_request("POST", path, wake_body)
            executed.append(f"POST {path} issue-bound")
            woken = True
            break
        except RecipeError:
            continue
    if not woken:
        raise RecipeError("issue-bound wakeup failed on known API paths")
    return result(
        recipe_id=recipe_id,
        dry_run=False,
        ok=True,
        planned=planned,
        executed=executed,
        extra={"issueId": issue_id, "agentId": agent_id, "companyUnfreeze": False},
    )


HANDLERS: dict[str, Callable[..., dict[str, Any]]] = {
    "dirty-tree-clean": recipe_dirty_tree_clean,
    "wrong-head-rebase": recipe_wrong_head_rebase,
    "acl-fix": recipe_acl_fix,
    "never-enable-global-heartbeat-scheduler": recipe_never_enable_scheduler,
    "null-issueId-wake-reject": recipe_null_issue_wake_reject,
}


def parse_param_args(raw: list[str]) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for item in raw:
        if "=" not in item:
            raise RecipeError(f"--param requires KEY=VALUE, got {item!r}")
        key, value = item.split("=", 1)
        # JSON value if looks like json
        if value.startswith("{") or value.startswith("[") or value in {"true", "false", "null"}:
            try:
                params[key] = json.loads(value)
                continue
            except json.JSONDecodeError:
                pass
        params[key] = value
    return params


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--recipe", required=True, help="Recipe id from recipes.json")
    p.add_argument(
        "--apply",
        action="store_true",
        help="Actually mutate (default is dry-run)",
    )
    p.add_argument(
        "--param",
        action="append",
        default=[],
        help="KEY=VALUE (repeatable). JSON values accepted.",
    )
    p.add_argument(
        "--params-json",
        type=Path,
        help="JSON file of params (merged with --param)",
    )
    p.add_argument(
        "--recipes",
        type=Path,
        default=RECIPES_PATH,
        help="Path to recipes.json",
    )
    p.add_argument(
        "--list",
        action="store_true",
        help="List recipe ids and exit",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # Support --list without --recipe
    if argv is None:
        argv = sys.argv[1:]
    if "--list" in argv:
        pack = load_recipes(RECIPES_PATH)
        for recipe in pack.get("recipes", []):
            print(f"{recipe['id']} — {recipe.get('title', '')}")
        return 0

    args = parse_args(argv)
    dry_run = not args.apply
    try:
        pack = load_recipes(args.recipes)
        recipe = get_recipe(pack, args.recipe)
        if recipe["id"] not in HANDLERS:
            raise RecipeError(f"recipe has no handler: {args.recipe}")
        params: dict[str, Any] = {}
        if args.params_json:
            loaded = json.loads(args.params_json.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                raise RecipeError("--params-json must be an object")
            params.update(loaded)
        params.update(parse_param_args(args.param))
        report = HANDLERS[args.recipe](dry_run=dry_run, params=params, pack=pack)
        print(json.dumps(report, sort_keys=True, indent=2))
        return 0 if report.get("ok") else 1
    except RecipeError as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "ts": timestamp(),
                    "recipeId": getattr(args, "recipe", None),
                    "dryRun": dry_run,
                    "error": str(error),
                },
                sort_keys=True,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "ts": timestamp(),
                    "recipeId": getattr(args, "recipe", None),
                    "dryRun": dry_run,
                    "error": str(error),
                },
                sort_keys=True,
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
