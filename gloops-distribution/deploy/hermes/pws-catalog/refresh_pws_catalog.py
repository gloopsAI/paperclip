#!/usr/bin/env python3
"""Refresh standing PWS catalog materializations (C7).

For each catalog entry:
  1. Resolve target full SHA (pinSha or tip of defaultBranch)
  2. Optionally materialize via repo-bootstrap
  3. Emit JSON report rows {name, sha, cwd, ok, error}

Dry-run by default; ``--apply`` mutates local worktrees.
Never treats branch names as expected head for implement packets — always SHA.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


HERE = Path(__file__).resolve().parent
CATALOG_PATH = HERE / "catalog.json"
BOOTSTRAP_DIR = HERE.parent / "repo-bootstrap"
SHA40_RE = re.compile(r"^[0-9a-f]{40}$")

ENV_TEST_MODE = "PWS_CATALOG_TEST_MODE"
ENV_LS_REMOTE_FN = "PWS_CATALOG_LS_REMOTE"  # unused; tests inject via param


class CatalogError(RuntimeError):
    pass


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_catalog(path: Path = CATALOG_PATH) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schemaVersion") != "gloops.pws-catalog.v1":
        raise CatalogError("catalog schemaVersion mismatch")
    if not isinstance(data.get("entries"), list):
        raise CatalogError("catalog.entries must be a list")
    return data


def import_bootstrap():
    sys.path.insert(0, str(BOOTSTRAP_DIR))
    import bootstrap_repo  # type: ignore

    return bootstrap_repo


def resolve_branch_sha(
    repo: str,
    branch: str,
    *,
    token: str | None = None,
    ls_remote_fn: Callable[[str, str], str] | None = None,
) -> str:
    """Return full 40-char SHA for refs/heads/<branch>."""
    if ls_remote_fn is not None:
        sha = ls_remote_fn(repo, branch)
        return _validate_sha(sha, f"{repo}@{branch}")

    # Prefer git ls-remote (works with public repos; token via https extraheader)
    url = f"https://github.com/{repo}.git"
    env = dict(os.environ)
    args = ["git", "ls-remote", url, f"refs/heads/{branch}"]
    if token:
        # GIT_CONFIG_COUNT pattern to avoid argv token leak in process list somewhat
        env["GIT_TERMINAL_PROMPT"] = "0"
        auth_url = f"https://x-access-token:{token}@github.com/{repo}.git"
        args = ["git", "ls-remote", auth_url, f"refs/heads/{branch}"]
    try:
        proc = subprocess.run(
            args,
            env=env,
            text=True,
            capture_output=True,
            check=False,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise CatalogError(f"ls-remote failed for {repo}@{branch}: {error}") from error
    if proc.returncode != 0:
        # Fallback: GitHub API
        return resolve_branch_sha_api(repo, branch, token=token)
    line = (proc.stdout or "").strip().splitlines()
    if not line:
        return resolve_branch_sha_api(repo, branch, token=token)
    sha = line[0].split()[0].strip().lower()
    return _validate_sha(sha, f"{repo}@{branch}")


def resolve_branch_sha_api(repo: str, branch: str, *, token: str | None = None) -> str:
    api = os.environ.get("GLOOPS_GITHUB_API_BASE", "https://api.github.com").rstrip("/")
    url = f"{api}/repos/{repo}/commits/{branch}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "gloops-pws-catalog/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as error:
        raise CatalogError(f"API resolve failed for {repo}@{branch}: {error}") from error
    sha = payload.get("sha") if isinstance(payload, dict) else None
    if not isinstance(sha, str):
        raise CatalogError(f"API resolve returned no sha for {repo}@{branch}")
    return _validate_sha(sha.lower(), f"{repo}@{branch}")


def _validate_sha(sha: str, label: str) -> str:
    if not SHA40_RE.fullmatch(sha):
        raise CatalogError(f"resolved ref for {label} is not a full 40-char SHA: {sha!r}")
    return sha


def target_sha_for_entry(
    entry: dict[str, Any],
    *,
    token: str | None = None,
    ls_remote_fn: Callable[[str, str], str] | None = None,
) -> str:
    pin = entry.get("pinSha")
    mode = (entry.get("refreshPolicy") or {}).get("mode", "track-branch-sha")
    if pin:
        if not isinstance(pin, str) or not SHA40_RE.fullmatch(pin.lower()):
            raise CatalogError(f"entry {entry.get('id')} pinSha must be 40-char hex")
        return pin.lower()
    if mode == "pin-or-branch" and not pin:
        # float to branch tip when pin unset
        pass
    repo = entry.get("repo")
    branch = entry.get("defaultBranch")
    if not isinstance(repo, str) or not isinstance(branch, str):
        raise CatalogError(f"entry {entry.get('id')} missing repo/defaultBranch")
    return resolve_branch_sha(repo, branch, token=token, ls_remote_fn=ls_remote_fn)


def refresh_entry(
    entry: dict[str, Any],
    *,
    dry_run: bool,
    token: str | None = None,
    ls_remote_fn: Callable[[str, str], str] | None = None,
    materialize_fn: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    name = entry.get("name") or entry.get("id") or "?"
    cwd = entry.get("cwdTemplate")
    row: dict[str, Any] = {
        "id": entry.get("id"),
        "name": name,
        "cwd": cwd,
        "sha": None,
        "ok": False,
        "error": None,
        "dryRun": dry_run,
    }
    try:
        sha = target_sha_for_entry(entry, token=token, ls_remote_fn=ls_remote_fn)
        row["sha"] = sha
        repo = entry["repo"]
        if materialize_fn is None:
            bootstrap = import_bootstrap()
            materialize_fn = bootstrap.materialize
        report = materialize_fn(
            repo=repo,
            sha=sha,
            dest=cwd,
            dry_run=dry_run,
            token=token,
        )
        if not report.get("ok"):
            row["error"] = report.get("error") or report.get("errorCode") or "materialize failed"
            return row
        row["ok"] = True
        row["bootstrap"] = {
            "dryRun": report.get("dryRun"),
            "head": report.get("head"),
            "dest": report.get("dest"),
        }
        return row
    except Exception as error:  # noqa: BLE001 — row-level isolation
        row["error"] = str(error)
        return row


def refresh_catalog(
    catalog: dict[str, Any],
    *,
    dry_run: bool = True,
    only: set[str] | None = None,
    token: str | None = None,
    ls_remote_fn: Callable[[str, str], str] | None = None,
    materialize_fn: Callable[..., dict[str, Any]] | None = None,
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for entry in catalog.get("entries", []):
        if only is not None:
            ident = {entry.get("id"), entry.get("name")}
            if ident.isdisjoint(only):
                continue
        rows.append(
            refresh_entry(
                entry,
                dry_run=dry_run,
                token=token,
                ls_remote_fn=ls_remote_fn,
                materialize_fn=materialize_fn,
            )
        )
    ok_count = sum(1 for r in rows if r["ok"])
    return {
        "ok": ok_count == len(rows) and len(rows) > 0,
        "ts": timestamp(),
        "schemaVersion": "gloops.pws-catalog.refresh.v1",
        "dryRun": dry_run,
        "entryCount": len(rows),
        "okCount": ok_count,
        "entries": rows,
        "notes": [
            "Never use branch name as expected head for implement packets.",
            "Set entry.pinSha for controlled-swarm paperclip pin when known.",
            "Dry-run default; pass --apply to materialize.",
        ],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--catalog", type=Path, default=CATALOG_PATH)
    p.add_argument("--apply", action="store_true", help="Materialize (default dry-run)")
    p.add_argument(
        "--only",
        action="append",
        default=[],
        help="Limit to entry id or name (repeatable)",
    )
    p.add_argument(
        "--token",
        default=None,
        help="Optional GitHub token (else bootstrap mint / public ls-remote)",
    )
    p.add_argument(
        "--print-catalog",
        action="store_true",
        help="Print catalog entries and exit",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        catalog = load_catalog(args.catalog)
    except (OSError, json.JSONDecodeError, CatalogError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2), file=sys.stderr)
        return 2

    if args.print_catalog:
        print(json.dumps(catalog, indent=2, sort_keys=True))
        return 0

    only = set(args.only) if args.only else None
    token = args.token
    if token is None and os.environ.get("REPO_BOOTSTRAP_TEST_MODE") == "1":
        token = os.environ.get("REPO_BOOTSTRAP_TEST_TOKEN")

    report = refresh_catalog(
        catalog,
        dry_run=not args.apply,
        only=only,
        token=token,
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get("ok") or report.get("dryRun") else 1


if __name__ == "__main__":
    raise SystemExit(main())
