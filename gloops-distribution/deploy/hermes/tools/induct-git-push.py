#!/usr/bin/env python3
"""Induct-only push + PR via Option A GitHub App (API commits for verified signatures).

Hermes agents should use induct-request-push.py; host poller runs this as root.

Usage:
  induct-git-push.py push --cwd /opt/paperclip/hermes-execution-state/workspace/induct-main --branch agent/...
  induct-git-push.py pr --cwd ... --branch ... --title "..." [--body "..."]
  induct-git-push.py push-pr --cwd ... --branch ... --title "..." [--body "..."]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ALLOWED_REPO = "InductAI/induct"
ALLOW_ROOTS = (
    "/opt/data/workspace/induct-main",
    "/opt/paperclip/hermes-execution-state/workspace/induct-main",
)
APP_BIN = Path(
    os.environ.get("INDUCT_GITHUB_APP_BIN", "/usr/local/lib/paperclip-gloops/bin/induct-github-app.py")
)
SHA40 = re.compile(r"^[0-9a-f]{40}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/\-]+$")


def die(code: str, msg: str) -> None:
    print(json.dumps({"ok": False, "errorCode": code, "error": msg}), file=sys.stderr)
    raise SystemExit(1)


def run(cmd: list[str], cwd: Path | None = None, env: dict | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env, text=True, capture_output=True, check=False)


def resolve_cwd(raw: str) -> Path:
    p = Path(raw).expanduser().resolve()
    if not p.is_dir():
        die("cwd_missing", f"cwd not a directory: {p}")
    s = str(p)
    ok = any(s == r.rstrip("/") or s.startswith(r.rstrip("/") + "/") for r in ALLOW_ROOTS)
    if not ok and "/induct-main" in s:
        ok = True
    if not ok:
        die("cwd_not_induct_lease", f"cwd {p} not under Induct lease roots")
    git = run(["git", "-C", str(p), "rev-parse", "--is-inside-work-tree"])
    if git.returncode != 0 or git.stdout.strip() != "true":
        die("cwd_not_git", f"not a git worktree: {p}")
    return p


def assert_remote_induct(cwd: Path) -> None:
    r = run(["git", "-C", str(cwd), "remote", "get-url", "origin"])
    url = (r.stdout or "").strip().lower().replace(".git", "")
    if "inductai/induct" not in url:
        die("remote_not_induct", f"origin is not InductAI/induct: {url}")


def mint_write_token() -> str:
    if not APP_BIN.is_file():
        die("app_bin_missing", f"missing {APP_BIN}")
    st = run(["python3", str(APP_BIN), "status"])
    try:
        status = json.loads(st.stdout or "{}")
    except json.JSONDecodeError:
        die("app_status_unreadable", st.stderr or st.stdout or "bad status")
    if not status.get("ok"):
        die("app_not_ready", str(status.get("error") or "induct app status not ok"))
    m = run(["python3", str(APP_BIN), "mint", "--permissions", "write", "--print-token"])
    if m.returncode != 0:
        die("mint_failed", m.stderr or m.stdout or "mint failed")
    token = (m.stdout or "").strip()
    if not token.startswith("ghs_"):
        die("mint_malformed", "token missing")
    return token


class GhApiError(Exception):
    def __init__(self, code: int, msg: str):
        super().__init__(msg)
        self.code = code


def gh_api(method: str, path: str, token: str, body: object | None = None) -> object:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"https://api.github.com{path}",
        data=data,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "gloops-induct-git-push/1.1",
            "X-GitHub-Api-Version": "2022-11-28",
            **({"Content-Type": "application/json"} if data is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as e:
        raise GhApiError(e.code, f"{method} {path} -> {e.code}: {e.read()[:500]!r}") from e


def push_via_api(cwd: Path, branch: str, token: str) -> dict:
    """App-authored commits via Git Data API (satisfies verified-signature rules)."""
    msg = run(["git", "-C", str(cwd), "log", "-1", "--format=%B"]).stdout or "induct agent commit"
    msg = msg.strip() or "induct agent commit"

    # parent = origin/main tip when available
    parent = ""
    mb = run(["git", "-C", str(cwd), "merge-base", "HEAD", "origin/main"])
    if mb.returncode == 0 and SHA40.fullmatch(mb.stdout.strip().lower()):
        parent = mb.stdout.strip().lower()
    if not parent:
        try:
            ref = gh_api("GET", f"/repos/{ALLOWED_REPO}/git/ref/heads/main", token)
            parent = str(ref["object"]["sha"]).lower()  # type: ignore[index]
        except GhApiError as e:
            die("main_ref_failed", str(e))

    # branch expected head
    try:
        bref = gh_api("GET", f"/repos/{ALLOWED_REPO}/git/ref/heads/{branch}", token)
        expected = str(bref["object"]["sha"]).lower()  # type: ignore[index]
    except GhApiError as e:
        if e.code != 404:
            die("github_api", str(e))
        try:
            gh_api(
                "POST",
                f"/repos/{ALLOWED_REPO}/git/refs",
                token,
                {"ref": f"refs/heads/{branch}", "sha": parent},
            )
            expected = parent
        except GhApiError as e2:
            die("branch_create_failed", str(e2))

    # changed files vs parent
    diff = run(["git", "-C", str(cwd), "diff", "--name-status", f"{parent}..HEAD"])
    lines = [ln for ln in (diff.stdout or "").splitlines() if ln.strip()]
    additions: list[dict[str, str]] = []
    deletions: list[str] = []
    for ln in lines:
        parts = ln.split("\t")
        if len(parts) < 2:
            continue
        status, path = parts[0], parts[1]
        if status.startswith("D"):
            deletions.append(path)
            continue
        if status.startswith("R") and len(parts) >= 3:
            deletions.append(parts[1])
            path = parts[2]
        fp = cwd / path
        if not fp.is_file():
            continue
        raw = fp.read_bytes()
        if len(raw) > 900_000:
            die("file_too_large", f"{path} too large for API commit path")
        additions.append({"path": path, "contents": base64.b64encode(raw).decode("ascii")})

    if not additions and not deletions:
        parent_commit = gh_api("GET", f"/repos/{ALLOWED_REPO}/git/commits/{expected}", token)
        tree_sha = parent_commit["tree"]["sha"]  # type: ignore[index]
        new_commit = gh_api(
            "POST",
            f"/repos/{ALLOWED_REPO}/git/commits",
            token,
            {
                "message": msg,
                "tree": tree_sha,
                "parents": [expected],
                "author": {
                    "name": "gloops-induct-swarm[bot]",
                    "email": "4474467+gloops-induct-swarm[bot]@users.noreply.github.com",
                },
            },
        )
        new_sha = str(new_commit["sha"])  # type: ignore[index]
        gh_api(
            "PATCH",
            f"/repos/{ALLOWED_REPO}/git/refs/heads/{branch}",
            token,
            {"sha": new_sha, "force": False},
        )
        return {
            "ok": True,
            "action": "push_api_empty_commit",
            "branch": branch,
            "head": new_sha,
            "repo": ALLOWED_REPO,
            "method": "git-data-api",
        }

    file_changes: dict = {}
    if additions:
        file_changes["additions"] = [{"path": a["path"], "contents": a["contents"]} for a in additions]
    if deletions:
        file_changes["deletions"] = [{"path": d} for d in deletions]

    query = """
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit { oid url }
      }
    }
    """
    variables = {
        "input": {
            "branch": {"repositoryNameWithOwner": ALLOWED_REPO, "branchName": branch},
            "message": {"headline": (msg.splitlines() or ["induct commit"])[0][:250]},
            "fileChanges": file_changes,
            "expectedHeadOid": expected,
        }
    }
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "gloops-induct-git-push/1.1",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read())
    if payload.get("errors"):
        die("graphql_commit_failed", json.dumps(payload["errors"])[:800])
    oid = (
        payload.get("data", {})
        .get("createCommitOnBranch", {})
        .get("commit", {})
        .get("oid")
    )
    if not oid:
        die("graphql_commit_failed", json.dumps(payload)[:800])
    return {
        "ok": True,
        "action": "push_api_files",
        "branch": branch,
        "head": oid,
        "repo": ALLOWED_REPO,
        "method": "graphql-createCommitOnBranch",
        "filesAdded": len(additions),
        "filesDeleted": len(deletions),
    }


def push(cwd: Path, branch: str) -> dict:
    if not BRANCH_RE.fullmatch(branch) or ".." in branch:
        die("bad_branch", f"invalid branch: {branch}")
    assert_remote_induct(cwd)
    head = run(["git", "-C", str(cwd), "rev-parse", "HEAD"]).stdout.strip().lower()
    if not SHA40.fullmatch(head):
        die("bad_head", "HEAD not full sha")
    token = mint_write_token()
    return push_via_api(cwd, branch, token)


def open_pr(cwd: Path, branch: str, title: str, body: str, base: str = "main") -> dict:
    token = mint_write_token()
    env = dict(os.environ)
    env["GH_TOKEN"] = token
    env["GITHUB_TOKEN"] = token
    cmd = [
        "gh",
        "pr",
        "create",
        "--repo",
        ALLOWED_REPO,
        "--base",
        base,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body or title,
    ]
    p = run(cmd, cwd=cwd, env=env)
    if p.returncode != 0:
        die("pr_failed", (p.stderr or p.stdout or "")[:800])
    url = (p.stdout or "").strip().splitlines()[-1] if p.stdout else ""
    return {"ok": True, "action": "pr", "branch": branch, "url": url, "repo": ALLOWED_REPO}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("push")
    p.add_argument("--cwd", required=True)
    p.add_argument("--branch", required=True)
    pr = sub.add_parser("pr")
    pr.add_argument("--cwd", required=True)
    pr.add_argument("--branch", required=True)
    pr.add_argument("--title", required=True)
    pr.add_argument("--body", default="")
    pr.add_argument("--base", default="main")
    pp = sub.add_parser("push-pr")
    pp.add_argument("--cwd", required=True)
    pp.add_argument("--branch", required=True)
    pp.add_argument("--title", required=True)
    pp.add_argument("--body", default="")
    pp.add_argument("--base", default="main")
    args = ap.parse_args()
    cwd = resolve_cwd(args.cwd)
    if args.cmd == "push":
        print(json.dumps(push(cwd, args.branch), indent=2))
        return 0
    if args.cmd == "pr":
        print(json.dumps(open_pr(cwd, args.branch, args.title, args.body, args.base), indent=2))
        return 0
    if args.cmd == "push-pr":
        out = push(cwd, args.branch)
        out2 = open_pr(cwd, args.branch, args.title, args.body, args.base)
        print(json.dumps({"ok": True, "push": out, "pr": out2}, indent=2))
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
