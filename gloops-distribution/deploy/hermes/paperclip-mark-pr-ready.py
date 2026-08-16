#!/usr/bin/env python3
"""Bind an approved exact PR head to GitHub's protected merge transaction.

This helper never arms delayed auto-merge and never pushes the base ref. It
requires a single-entry ALLGREEN merge queue and the exact App-B review check,
then enqueues the approved head. The review check is projected onto the queue
integration SHA only when its authenticated base commit exactly equals the
reviewed base; any base drift is dequeued and requires a fresh review.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import quote
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
QUEUE_STATE_PATH = Path(
    os.environ.get(
        "PAPERCLIP_MERGE_QUEUE_STATE",
        "/var/lib/paperclip-gloops/exact-merge-queue-attempts.json",
    )
)


def governed_repository(repo: str, base_ref: str) -> dict[str, object]:
    binding = GOVERNED_REPOSITORIES.get(repo)
    if binding is None or binding["baseRef"] != base_ref:
        raise RuntimeError("repository/base is outside the governed allowlist")
    return binding


def require_ci_merge_enabled(environment: dict[str, str] = os.environ) -> None:
    if environment.get("PAPERCLIP_CI_MERGE_ENABLED") != "1":
        raise RuntimeError("CI-to-merge mutation is disabled by kill switch")


def app_b_token(repository_id: int, permissions: dict[str, str]) -> str:
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
            "permissions": permissions,
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
            "X-GitHub-Api-Version": "2026-03-10",
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


def assert_exact_independent_review(
    checks: dict, *, repository_id: int, pull_request_number: int,
    expected_head_sha: str, source_run_id: str, review_run_id: str,
) -> None:
    expected_external_id = (
        f"gloops-ir-v2:{repository_id}:{pull_request_number}:{expected_head_sha}:"
        f"{source_run_id}:{review_run_id}"
    )
    runs = checks.get("check_runs") if isinstance(checks, dict) else None
    if not isinstance(runs, list):
        raise RuntimeError("independent-review check evidence is malformed")
    matching = [
        check for check in runs
        if check.get("name") == "gloops / independent-review"
        and int((check.get("app") or {}).get("id") or 0) == int(APP_B_ID)
        and str(check.get("head_sha") or "").lower() == expected_head_sha
        and check.get("external_id") == expected_external_id
        and check.get("status") == "completed"
        and check.get("conclusion") == "success"
    ]
    if len(matching) != 1:
        raise RuntimeError("exact App-B independent-review check is absent or ambiguous")


def merge_queue_policy(repo: str, base_ref: str, token: str) -> dict:
    encoded = quote(base_ref, safe="")
    try:
        rules = gh_api("GET", f"/repos/{repo}/rules/branches/{encoded}", token)
    except RuntimeError as error:
        raise RuntimeError("merge-queue policy is unproved") from error
    if not isinstance(rules, list):
        raise RuntimeError("merge-queue policy is malformed")
    queue_rules = [rule for rule in rules if isinstance(rule, dict) and rule.get("type") == "merge_queue"]
    check_rules = [rule for rule in rules if isinstance(rule, dict) and rule.get("type") == "required_status_checks"]
    valid_queues = []
    valid_checks = []
    for rule in queue_rules:
        parameters = rule.get("parameters")
        if (
            isinstance(parameters, dict)
            and parameters.get("grouping_strategy") == "ALLGREEN"
            and parameters.get("merge_method") == "SQUASH"
            and parameters.get("max_entries_to_merge") == 1
        ):
            valid_queues.append(rule)
    for rule in check_rules:
        parameters = rule.get("parameters")
        required = parameters.get("required_status_checks") if isinstance(parameters, dict) else None
        if (
            isinstance(parameters, dict)
            and parameters.get("strict_required_status_checks_policy") is True
            and isinstance(required, list)
            and any(
                isinstance(check, dict)
                and check.get("context") == "gloops / independent-review"
                and int(check.get("integration_id") or 0) == int(APP_B_ID)
                for check in required
            )
        ):
            valid_checks.append(rule)
    if len(valid_queues) != 1 or len(valid_checks) != 1:
        raise RuntimeError("single-entry merge queue or exact App-B required check is absent")
    ruleset_ids = {int(rule.get("ruleset_id") or 0) for rule in [*valid_queues, *valid_checks]}
    if 0 in ruleset_ids:
        raise RuntimeError("merge-queue ruleset identity is absent")
    return {"queueRulesetIds": sorted(ruleset_ids)}


def queue_entry(token: str, pull_request_node_id: str) -> dict | None:
    data = graphql(token, """
      query($id: ID!) {
        node(id: $id) {
          ... on PullRequest {
            id
            mergeQueueEntry {
              id state
              baseCommit { oid }
              headCommit { oid }
              pullRequest { id }
            }
          }
        }
      }
    """, {"id": pull_request_node_id})
    node = data.get("node") if isinstance(data, dict) else None
    entry = node.get("mergeQueueEntry") if isinstance(node, dict) else None
    return entry if isinstance(entry, dict) else None


def dequeue_entry(token: str, pull_request_node_id: str, expected_entry_id: str) -> None:
    data = graphql(token, """
      mutation($id: ID!) {
        dequeuePullRequest(input: {id: $id}) { mergeQueueEntry { id } }
      }
    """, {"id": pull_request_node_id})
    removed = (data.get("dequeuePullRequest") or {}).get("mergeQueueEntry")
    if not isinstance(removed, dict) or removed.get("id") != expected_entry_id:
        raise RuntimeError("dequeued merge-queue entry does not match the observed entry")


def queue_attempt_key(binding: dict) -> str:
    return hashlib.sha256(
        json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def load_queue_attempts(path: Path = QUEUE_STATE_PATH) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"schemaVersion": "exact-merge-queue-attempts@1", "attempts": {}}
    if (
        not isinstance(value, dict)
        or value.get("schemaVersion") != "exact-merge-queue-attempts@1"
        or not isinstance(value.get("attempts"), dict)
    ):
        raise RuntimeError("merge-queue attempt state is malformed")
    return value


def save_queue_attempts(value: dict, path: Path = QUEUE_STATE_PATH) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        offset = 0
        while offset < len(payload):
            written = os.write(fd, payload[offset:])
            if written <= 0:
                raise RuntimeError("short write while persisting merge-queue attempt state")
            offset += written
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, path)
    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def ensure_integration_review_check(
    *, repo: str, repository_id: int, pull_request_number: int,
    source_run_id: str, review_run_id: str, expected_base_sha: str,
    expected_head_sha: str, integration_sha: str, queue_entry_id: str,
    token: str,
) -> str:
    binding = {
        "kind": "gloops-independent-review-merge-group-v1",
        "repositoryId": repository_id,
        "repository": repo,
        "pullRequestNumber": pull_request_number,
        "reviewedBaseSha": expected_base_sha,
        "reviewedHeadSha": expected_head_sha,
        "integrationSha": integration_sha,
        "sourceRunId": source_run_id,
        "reviewRunId": review_run_id,
        "queueEntryId": queue_entry_id,
    }
    binding_digest = hashlib.sha256(
        json.dumps(binding, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    external_id = f"gloops-ir-group-v1:{binding_digest}"
    checks = gh_api(
        "GET", f"/repos/{repo}/commits/{integration_sha}/check-runs"
        "?check_name=gloops%20%2F%20independent-review&per_page=100", token,
    )
    runs = checks.get("check_runs") if isinstance(checks, dict) else None
    matches = [
        check for check in (runs if isinstance(runs, list) else [])
        if check.get("name") == "gloops / independent-review"
        and int((check.get("app") or {}).get("id") or 0) == int(APP_B_ID)
        and check.get("head_sha") == integration_sha
        and check.get("external_id") == external_id
        and check.get("status") == "completed"
        and check.get("conclusion") == "success"
    ]
    if len(matches) == 1:
        return external_id
    if matches:
        raise RuntimeError("integration review check is ambiguous")
    created = gh_api("POST", f"/repos/{repo}/check-runs", token, {
        "name": "gloops / independent-review",
        "head_sha": integration_sha,
        "external_id": external_id,
        "status": "completed",
        "conclusion": "success",
        "details_url": f"https://github.com/{repo}/pull/{pull_request_number}",
        "output": {
            "title": "Independent review: exact merge-group projection",
            "summary": (
                f"Original head `{expected_head_sha}` was independently reviewed against "
                f"the exact queue base `{expected_base_sha}`. Queue entry `{queue_entry_id}` "
                f"binds the single-PR integration `{integration_sha}`."
            ),
            "text": "```json\n" + json.dumps(binding, sort_keys=True, indent=2) + "\n```",
        },
    })
    if created.get("external_id") != external_id or created.get("head_sha") != integration_sha:
        raise RuntimeError("integration review check publication is unproved")
    return external_id


def enqueue_exact_merge_group(
    *, queue_token: str, check_token: str, node_id: str, repo: str, repository_id: int,
    pull_request_number: int, expected_base_sha: str, expected_head_sha: str,
    source_run_id: str, review_run_id: str,
) -> dict:
    attempt_binding = {
        "repositoryId": repository_id,
        "repository": repo,
        "pullRequestNumber": pull_request_number,
        "reviewedBaseSha": expected_base_sha,
        "reviewedHeadSha": expected_head_sha,
        "sourceRunId": source_run_id,
        "reviewRunId": review_run_id,
    }
    attempt_key = queue_attempt_key(attempt_binding)
    attempt_state = load_queue_attempts()
    attempts = attempt_state["attempts"]
    entry = queue_entry(queue_token, node_id)
    if entry is None:
        existing = attempts.get(attempt_key)
        if isinstance(existing, dict):
            return {
                "queueEnded": True,
                "priorQueueEntryId": existing.get("queueEntryId"),
                "attemptState": existing.get("state"),
            }
        attempts[attempt_key] = {
            "binding": attempt_binding,
            "state": "reserved",
            "reservedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "queueEntryId": None,
        }
        save_queue_attempts(attempt_state)
        data = graphql(queue_token, """
          mutation($id: ID!, $head: GitObjectID!) {
            enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) {
              mergeQueueEntry { id }
            }
          }
        """, {"id": node_id, "head": expected_head_sha})
        queued = (data.get("enqueuePullRequest") or {}).get("mergeQueueEntry")
        if not isinstance(queued, dict) or not isinstance(queued.get("id"), str):
            raise RuntimeError("GitHub did not return a merge-queue entry")
        attempts[attempt_key]["queueEntryId"] = queued["id"]
        attempts[attempt_key]["state"] = "enqueued"
        save_queue_attempts(attempt_state)
        for _ in range(20):
            entry = queue_entry(queue_token, node_id)
            if entry and (entry.get("baseCommit") or {}).get("oid") and (entry.get("headCommit") or {}).get("oid"):
                break
            time.sleep(0.5)
    if not isinstance(entry, dict):
        raise RuntimeError("merge-queue integration identity is unavailable")
    entry_id = str(entry.get("id") or "")
    base_sha = str((entry.get("baseCommit") or {}).get("oid") or "").lower()
    integration_sha = str((entry.get("headCommit") or {}).get("oid") or "").lower()
    if (entry.get("pullRequest") or {}).get("id") != node_id:
        raise RuntimeError("merge-queue entry is bound to a different pull request")
    existing = attempts.get(attempt_key)
    if not isinstance(existing, dict):
        raise RuntimeError("unreserved merge-queue entry cannot receive review authority")
    if existing.get("queueEntryId") not in (None, entry_id):
        raise RuntimeError("merge-queue entry conflicts with its durable reservation")
    existing["queueEntryId"] = entry_id
    if SHA_RE.fullmatch(integration_sha) is None or not entry_id:
        raise RuntimeError("merge-queue integration identity is malformed")
    if base_sha != expected_base_sha:
        dequeue_entry(queue_token, node_id, entry_id)
        existing["state"] = "dequeued_base_drift"
        existing["observedBaseSha"] = base_sha
        save_queue_attempts(attempt_state)
        raise RuntimeError(
            f"merge-queue base drifted: expected {expected_base_sha}, observed {base_sha or 'missing'}; fresh review required"
        )
    external_id = ensure_integration_review_check(
        repo=repo, repository_id=repository_id,
        pull_request_number=pull_request_number,
        source_run_id=source_run_id, review_run_id=review_run_id,
        expected_base_sha=expected_base_sha, expected_head_sha=expected_head_sha,
        integration_sha=integration_sha, queue_entry_id=entry_id, token=check_token,
    )
    existing["state"] = "integration_review_published"
    existing["queueBaseSha"] = base_sha
    existing["integrationSha"] = integration_sha
    existing["integrationReviewExternalId"] = external_id
    save_queue_attempts(attempt_state)
    return {
        "queueEntryId": entry_id,
        "queueBaseSha": base_sha,
        "integrationSha": integration_sha,
        "integrationReviewExternalId": external_id,
    }


def assert_exact_squash_commit(commit: dict, expected_base_sha: str) -> None:
    parents = commit.get("parents") if isinstance(commit, dict) else None
    if not isinstance(parents, list) or len(parents) != 1:
        raise RuntimeError("merged PR is not an exact squash commit")
    parent = str((parents[0] or {}).get("sha") or "").lower()
    if parent != expected_base_sha:
        raise RuntimeError(
            f"merged PR parent drifted: expected {expected_base_sha}, observed {parent or 'missing'}"
        )


def reconcile_merged_pr(
    *, repo: str, pr: dict, expected_head: str, expected_base: str,
    expected_base_sha: str, token: str,
) -> str:
    if not pr.get("merged"):
        raise RuntimeError("pull request is not merged")
    if str((pr.get("head") or {}).get("sha") or "").lower() != expected_head:
        raise RuntimeError("merged PR head does not match the reviewed head")
    if str((pr.get("base") or {}).get("ref") or "") != expected_base:
        raise RuntimeError("merged PR base ref does not match the reviewed base")
    merge_sha = str(pr.get("merge_commit_sha") or "").lower()
    if SHA_RE.fullmatch(merge_sha) is None:
        raise RuntimeError("merged PR is missing its merge commit SHA")
    commit = gh_api("GET", f"/repos/{repo}/git/commits/{merge_sha}", token)
    assert_exact_squash_commit(commit, expected_base_sha)
    return merge_sha


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pr", type=int, required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--source-run-id", required=True)
    parser.add_argument("--review-run-id", required=True)
    parser.add_argument("--merge-exact", action="store_true")
    args = parser.parse_args()

    expected_head = args.expected_head.lower()
    expected_base_sha = args.base_sha.lower()
    if SHA_RE.fullmatch(expected_head) is None or SHA_RE.fullmatch(expected_base_sha) is None:
        print(json.dumps({"ok": False, "error": "expected head and base must be full lowercase SHAs"}), file=sys.stderr)
        return 1

    tokens: list[str] = []
    try:
        binding = governed_repository(args.repo, args.base)
        check_token = app_b_token(
            int(binding["repositoryId"]),
            {"checks": "write", "contents": "read"},
        )
        tokens.append(check_token)
        path = f"/repos/{args.repo}/pulls/{args.pr}"
        pr = gh_api("GET", path, check_token)
        if not pr.get("merged"):
            assert_exact_pr(pr, expected_head, args.base, expected_base_sha)
        checks = gh_api(
            "GET",
            f"/repos/{args.repo}/commits/{expected_head}/check-runs"
            "?check_name=gloops%20%2F%20independent-review&per_page=100",
            check_token,
        )
        assert_exact_independent_review(
            checks,
            repository_id=int(binding["repositoryId"]),
            pull_request_number=args.pr,
            expected_head_sha=expected_head,
            source_run_id=args.source_run_id,
            review_run_id=args.review_run_id,
        )
        node_id = pr.get("node_id")
        if not node_id:
            raise RuntimeError("pull request is missing its immutable node id")

        mutation_attempted = False
        merge_sha = None
        queue_evidence = None
        policy = None
        if pr.get("merged"):
            final = pr
            merge_sha = reconcile_merged_pr(
                repo=args.repo, pr=pr, expected_head=expected_head,
                expected_base=args.base, expected_base_sha=expected_base_sha, token=check_token,
            )
        else:
            policy = merge_queue_policy(args.repo, args.base, check_token)
            if pr.get("draft"):
                ready_token = app_b_token(
                    int(binding["repositoryId"]),
                    {"contents": "read", "pull_requests": "write"},
                )
                try:
                    graphql(ready_token, """
                      mutation($id: ID!) {
                        markPullRequestReadyForReview(input: {pullRequestId: $id}) {
                          pullRequest { isDraft number }
                        }
                      }
                    """, {"id": node_id})
                finally:
                    try:
                        gh_api("DELETE", "/installation/token", ready_token)
                    except Exception:
                        pass
            refreshed = gh_api("GET", path, check_token)
            assert_exact_pr(refreshed, expected_head, args.base, expected_base_sha)
            if args.merge_exact and refreshed.get("mergeable") is True and refreshed.get("mergeable_state") == "clean":
                require_ci_merge_enabled()
                mutation_attempted = True
                queue_token = app_b_token(
                    int(binding["repositoryId"]),
                    {"contents": "read", "merge_queues": "write"},
                )
                tokens.append(queue_token)
                queue_evidence = enqueue_exact_merge_group(
                    queue_token=queue_token, check_token=check_token,
                    node_id=node_id, repo=args.repo,
                    repository_id=int(binding["repositoryId"]),
                    pull_request_number=args.pr,
                    expected_base_sha=expected_base_sha,
                    expected_head_sha=expected_head,
                    source_run_id=args.source_run_id,
                    review_run_id=args.review_run_id,
                )
                final = gh_api("GET", path, check_token)
                if final.get("merged"):
                    merge_sha = reconcile_merged_pr(
                        repo=args.repo, pr=final, expected_head=expected_head,
                        expected_base=args.base, expected_base_sha=expected_base_sha, token=check_token,
                    )
            else:
                final = refreshed

        if not final.get("merged"):
            assert_exact_pr(final, expected_head, args.base, expected_base_sha)
        ready = final.get("draft") is False
        merged = bool(final.get("merged"))
        queue_ended = bool(
            isinstance(queue_evidence, dict)
            and queue_evidence.get("queueEnded") is True
        )
        if not ready:
            raise RuntimeError("PR did not become ready")
        print(json.dumps({
            "ok": True,
            "pr": args.pr,
            "repo": args.repo,
            "headSha": expected_head,
            "baseRef": args.base,
            "baseSha": expected_base_sha,
            "ready": ready,
            "merged": merged,
            "mergePending": bool(args.merge_exact and not merged and queue_evidence is None),
            "mergeQueued": bool(queue_evidence is not None and not queue_ended and not merged),
            "queueEnded": queue_ended,
            "queueEvidence": queue_evidence,
            "queuePolicy": policy,
            "mutationAttempted": mutation_attempted,
            "mergeCommitSha": merge_sha,
        }, sort_keys=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)[:400]}, sort_keys=True), file=sys.stderr)
        return 1
    finally:
        for token in tokens:
            try:
                gh_api("DELETE", "/installation/token", token)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
