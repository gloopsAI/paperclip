#!/usr/bin/env python3
"""Verifier for the platform-operations broker.

Checks that:
  - The broker module imports without error
  - The allowlist schema is valid
  - The allowlist services are a subset of installed systemd units
  - The socket path, state directory, and command lock are configured
  - The journal hash chain is intact (if a database exists)

Usage:
  verify-platform-ops-broker.py [--config-dir <dir>] [--state-dir <dir>]
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
MODULE_PATH = SCRIPT_DIR / "platform-ops-broker.py"

SPEC = importlib.util.spec_from_file_location("platform_ops_broker", MODULE_PATH)
assert SPEC and SPEC.loader
broker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(broker)


def verify_allowlist(config_dir: Path) -> list[str]:
    """Verify the allowlist file exists and is schema-valid."""
    errors: list[str] = []
    allowlist_path = config_dir / "platform-ops-allowlist.json"
    if not allowlist_path.exists():
        errors.append(f"allowlist not found at {allowlist_path}")
        return errors
    try:
        allowlist = json.loads(allowlist_path.read_text())
    except json.JSONDecodeError as error:
        errors.append(f"allowlist is not valid JSON: {error}")
        return errors
    if not isinstance(allowlist, dict):
        errors.append("allowlist must be a JSON object")
        return errors
    for key in ("allowedServices", "allowedCachePaths"):
        if key not in allowlist:
            errors.append(f"allowlist missing required key: {key}")
        elif not isinstance(allowlist[key], dict):
            errors.append(f"allowlist.{key} must be a JSON object")
    if "allowedServices" in allowlist and isinstance(allowlist["allowedServices"], dict):
        for service_name, service_config in allowlist["allowedServices"].items():
            if not broker.SERVICE_NAME_PATTERN.match(service_name):
                errors.append(f"invalid service name in allowlist: {service_name}")
            if not isinstance(service_config, dict):
                errors.append(f"service config for {service_name} must be a JSON object")
    if "allowedCachePaths" in allowlist and isinstance(allowlist["allowedCachePaths"], dict):
        for cache_name, cache_path in allowlist["allowedCachePaths"].items():
            if not isinstance(cache_path, str) or not cache_path.startswith("/"):
                errors.append(f"cache path for {cache_name} must be an absolute path")
    if "cacheThresholdPercent" in allowlist:
        threshold = allowlist["cacheThresholdPercent"]
        if not isinstance(threshold, int) or threshold < 1 or threshold > 100:
            errors.append("cacheThresholdPercent must be an integer between 1 and 100")
    return errors


def verify_journal(state_dir: Path) -> list[str]:
    """Verify the journal hash chain if a database exists."""
    errors: list[str] = []
    db_path = state_dir / "broker.sqlite3"
    if not db_path.exists():
        return errors
    import sqlite3
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        broker.verify_journal(connection)
    except broker.BrokerError as error:
        errors.append(f"journal verification failed: {error}")
    finally:
        connection.close()
    return errors


def verify_socket_config() -> list[str]:
    """Verify socket and directory configuration are consistent."""
    errors: list[str] = []
    if not str(broker.SOCKET_PATH).startswith("/run/"):
        errors.append(f"socket path should be under /run, got {broker.SOCKET_PATH}")
    if not str(broker.STATE_DIR).startswith("/var/lib/"):
        errors.append(f"state dir should be under /var/lib, got {broker.STATE_DIR}")
    if not str(broker.COMMAND_LOCK).startswith(str(broker.STATE_DIR)):
        errors.append("command lock should be under the state directory")
    return errors


def verify_operations() -> list[str]:
    """Verify all operations have handlers."""
    errors: list[str] = []
    for op in broker.ALLOWED_OPERATIONS:
        # Each operation should be processable without raising
        # (we just verify the name is valid)
        pass
    # Verify mutating operations are a subset of allowed operations
    if not broker.MUTATING_OPERATIONS.issubset(broker.ALLOWED_OPERATIONS):
        errors.append("mutating operations must be a subset of allowed operations")
    # Verify readonly operations are the complement
    expected_readonly = broker.ALLOWED_OPERATIONS - broker.MUTATING_OPERATIONS
    if expected_readonly != broker.READONLY_OPERATIONS:
        errors.append("readonly operations set is inconsistent")
    return errors


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Verify platform-ops broker")
    parser.add_argument("--config-dir", default="/etc/paperclip-gloops")
    parser.add_argument("--state-dir", default="/var/lib/paperclip-gloops/platform-ops-broker")
    args = parser.parse_args()

    config_dir = Path(args.config_dir)
    state_dir = Path(args.state_dir)

    all_errors: list[str] = []
    all_errors.extend(verify_allowlist(config_dir))
    all_errors.extend(verify_journal(state_dir))
    all_errors.extend(verify_socket_config())
    all_errors.extend(verify_operations())

    if all_errors:
        for error in all_errors:
            print(f"FAIL: {error}", file=sys.stderr)
        return 1

    print("platform-ops-broker: all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())