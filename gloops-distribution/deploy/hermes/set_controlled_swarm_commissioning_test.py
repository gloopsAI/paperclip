from __future__ import annotations

import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("set-controlled-swarm-commissioning.py")
SPEC = importlib.util.spec_from_file_location("commissioning_barrier", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CommissioningBarrierTest(unittest.TestCase):
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
