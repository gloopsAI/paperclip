#!/usr/bin/env python3
"""Induct-only git push + optional PR open (Option A App).

Hermes agents call this from /opt/data/bin/induct-git-push.py (tools mount).
Host-side mint uses root-owned Induct App config; token never printed.

Usage:
  induct-git-push.py push --cwd /opt/data/workspace/induct-main --branch agent/wren/glo-XXXX --message "..."
  induct-git-push.py pr --cwd ... --branch ... --title "..." --body "..."
  induct-git-push.py push-pr --cwd ... --branch ... --message "..." --title "..." [--body "..."]

Fail closed unless:
  - cwd resolves under allowlisted Induct lease roots
  - remote is InductAI/induct
  - Induct App status ok
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ALLOWED_REPO = "InductAI/induct"
ALLOW_ROOTS = (
    "/opt/data/workspace/induct-main",
    "/opt/paperclip/hermes-execution-state/workspace/induct-main",
)
APP_BIN = Path(os.environ.get("INDUCT_GITHUB_APP_BIN", "/usr/local/lib/paperclip-gloops/bin/induct-github-app.py"))
# When running inside hermes container, host tools may not exist — fall back to sibling on host mount
if not APP_BIN.is_file():
    for cand in (
        Path("/usr/local/lib/paperclip-gloops/bin/induct-github-app.py"),
        Path(__file__).resolve().parent.parent / "bin" / "induct-github-app.py",
    ):
        if cand.is_file():
            APP_BIN = cand
            break

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
    ok = False
    for root in ALLOW_ROOTS:
        try:
            p.relative_to(Path(root).resolve() if Path(root).exists() else Path(root))
            ok = True
            break
        except ValueError:
            # also allow worktrees under induct-main
            s = str(p)
            if s.startswith(root.rstrip("/") + "/") or s == root.rstrip("/"):
                ok = True
                break
            if "/induct-main" in s and "/opt/data/workspace/" in s:
                ok = True
                break
    if not ok:
        die("cwd_not_induct_lease", f"cwd {p} not under Induct lease roots {ALLOW_ROOTS}")
    git = run(["git", "-C", str(p), "rev-parse", "--is-inside-work-tree"])
    if git.returncode != 0 or git.stdout.strip() != "true":
        die("cwd_not_git", f"not a git worktree: {p}")
    return p


def assert_remote_induct(cwd: Path) -> None:
    r = run(["git", "-C", str(cwd), "remote", "get-url", "origin"])
    url = (r.stdout or "").strip().lower()
    if "inductai/induct" not in url.replace(".git", ""):
        die("remote_not_induct", f"origin is not InductAI/induct: {url}")


def mint_write_token() -> str:
    if not APP_BIN.is_file():
        die("app_bin_missing", f"missing {APP_BIN}")
    # status first
    st = run(["python3", str(APP_BIN), "status"])
    try:
        status = json.loads(st.stdout or "{}")
    except json.JSONDecodeError:
        die("app_status_unreadable", st.stderr or st.stdout)
    if not status.get("ok"):
        die("app_not_ready", status.get("error") or "induct app status not ok")
    # mint write — print-token only to pipe we capture
    m = run(["python3", str(APP_BIN), "mint", "--permissions", "write", "--print-token"])
    if m.returncode != 0:
        die("mint_failed", m.stderr or m.stdout)
    token = (m.stdout or "").strip()
    if not token.startswith("ghs_"):
        die("mint_malformed", "token missing")
    return token


def push(cwd: Path, branch: str) -> dict:
    if not BRANCH_RE.fullmatch(branch) or ".." in branch:
        die("bad_branch", f"invalid branch: {branch}")
    assert_remote_induct(cwd)
    head = run(["git", "-C", str(cwd), "rev-parse", "HEAD"]).stdout.strip().lower()
    if not SHA40.fullmatch(head):
        die("bad_head", "HEAD not full sha")
    token = mint_write_token()
    # push with one-shot remote URL, then scrub
    auth_url = f"https://x-access-token:{token}@github.com/{ALLOWED_REPO}.git"
    # use env GIT_ASKPASS empty; put URL only in argv for this process
    p = run(["git", "-C", str(cwd), "push", "-u", auth_url, f"HEAD:refs/heads/{branch}"])
    # scrub remote if git set it
    run(["git", "-C", str(cwd), "remote", "set-url", "origin", f"https://github.com/{ALLOWED_REPO}.git"])
    if p.returncode != 0:
        die("push_failed", (p.stderr or p.stdout)[:800])
    return {
        "ok": True,
        "action": "push",
        "branch": branch,
        "head": head,
        "repo": ALLOWED_REPO,
        "remoteBranch": f"refs/heads/{branch}",
    }


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
        die("pr_failed", (p.stderr or p.stdout)[:800])
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
