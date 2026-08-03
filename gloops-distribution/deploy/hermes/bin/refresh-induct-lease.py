#!/usr/bin/env python3
"""Standing Induct lease refresh — Option A prefers Induct GitHub App; else root gh.

See: plane-steward/INDUCT_GITHUB_APP_OPTION_A.md
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

SHA40 = re.compile(r"^[0-9a-f]{40}$")

REPO = os.environ.get("INDUCT_LEASE_REPO", "InductAI/induct")
BRANCH = os.environ.get("INDUCT_LEASE_BRANCH", "main")
HOST_DEST = Path(
    os.environ.get(
        "INDUCT_LEASE_HOST_PATH",
        "/opt/paperclip/hermes-execution-state/workspace/induct-main",
    )
)
CWD_IN_PAPERCLIP = os.environ.get("INDUCT_LEASE_CWD", "/opt/data/workspace/induct-main")
PWS_ID = os.environ.get("INDUCT_LEASE_PWS_ID", "452c8800-8270-4ca1-b384-8a677a39b826")
PROJECT_ID = os.environ.get(
    "INDUCT_LEASE_PROJECT_ID", "cfca4683-e256-40e0-91b3-f2e513170ec0"
)
API = os.environ.get("PAPERCLIP_API", "http://127.0.0.1:3100").rstrip("/")
TOKEN_FILE = Path(
    os.environ.get(
        "PAPERCLIP_BOARD_TOKEN_FILE",
        "/etc/paperclip-gloops/operator-board-token",
    )
)
INDUCT_APP = Path(
    os.environ.get(
        "INDUCT_GITHUB_APP_BIN",
        "/usr/local/lib/paperclip-gloops/bin/induct-github-app.py",
    )
)
HERMES_UID = 10000
PAPERCLIP_GID = 985


def ts() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, text=True, capture_output=True, check=False, **kwargs)


def resolve_main_sha() -> str:
    proc = run(["gh", "api", f"repos/{REPO}/commits/{BRANCH}", "--jq", ".sha"])
    if proc.returncode == 0:
        sha = (proc.stdout or "").strip().lower()
        if SHA40.fullmatch(sha):
            return sha
    raise SystemExit(f"resolve_sha_failed: {proc.stderr or proc.stdout}")


def observed_sha() -> str | None:
    if not HOST_DEST.is_dir():
        return None
    proc = run(["git", "-C", str(HOST_DEST), "rev-parse", "HEAD"])
    if proc.returncode != 0:
        return None
    sha = (proc.stdout or "").strip().lower()
    return sha if SHA40.fullmatch(sha) else None


def induct_app_ready() -> bool:
    if not INDUCT_APP.is_file():
        return False
    proc = run(["python3", str(INDUCT_APP), "status"])
    if proc.returncode != 0:
        return False
    try:
        return bool(json.loads(proc.stdout or "{}").get("ok"))
    except json.JSONDecodeError:
        return False


def materialize_via_app(sha: str) -> str:
    proc = run(["python3", str(INDUCT_APP), "clone", "--sha", sha, "--dest", str(HOST_DEST)])
    if proc.returncode != 0:
        raise SystemExit(f"app_clone_failed: {proc.stderr or proc.stdout}")
    return "induct-github-app"


def materialize_via_gh(sha: str) -> str:
    tmp = Path(f"/tmp/induct-lease-refresh-{os.getpid()}")
    if tmp.exists():
        run(["rm", "-rf", str(tmp)])
    tmp.mkdir(parents=True)
    repo_dir = tmp / "repo"
    proc = run(["gh", "repo", "clone", REPO, str(repo_dir), "--", "--filter=blob:none"])
    if proc.returncode != 0:
        raise SystemExit(f"clone_failed: {proc.stderr}")
    run(["git", "-C", str(repo_dir), "fetch", "origin", sha])
    proc = run(["git", "-C", str(repo_dir), "checkout", "--detach", sha])
    if proc.returncode != 0:
        raise SystemExit(f"checkout_failed: {proc.stderr}")
    got = run(["git", "-C", str(repo_dir), "rev-parse", "HEAD"]).stdout.strip().lower()
    if got != sha:
        raise SystemExit(f"head_mismatch: got {got} want {sha}")
    if HOST_DEST.exists():
        run(["rm", "-rf", str(HOST_DEST)])
    run(["mv", str(repo_dir), str(HOST_DEST)])
    run(["rm", "-rf", str(tmp)])
    run(
        [
            "git",
            "-C",
            str(HOST_DEST),
            "remote",
            "set-url",
            "origin",
            f"https://github.com/{REPO}.git",
        ]
    )
    return "root-gh"


def finalize_acl(sha: str) -> None:
    run(["chown", "-R", f"{HERMES_UID}:{PAPERCLIP_GID}", str(HOST_DEST)])
    run(["find", str(HOST_DEST), "-type", "d", "-exec", "chmod", "g+s", "{}", "+"])
    run(["chmod", "-R", "g+rwX", str(HOST_DEST)])
    run(["git", "-C", str(HOST_DEST), "reset", "--hard", sha])
    run(["git", "-C", str(HOST_DEST), "clean", "-fdx"])
    porcelain = run(
        [
            "sudo",
            "-u",
            "paperclip",
            "-g",
            "paperclip",
            "git",
            "-C",
            str(HOST_DEST),
            "status",
            "--porcelain",
        ]
    )
    if porcelain.stdout.strip():
        raise SystemExit(f"dirty_after_materialize: {porcelain.stdout[:200]}")
    head = run(
        [
            "sudo",
            "-u",
            "paperclip",
            "-g",
            "paperclip",
            "git",
            "-C",
            str(HOST_DEST),
            "rev-parse",
            "HEAD",
        ]
    ).stdout.strip().lower()
    if head != sha:
        raise SystemExit(f"paperclip_cannot_read_head: {head}")


def materialize(sha: str) -> str:
    if HOST_DEST.exists():
        run(["rm", "-rf", str(HOST_DEST)])
    if induct_app_ready():
        path = materialize_via_app(sha)
    else:
        path = materialize_via_gh(sha)
    finalize_acl(sha)
    return path


def board_token() -> str:
    return TOKEN_FILE.read_text().strip()


def patch_pws(sha: str) -> dict:
    body = {
        "repoRef": sha,
        "defaultRef": sha,
        "metadata": {
            "purpose": "Induct swarm host lease (auto-refresh)",
            "exactBase": sha,
            "defaultBranch": BRANCH,
            "operatorPrepared": True,
            "refreshedAt": ts(),
            "refreshedBy": "refresh-induct-lease.py",
            "hostPath": str(HOST_DEST),
            "productPaused": False,
            "cwd": CWD_IN_PAPERCLIP,
            "writeIdentity": "induct-github-app (option A) when status ok; else root-gh materialize only",
        },
    }
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{API}/api/projects/{PROJECT_ID}/workspaces/{PWS_ID}",
        data=data,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {board_token()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"pws_patch_failed: {e.code} {e.read()[:300]!r}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--only-if-stale", action="store_true")
    args = ap.parse_args()
    tip = resolve_main_sha()
    host = observed_sha()
    app_ok = induct_app_ready()
    report = {
        "ok": True,
        "ts": ts(),
        "schemaVersion": "gloops.induct-lease-refresh.v1",
        "dryRun": not args.apply,
        "repo": REPO,
        "branch": BRANCH,
        "tipSha": tip,
        "hostSha": host,
        "stale": host != tip,
        "inductAppReady": app_ok,
        "materializePath": "induct-github-app" if app_ok else "root-gh-fallback",
        "pwsId": PWS_ID,
        "hostPath": str(HOST_DEST),
        "cwd": CWD_IN_PAPERCLIP,
        "exactHeadLine": f"Exact head: `{tip}`",
        "actions": [],
    }
    if not args.apply:
        report["actions"] = [
            f"would materialize via {report['materializePath']} {REPO}@{tip} -> {HOST_DEST}",
            f"would PATCH PWS {PWS_ID} repoRef/defaultRef={tip}",
        ]
        if not app_ok:
            report["actions"].append(
                "induct App not ready — using root gh until Option A install completes"
            )
        print(json.dumps(report, indent=2))
        return 0

    if args.only_if_stale and host == tip:
        report["actions"].append("skip materialize (already at tip)")
    else:
        path = materialize(tip)
        report["actions"].append(f"materialized via {path}: {tip}")
        report["hostSha"] = tip
        report["stale"] = False
        report["materializePath"] = path

    patched = patch_pws(tip)
    report["actions"].append(f"patched PWS {patched.get('id')} repoRef={patched.get('repoRef')}")
    report["pwsRepoRef"] = patched.get("repoRef")
    print(json.dumps(report, indent=2))
    print(f"PACKET_EXACT_HEAD={tip}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
