#!/usr/bin/env python3
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("verify-current-campaign-commissioning.py")
CAMPAIGN = "supervisor-product-sequence-20260731"
IMAGE = "ghcr.io/gloopsai/paperclip-gloops@sha256:" + "a" * 64
NOW = "2026-07-31T23:20:00Z"


class CurrentCampaignVerifierTest(unittest.TestCase):
    def write_fixture(self, root: Path, *, receipt_overrides=None, epoch_overrides=None):
        auth_dir = root / "auth"; auth_dir.mkdir()
        runtime = root / "runtime.env"; runtime.write_text(
            f"PAPERCLIP_CAMPAIGN_ID={CAMPAIGN}\nPAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true\n"
        )
        image = root / "approved-image"; image.write_text(IMAGE + "\n")
        authorization = {
            "schemaVersion": "gloops.campaign-successor-authorization.v1",
            "authorizationId": "campaign-successor-20260731T211955Z",
            "authorizedAt": "2026-07-31T21:19:55Z",
            "scope": {"authorization": "commission_ollama_only_successor_epoch", "campaignId": CAMPAIGN, "approvedImage": IMAGE, "providerRoute": ["ollama-cloud"]},
        }
        auth_bytes = json.dumps(authorization, sort_keys=True).encode() + b"\n"
        (auth_dir / "current.json").write_bytes(auth_bytes)
        epoch = {"campaignId": CAMPAIGN, "deadlineAt": "2026-08-01T21:39:34Z"}
        epoch.update(epoch_overrides or {})
        epoch_path = root / "epoch.json"; epoch_path.write_text(json.dumps(epoch))
        receipt = {
            "schemaVersion": "gloops.supervisor-operational-closure-commissioning.v2",
            "authorization": "commission_ollama_only_supervisor_closure",
            "campaignId": CAMPAIGN, "approvedImage": IMAGE, "providerRoute": ["ollama-cloud"],
            "workItem": "GLO-9999", "authorizedAt": "2026-07-31T22:00:00Z",
            "authorizationSha256": "sha256:" + hashlib.sha256(auth_bytes).hexdigest(),
        }
        receipt.update(receipt_overrides or {})
        receipt_path = root / "receipt.json"; receipt_path.write_text(json.dumps(receipt))
        return runtime, image, auth_dir, epoch_path, receipt_path

    def invoke(self, *paths):
        runtime, image, auth_dir, epoch, receipt = paths
        return subprocess.run([
            "python3", str(SCRIPT), "--runtime-env", str(runtime), "--approved-image", str(image),
            "--authorization-dir", str(auth_dir), "--epoch-path", str(epoch), "--receipt", str(receipt),
            "--now", NOW, "--skip-ownership-check",
        ], text=True, capture_output=True, check=False)

    def test_accepts_exact_current_campaign_binding(self):
        with tempfile.TemporaryDirectory() as td:
            result = self.invoke(*self.write_fixture(Path(td)))
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_rejects_receipt_bound_to_a_different_work_item_shape(self):
        with tempfile.TemporaryDirectory() as td:
            result = self.invoke(*self.write_fixture(Path(td), receipt_overrides={"workItem": "old-work"}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not bound", result.stdout)

    def test_rejects_expired_epoch(self):
        with tempfile.TemporaryDirectory() as td:
            result = self.invoke(*self.write_fixture(Path(td), epoch_overrides={"deadlineAt": "2026-07-31T22:00:00Z"}))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expired", result.stdout)

    def test_verify_if_successor_accepts_an_inert_successor(self):
        with tempfile.TemporaryDirectory() as td:
            paths = self.write_fixture(Path(td))
            runtime = paths[0]
            runtime.write_text(f"PAPERCLIP_CAMPAIGN_ID={CAMPAIGN}\nPAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false\n")
            result = subprocess.run([
                "python3", str(SCRIPT), "--runtime-env", str(runtime), "--verify-if-successor",
            ], text=True, capture_output=True, check=False)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("remains inert", result.stdout)


if __name__ == "__main__":
    unittest.main()
