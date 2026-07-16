"""Fail-closed transport guard for the isolated provider handshake only.

Hermes normally grants one extra primary-client recovery cycle after its
configured retry ceiling is exhausted.  The certification handshake permits
one total provider transport attempt, so that recovery path must be disabled.

This module is loaded by Python's standard ``sitecustomize`` hook from the
handshake-only ``PYTHONPATH``.  General Hermes execution never mounts it.
"""

from agent import agent_runtime_helpers


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
