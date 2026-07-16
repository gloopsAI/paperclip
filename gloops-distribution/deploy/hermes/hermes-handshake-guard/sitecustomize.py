"""Fail-closed transport guard for the isolated provider handshake only.

Hermes normally grants one extra primary-client recovery cycle after its
configured retry ceiling is exhausted.  The certification handshake permits
one total provider transport attempt, so that recovery path must be disabled.

This module is loaded by Python's standard ``sitecustomize`` hook from the
handshake-only ``PYTHONPATH``.  General Hermes execution never mounts it.
"""

from __future__ import annotations

import threading
from typing import Any

import httpx
from agent import agent_runtime_helpers


class ProviderAttemptBudgetExhausted(RuntimeError):
    """Raised locally before a second provider transport can begin."""


class ForbiddenProviderTransport(RuntimeError):
    """Raised locally before any non-Ollama remote HTTP request can begin."""


_attempt_lock = threading.Lock()
_provider_attempts = 0


def _claim_provider_attempt() -> None:
    global _provider_attempts

    with _attempt_lock:
        if _provider_attempts >= 1:
            raise ProviderAttemptBudgetExhausted(
                "paperclip handshake permits one total provider attempt",
            )
        _provider_attempts += 1


_original_sync_send = httpx.Client._send_single_request
_original_async_send = httpx.AsyncClient._send_single_request


def _guard_provider_request(request: httpx.Request) -> None:
    if request.url.scheme not in {"http", "https"}:
        return

    host = (request.url.host or "").lower().rstrip(".")
    if host in {"127.0.0.1", "::1", "localhost"}:
        return
    if request.url.scheme != "https" or host != "ollama.com":
        raise ForbiddenProviderTransport(
            f"paperclip handshake forbids remote provider transport to {request.url}",
        )
    _claim_provider_attempt()


def _guarded_sync_send(self: Any, request: httpx.Request) -> httpx.Response:
    _guard_provider_request(request)
    return _original_sync_send(self, request)


async def _guarded_async_send(self: Any, request: httpx.Request) -> httpx.Response:
    _guard_provider_request(request)
    return await _original_async_send(self, request)


def _deny_primary_transport_recovery(
    agent: object,
    api_error: Exception,
    *,
    retry_count: int,
    max_retries: int,
) -> bool:
    """Deny the extra recovery cycle after the single allowed attempt."""

    del agent, api_error, retry_count, max_retries
    return False


_deny_primary_transport_recovery._paperclip_handshake_guard = True  # type: ignore[attr-defined]
agent_runtime_helpers.try_recover_primary_transport = _deny_primary_transport_recovery

for _guarded_send in (_guarded_sync_send, _guarded_async_send):
    _guarded_send._paperclip_handshake_guard = True  # type: ignore[attr-defined]
    _guarded_send._paperclip_guard_provider_request = _guard_provider_request  # type: ignore[attr-defined]

httpx.Client._send_single_request = _guarded_sync_send
httpx.AsyncClient._send_single_request = _guarded_async_send
