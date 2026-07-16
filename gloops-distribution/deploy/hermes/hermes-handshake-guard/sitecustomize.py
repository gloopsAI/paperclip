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

from agent import agent_runtime_helpers
from openai._base_client import AsyncAPIClient, SyncAPIClient


class ProviderAttemptBudgetExhausted(RuntimeError):
    """Raised locally before a second provider transport can begin."""


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


_original_sync_request = SyncAPIClient.request
_original_async_request = AsyncAPIClient.request


def _guarded_sync_request(self: Any, *args: Any, **kwargs: Any) -> Any:
    _claim_provider_attempt()
    return _original_sync_request(self, *args, **kwargs)


async def _guarded_async_request(self: Any, *args: Any, **kwargs: Any) -> Any:
    _claim_provider_attempt()
    return await _original_async_request(self, *args, **kwargs)


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

for _guarded_request in (_guarded_sync_request, _guarded_async_request):
    _guarded_request._paperclip_handshake_guard = True  # type: ignore[attr-defined]
    _guarded_request._paperclip_claim_provider_attempt = _claim_provider_attempt  # type: ignore[attr-defined]

SyncAPIClient.request = _guarded_sync_request
AsyncAPIClient.request = _guarded_async_request
