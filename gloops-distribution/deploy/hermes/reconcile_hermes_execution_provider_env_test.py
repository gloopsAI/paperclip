#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("reconcile-hermes-execution-provider-env.py")
SPEC = importlib.util.spec_from_file_location("provider_env_reconciler", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ProviderEnvironmentReconciliationTest(unittest.TestCase):
    def test_removes_only_endpoint_override_and_preserves_opaque_assignments(self) -> None:
        opaque = b"API_SERVER_KEY=opaque-value\nOLLAMA_API_KEY=another-opaque-value\n"
        injected = opaque + b"OLLAMA_BASE_URL=network-free-injected-drift\n"

        reconciled, changed = MODULE.reconcile(injected)

        self.assertTrue(changed)
        self.assertEqual(reconciled, opaque)
        self.assertNotIn(b"OLLAMA_BASE_URL", reconciled)

    def test_apply_is_atomic_and_preserves_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "hermes-execution.env"
            opaque = b"API_SERVER_KEY=opaque\nOLLAMA_API_KEY=opaque-too\n"
            env_file.write_bytes(
                opaque + b"OLLAMA_BASE_URL=network-free-injected-drift\n"
            )
            env_file.chmod(0o600)

            result = subprocess.run(
                [sys.executable, SCRIPT, "--env-file", env_file, "--apply"],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(env_file.read_bytes(), opaque)
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
            self.assertNotIn("opaque", result.stdout + result.stderr)

    def test_check_reports_drift_without_mutation_or_value_disclosure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "hermes-execution.env"
            content = b"OLLAMA_BASE_URL=must-not-be-printed\nOLLAMA_API_KEY=also-secret\n"
            env_file.write_bytes(content)

            result = subprocess.run(
                [sys.executable, SCRIPT, "--env-file", env_file],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(env_file.read_bytes(), content)
            self.assertNotIn("must-not-be-printed", result.stdout + result.stderr)
            self.assertNotIn("also-secret", result.stdout + result.stderr)

    def test_duplicate_override_fails_closed(self) -> None:
        with self.assertRaisesRegex(MODULE.ReconciliationError, "duplicate"):
            MODULE.reconcile(b"OLLAMA_BASE_URL=one\nOLLAMA_BASE_URL=two\n")


if __name__ == "__main__":
    unittest.main(verbosity=2)
