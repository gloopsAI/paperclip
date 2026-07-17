#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import os
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "live_readiness", HERE / "verify-hermes-handshake-live-readiness.py"
)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LiveReadinessTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.uid = os.getuid()
        self.gid = os.getgid()
        self.root.chmod(0o755)
        for relative in (
            "usr",
            "usr/local",
            "usr/local/lib",
            "usr/local/lib/paperclip-gloops",
            "usr/local/lib/systemd/system",
            "etc/systemd/system",
            "run/systemd/system",
        ):
            path = self.root / relative
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(0o755)
        proxy = self.root / "usr/local/lib/paperclip-gloops/hermes-handshake-egress-proxy.py"
        shutil.copyfile(HERE / "hermes-handshake-egress-proxy.py", proxy)
        proxy.chmod(0o555)
        unit = self.root / f"usr/local/lib/systemd/system/{MODULE.UNIT}"
        shutil.copyfile(HERE / MODULE.UNIT, unit)
        unit.chmod(0o644)
        (self.root / f"etc/systemd/system/{MODULE.UNIT}").symlink_to("/dev/null")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def verify(self) -> None:
        MODULE.verify(self.root, self.uid, self.gid)

    def test_accepts_exact_installed_state(self) -> None:
        self.verify()

    def test_rejects_non_traversable_ancestor(self) -> None:
        ancestor = self.root / "usr/local/lib"
        ancestor.chmod(0o700)
        with self.assertRaisesRegex(MODULE.ReadinessError, "not traversable by DynamicUser"):
            self.verify()

    def test_rejects_stale_installed_unit(self) -> None:
        unit = self.root / f"usr/local/lib/systemd/system/{MODULE.UNIT}"
        unit.write_text(
            unit.read_text().replace(
                "RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK",
                "RestrictAddressFamilies=AF_INET AF_UNIX",
            )
        )
        unit.chmod(0o644)
        with self.assertRaisesRegex(MODULE.ReadinessError, "installed egress unit hash"):
            self.verify()

    def test_rejects_higher_precedence_drop_in(self) -> None:
        (self.root / f"run/systemd/system/{MODULE.UNIT}.d").mkdir()
        with self.assertRaisesRegex(MODULE.ReadinessError, "higher-precedence"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
