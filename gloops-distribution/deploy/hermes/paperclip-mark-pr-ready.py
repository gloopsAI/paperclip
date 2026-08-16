#!/usr/bin/env python3
"""Bind an approved exact PR head to GitHub's protected merge path.

This helper never changes branch protection. It marks a matching draft ready,
arms GitHub auto-merge, and optionally asks GitHub to merge a currently clean
head. Every action is re-read and proven against the expected head/base before
success is reported.
"""
from __future__ import annotations

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

APP_B_ID = "4071335"
INSTALL_ID = 140741582
KEY = Path("/etc/paperclip-gloops/github-app-review/private-key.pem")
GOVERNED_REPOSITORIES = {
    "gloopsAI/paperclip": {"repositoryId": 1299155335, "baseRef": "gloops/stable"},
    "gloopsAI/personal-delegate": {"repositoryId": 1308141485, "baseRef": "main"},
    "gloopsAI/autonomy-strategy": {"repositoryId": 1279656482, "baseRef": "main"},
    "gloopsAI/gloops-paperclip-plugin": {"repositoryId": 1297008772, "baseRef": "main"},
}
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def governed_repository(repo: str, base_ref: str) -> dict[str, object]:
    binding = GOVERNED_REPOSITORIES.get(repo)
    if binding is None or binding["baseRef"] != base_ref:
        raise RuntimeError("repository/base is outside the governed allowlist")
    return binding


def app_b_token(repository_id: int) -> str:
    key = serialization.load_pem_private_key(KEY.read_bytes(), password=None)
    encode = lambda value: base64.urlsafe_b64encode(value).rstrip(b"=")
    now = int(time.time())
    header = encode(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = encode(json.dumps({"iat": now - 30, "exp": now + 300, "iss": APP_B_ID}, separators=(",", ":")).encode())
    signature = key.sign(header + b"." + payload, padding.PKCS1v15(), hashes.SHA256())
    jwt = (header + b"." + payload + b"." + encode(signature)).decode()
    response = gh_api(
        "POST",
        f"/app/installations/{INSTALL_ID}/access_tokens",
        jwt,
        {
            "repository_ids": [repository_id],
            "permissions": {"contents": "write", "pull_requests": "write"},
        },
        bearer=True,
    )
    token = response.get("token") if isinstance(response, dict) else None
    if not isinstance(token, str) or not token:
        raise RuntimeError("GitHub App did not return a repository-scoped token")
    return token


def gh_api(method: str, path: str, token: str, body=None, *, bearer: bool = False):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        "https://api.github.com" + path,
        data=data,
        method=method,
        headers={
            "Authorization": f"{'Bearer' if bearer else 'token'} {token}",
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


def assert_exact_pr(pr: dict, expected_head: str, expected_base: str, expected_base_sha: str) -> None:
    observed_head = str((pr.get("head") or {}).get("sha") or "").lower()
    observed_base = str((pr.get("base") or {}).get("ref") or "")
    observed_base_sha = str((pr.get("base") or {}).get("sha") or "").lower()
    if observed_head != expected_head:
        raise RuntimeError(f"PR head drifted: expected {expected_head}, observed {observed_head or 'missing'}")
    if observed_base != expected_base:
        raise RuntimeError(f"PR base drifted: expected {expected_base}, observed {observed_base or 'missing'}")
    if observed_base_sha != expected_base_sha:
        raise RuntimeError(f"PR base SHA drifted: expected {expected_base_sha}, observed {observed_base_sha or 'missing'}")
    if (pr.get("state") or "").lower() == "closed" and not pr.get("merged"):
        raise RuntimeError("PR is closed without merge")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--auto-merge", action="store_true")
    parser.add_argument("--merge-if-clean", action="store_true")
    args = parser.parse_args()

    expected_head = args.expected_head.lower()
    expected_base_sha = args.base_sha.lower()
    if SHA_RE.fullmatch(expected_head) is None or SHA_RE.fullmatch(expected_base_sha) is None:
        print(json.dumps({"ok": False, "error": "expected head and base must be full lowercase SHAs"}), file=sys.stderr)
        return 1

    token = None
    try:
        binding = governed_repository(args.repo, args.base)
        token = app_b_token(int(binding["repositoryId"]))
        path = f"/repos/{args.repo}/pulls/{args.pr}"
        pr = gh_api("GET", path, token)
        assert_exact_pr(pr, expected_head, args.base, expected_base_sha)
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
            assert_exact_pr(refreshed, expected_head, args.base, expected_base_sha)
            if args.merge_if_clean and refreshed.get("mergeable") is True and not refreshed.get("merged"):
                gh_api("PUT", f"{path}/merge", token, {
                    "merge_method": "squash",
                    "sha": expected_head,
                })
            final = gh_api("GET", path, token)

        assert_exact_pr(final, expected_head, args.base, expected_base_sha)
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
            "baseSha": expected_base_sha,
            "ready": ready,
            "merged": merged,
            "autoMergeArmed": isinstance(auto_merge, dict),
        }, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:400]}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        if token is not None:
            try:
                gh_api("DELETE", "/installation/token", token)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
