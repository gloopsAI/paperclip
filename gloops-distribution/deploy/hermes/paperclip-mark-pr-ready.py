#!/usr/bin/env python3
"""Bind an approved exact PR head to GitHub's protected merge path.

This helper never changes branch protection. It marks a matching draft ready,
arms GitHub auto-merge, and optionally asks GitHub to merge a currently clean
head. Every action is re-read and proven against the expected head/base before
success is reported.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

CANONICAL_REPO = "gloopsAI/paperclip"
GAC_PATH = Path("/usr/local/lib/paperclip-gloops/github-app-credentials.py")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def load_gac():
    spec = importlib.util.spec_from_file_location("gac", GAC_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError("GitHub App credential helper is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gh_api(method: str, path: str, token: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        "https://api.github.com" + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "paperclip-mark-pr-ready",
            **({"Content-Type": "application/json"} if data else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            raw = response.read()
            return {} if not raw else json.loads(raw)
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:300]
        raise RuntimeError(f"GitHub {method} {path} -> {error.code}: {detail}") from error


def graphql(token: str, query: str, variables: dict):
    request = urllib.request.Request(
        "https://api.github.com/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "paperclip-mark-pr-ready",
        },
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        result = json.loads(response.read())
    if result.get("errors"):
        raise RuntimeError("GitHub rejected the protected merge action")
    return result.get("data") or {}


def assert_exact_pr(pr: dict, expected_head: str, expected_base: str) -> None:
    observed_head = str((pr.get("head") or {}).get("sha") or "").lower()
    observed_base = str((pr.get("base") or {}).get("ref") or "")
    if observed_head != expected_head:
        raise RuntimeError(f"PR head drifted: expected {expected_head}, observed {observed_head or 'missing'}")
    if observed_base != expected_base:
        raise RuntimeError(f"PR base drifted: expected {expected_base}, observed {observed_base or 'missing'}")
    if (pr.get("state") or "").lower() == "closed" and not pr.get("merged"):
        raise RuntimeError("PR is closed without merge")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--repo", default=CANONICAL_REPO)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--base", default="gloops/stable")
    parser.add_argument("--auto-merge", action="store_true")
    parser.add_argument("--merge-if-clean", action="store_true")
    args = parser.parse_args()

    expected_head = args.expected_head.lower()
    if args.repo != CANONICAL_REPO:
        print(json.dumps({"ok": False, "error": "repository is outside the canonical allowlist"}), file=sys.stderr)
        return 1
    if SHA_RE.fullmatch(expected_head) is None:
        print(json.dumps({"ok": False, "error": "expected head must be a full lowercase SHA"}), file=sys.stderr)
        return 1

    token = None
    gac = None
    try:
        gac = load_gac()
        token, _expires, _permissions = gac.mint(
            gac.load_config(),
            {"pull_requests": "write", "contents": "write"},
        )
        path = f"/repos/{args.repo}/pulls/{args.pr}"
        pr = gh_api("GET", path, token)
        assert_exact_pr(pr, expected_head, args.base)
        node_id = pr.get("node_id")
        if not node_id:
            raise RuntimeError("pull request is missing its immutable node id")

        if pr.get("merged"):
            final = pr
        else:
            if pr.get("draft"):
                graphql(token, """
                  mutation($id: ID!) {
                    markPullRequestReadyForReview(input: {pullRequestId: $id}) {
                      pullRequest { isDraft number }
                    }
                  }
                """, {"id": node_id})
            if args.auto_merge:
                try:
                    graphql(token, """
                      mutation($id: ID!) {
                        enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH}) {
                          pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
                        }
                      }
                    """, {"id": node_id})
                except RuntimeError:
                    # A repository that can merge immediately may reject an
                    # auto-merge request. The exact clean merge path below is
                    # still governed by the same GitHub protections.
                    if not args.merge_if_clean:
                        raise
            refreshed = gh_api("GET", path, token)
            assert_exact_pr(refreshed, expected_head, args.base)
            if args.merge_if_clean and refreshed.get("mergeable") is True and not refreshed.get("merged"):
                gh_api("PUT", f"{path}/merge", token, {
                    "merge_method": "squash",
                    "sha": expected_head,
                })
            final = gh_api("GET", path, token)

        assert_exact_pr(final, expected_head, args.base)
        ready = final.get("draft") is False
        merged = bool(final.get("merged"))
        auto_merge = final.get("auto_merge")
        if not ready:
            raise RuntimeError("PR did not become ready")
        if args.auto_merge and not merged and not isinstance(auto_merge, dict):
            raise RuntimeError("GitHub did not retain an auto-merge request")
        print(json.dumps({
            "ok": True,
            "pr": args.pr,
            "repo": args.repo,
            "headSha": expected_head,
            "baseRef": args.base,
            "ready": ready,
            "merged": merged,
            "autoMergeArmed": isinstance(auto_merge, dict),
        }, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:400]}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        if token is not None and gac is not None:
            try:
                gac.revoke_value(token)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
