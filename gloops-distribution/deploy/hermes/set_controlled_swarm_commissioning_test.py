from __future__ import annotations

import importlib.util
import fcntl
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("set-controlled-swarm-commissioning.py")
SPEC = importlib.util.spec_from_file_location("commissioning_barrier", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CommissioningBarrierTest(unittest.TestCase):
    def test_idempotent_default_path_skips_host_writer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime.env"
            hostctl = root / "paperclip-hostctl.py"
            invoked = root / "hostctl-invoked"
            runtime.write_text(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                encoding="utf-8",
            )
            hostctl.write_text(
                "#!/bin/sh\n"
                f"touch {str(invoked)!r}\n"
                "exit 73\n",
                encoding="utf-8",
            )
            hostctl.chmod(0o755)

            with (
                mock.patch.object(MODULE, "DEFAULT_RUNTIME_ENV", runtime),
                mock.patch.object(MODULE, "HOSTCTL", hostctl),
                mock.patch.object(MODULE, "HOST_WRITER_LOCK", root / "writer.lock"),
                mock.patch.object(MODULE.os, "geteuid", return_value=0),
                mock.patch.object(sys, "argv", [str(SCRIPT), "false"]),
            ):
                self.assertEqual(MODULE.main(), 0)
            self.assertFalse(
                invoked.exists(),
                "an already-set barrier must not enter the host-writer journal",
            )

    def test_idempotent_check_does_not_bypass_an_active_writer(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = root / "runtime.env"
            hostctl = root / "paperclip-hostctl.py"
            invoked = root / "hostctl-invoked"
            writer_lock = root / "writer.lock"
            runtime.write_text(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                encoding="utf-8",
            )
            hostctl.write_text(
                "#!/bin/sh\n"
                f"touch {str(invoked)!r}\n"
                "exit 73\n",
                encoding="utf-8",
            )
            hostctl.chmod(0o755)

            with writer_lock.open("a+") as held:
                fcntl.flock(held.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                with (
                    mock.patch.object(MODULE, "DEFAULT_RUNTIME_ENV", runtime),
                    mock.patch.object(MODULE, "HOSTCTL", hostctl),
                    mock.patch.object(MODULE, "HOST_WRITER_LOCK", writer_lock),
                    mock.patch.object(MODULE.os, "geteuid", return_value=0),
                    mock.patch.object(sys, "argv", [str(SCRIPT), "false"]),
                ):
                    self.assertEqual(MODULE.main(), 73)
            self.assertTrue(invoked.exists())

    def test_round_trip_is_atomic_and_preserves_mode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.env"
            path.write_text(
                "OTHER=value\nPAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                encoding="utf-8",
            )
            path.chmod(0o640)

            self.assertTrue(MODULE.set_barrier(path, True))
            self.assertIn(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true\n",
                path.read_text(encoding="utf-8"),
            )
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o640)
            self.assertFalse(MODULE.set_barrier(path, True))
            self.assertTrue(MODULE.set_barrier(path, False))
            self.assertIn(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                path.read_text(encoding="utf-8"),
            )

    def test_missing_or_duplicate_barrier_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "runtime.env"
            path.write_text("OTHER=value\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "missing or duplicated"):
                MODULE.set_barrier(path, True)

            path.write_text(
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n"
                "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "missing or duplicated"):
                MODULE.set_barrier(path, True)


if __name__ == "__main__":
    unittest.main()
