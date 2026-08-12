#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { validateHermesRuntimePrivileges } from "./gloops-runtime-policy.mjs";

const manifestPath = new URL(
  "../gloops-distribution/manifest.json",
  import.meta.url,
);
const canonicalPatchDigestTestPath = new URL(
  "../gloops-distribution/scripts/canonical-patch-digest.test.mjs",
  import.meta.url,
);
const dockerfilePath = new URL("../Dockerfile", import.meta.url);
const workflowPath = new URL(
  "../.github/workflows/gloops-distribution.yml",
  import.meta.url,
);
const runtimeEnvPath = new URL(
  "../gloops-distribution/deploy/hermes/runtime.env",
  import.meta.url,
);
const servicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-gloops.service",
  import.meta.url,
);
const controlledSwarmServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-controlled-swarm.service",
  import.meta.url,
);
const handshakeServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-gloops-handshake.service",
  import.meta.url,
);
const installDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/install-dark.sh",
  import.meta.url,
);
const provisionTirithPath = new URL(
  "../gloops-distribution/deploy/hermes/provision-tirith.sh",
  import.meta.url,
);
const hermesExecutionDockerfilePath = new URL(
  "../gloops-distribution/deploy/hermes/Dockerfile.hermes-execution",
  import.meta.url,
);
const patchHermesCommandSecurityPath = new URL(
  "../gloops-distribution/deploy/hermes/patch-hermes-command-security.py",
  import.meta.url,
);
const patchHermesStartupUpdateCheckPath = new URL(
  "../gloops-distribution/deploy/hermes/patch-hermes-startup-update-check.py",
  import.meta.url,
);
const patchHermesStartupUpdateCheckTestPath = new URL(
  "../gloops-distribution/deploy/hermes/patch_hermes_startup_update_check_test.py",
  import.meta.url,
);
const buildHermesExecutionImagePath = new URL(
  "../gloops-distribution/deploy/hermes/build-hermes-execution-image.sh",
  import.meta.url,
);
const verifyHermesCommandSecurityImagePath = new URL(
  "../gloops-distribution/deploy/hermes/verify-hermes-command-security-image.sh",
  import.meta.url,
);
const loadHermesExecutionImagePath = new URL(
  "../gloops-distribution/deploy/hermes/load-hermes-execution-image.sh",
  import.meta.url,
);
const preflightPath = new URL(
  "../gloops-distribution/deploy/hermes/preflight.sh",
  import.meta.url,
);
const waitPaperclipControlPlanePath = new URL(
  "../gloops-distribution/deploy/hermes/wait-paperclip-control-plane.sh",
  import.meta.url,
);
const verifyRuntimeDeadmanPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-runtime-deadman.sh",
  import.meta.url,
);
const verifyDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-dark.sh",
  import.meta.url,
);
const rehearseZeroWorkPath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-zero-work.sh",
  import.meta.url,
);
const verifyCampaignDeadmanPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-campaign-deadman.py",
  import.meta.url,
);
const rehearseCampaignDeadmanPath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-campaign-deadman.py",
  import.meta.url,
);
const activateControlledSwarmPath = new URL(
  "../gloops-distribution/deploy/hermes/activate-controlled-swarm.sh",
  import.meta.url,
);
const activateControlledSwarmRuntimePath = new URL(
  "../gloops-distribution/deploy/hermes/activate-controlled-swarm-runtime.sh",
  import.meta.url,
);
const verifyProductServiceLifecyclePath = new URL(
  "../gloops-distribution/deploy/hermes/verify-product-service-lifecycle.py",
  import.meta.url,
);
const commissionControlledSwarmPath = new URL(
  "../gloops-distribution/deploy/hermes/commission-controlled-swarm.sh",
  import.meta.url,
);
const controlledSwarmCommissionerPath = new URL(
  "../gloops-distribution/deploy/hermes/controlled-swarm-commissioner.py",
  import.meta.url,
);
const rehearseControlledSwarmCommissioningRecoveryPath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-controlled-swarm-commissioning-recovery.py",
  import.meta.url,
);
const controlledSwarmCommissioningRecoveryServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-controlled-swarm-commissioning-recovery.service",
  import.meta.url,
);
const setControlledSwarmCommissioningPath = new URL(
  "../gloops-distribution/deploy/hermes/set-controlled-swarm-commissioning.py",
  import.meta.url,
);
const paperclipHostctlPath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-hostctl.py",
  import.meta.url,
);
const paperclipHostctlTestPath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip_hostctl_test.py",
  import.meta.url,
);
const stopControlledSwarmPath = new URL(
  "../gloops-distribution/deploy/hermes/stop-controlled-swarm.sh",
  import.meta.url,
);
const rollbackPath = new URL(
  "../gloops-distribution/deploy/hermes/rollback.sh",
  import.meta.url,
);
const backupDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/backup-dark.sh",
  import.meta.url,
);
const backupDarkTestPath = new URL(
  "../gloops-distribution/deploy/hermes/backup_dark_test.sh",
  import.meta.url,
);
const verifyRollbackDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-rollback-dark.sh",
  import.meta.url,
);
const rollbackDarkQueryFailureTestPath = new URL(
  "../gloops-distribution/deploy/hermes/rollback_dark_query_failure_test.sh",
  import.meta.url,
);
const hermesExecutionConfigPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-execution-config.yaml",
  import.meta.url,
);
const hermesExecutionPolicyPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-execution-policy.json",
  import.meta.url,
);
const hermesExecutionGhConfigPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-execution-gh-config.yml",
  import.meta.url,
);
const hermesExecutionServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-hermes-execution.service",
  import.meta.url,
);
const prepareHermesExecutionPath = new URL(
  "../gloops-distribution/deploy/hermes/prepare-hermes-execution-profile.sh",
  import.meta.url,
);
const verifyHermesExecutionPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-hermes-execution-profile.sh",
  import.meta.url,
);
const hermesHandshakeConfigPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-handshake-config.yaml",
  import.meta.url,
);
const hermesHandshakePolicyPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-handshake-policy.json",
  import.meta.url,
);
const hermesHandshakeServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-hermes-handshake.service",
  import.meta.url,
);
const prepareHermesHandshakePath = new URL(
  "../gloops-distribution/deploy/hermes/prepare-hermes-handshake-profile.sh",
  import.meta.url,
);
const verifyHermesHandshakePath = new URL(
  "../gloops-distribution/deploy/hermes/verify-hermes-handshake-profile.sh",
  import.meta.url,
);
const installHermesHandshakeEgressPath = new URL(
  "../gloops-distribution/deploy/hermes/install-hermes-handshake-egress.sh",
  import.meta.url,
);
const removeHermesHandshakeEgressPath = new URL(
  "../gloops-distribution/deploy/hermes/remove-hermes-handshake-egress.sh",
  import.meta.url,
);
const inspectHermesHandshakeTopologyPath = new URL(
  "../gloops-distribution/deploy/hermes/inspect-hermes-handshake-topology.sh",
  import.meta.url,
);
const hermesHandshakeCleanupPreflightTestPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes_handshake_cleanup_preflight_test.sh",
  import.meta.url,
);
const rehearseHermesHandshakeEgressFailurePath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-hermes-handshake-egress-failure.sh",
  import.meta.url,
);
const rehearseHandshakeControlPlaneFirewallPath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-handshake-control-plane-firewall.sh",
  import.meta.url,
);
const hermesHandshakeEgressProxyPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-handshake-egress-proxy.py",
  import.meta.url,
);
const hermesHandshakeEgressServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-hermes-handshake-egress.service",
  import.meta.url,
);
const verifyHermesHandshakeLiveReadinessPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-hermes-handshake-live-readiness.py",
  import.meta.url,
);
const verifyHermesHandshakeLiveReadinessTestPath = new URL(
  "../gloops-distribution/deploy/hermes/verify_hermes_handshake_live_readiness_test.py",
  import.meta.url,
);
const verifyHermesHandshakeEgressBoundaryPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-hermes-handshake-egress-boundary.sh",
  import.meta.url,
);
const hermesHandshakeEgressProxyTestPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes_handshake_egress_proxy_test.py",
  import.meta.url,
);
const hermesHandshakeGuardPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-handshake-guard/sitecustomize.py",
  import.meta.url,
);
const restoreHermesWorkspaceObserverPath = new URL(
  "../gloops-distribution/deploy/hermes/restore-hermes-workspace-observer.sh",
  import.meta.url,
);
const githubAppCredentialsPath = new URL(
  "../gloops-distribution/deploy/hermes/github-app-credentials.py",
  import.meta.url,
);
const githubAppConfigPath = new URL(
  "../gloops-distribution/deploy/hermes/github-app.json",
  import.meta.url,
);
const githubAppCredentialsTestPath = new URL(
  "../gloops-distribution/deploy/hermes/github_app_credentials_test.py",
  import.meta.url,
);
const githubPushBrokerPath = new URL(
  "../gloops-distribution/deploy/hermes/github-push-broker.py",
  import.meta.url,
);
const githubPushBrokerTestPath = new URL(
  "../gloops-distribution/deploy/hermes/github_push_broker_test.py",
  import.meta.url,
);
const githubPushToolTestPath = new URL(
  "../gloops-distribution/deploy/hermes/github-push-tool.test.mjs",
  import.meta.url,
);
const registeredPublishPathTestPath = new URL(
  "../gloops-distribution/deploy/hermes/registered_publish_path_test.py",
  import.meta.url,
);
const githubPushBrokerServicePath = new URL(
  "../gloops-distribution/deploy/hermes/paperclip-github-push-broker.service",
  import.meta.url,
);
const stopHermesExecutionPath = new URL(
  "../gloops-distribution/deploy/hermes/stop-hermes-execution.py",
  import.meta.url,
);
const stopHermesExecutionTestPath = new URL(
  "../gloops-distribution/deploy/hermes/stop_hermes_execution_test.py",
  import.meta.url,
);
const verifyLifecycleHistoryPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-lifecycle-history.py",
  import.meta.url,
);
const verifyLifecycleHistoryTestPath = new URL(
  "../gloops-distribution/deploy/hermes/verify_lifecycle_history_test.py",
  import.meta.url,
);
const hermesCronDisabledPath = new URL(
  "../gloops-distribution/deploy/hermes/hermes-cron-disabled/__init__.py",
  import.meta.url,
);
const hermesReferenceCertificationPath = new URL(
  "../gloops-distribution/security/hermes-reference-certification-2026-07-16.json",
  import.meta.url,
);
const hermesReferenceMatrixPath = new URL(
  "../scripts/smoke/hermes-gateway-reference-matrix.sh",
  import.meta.url,
);
const hermesReferenceMockPath = new URL(
  "../scripts/smoke/openai-compatible-reference-mock.mjs",
  import.meta.url,
);
const hermesGatewayE2ePath = new URL(
  "../scripts/smoke/hermes-gateway-e2e.sh",
  import.meta.url,
);
const hermesStartupEgressRootCausePath = new URL(
  "../gloops-distribution/security/hermes-startup-egress-root-cause-2026-07-16.json",
  import.meta.url,
);
const hermesRouteReceiptDir = new URL(
  "../gloops-distribution/deploy/hermes/route-receipt/",
  import.meta.url,
);
const hermesRouteReceiptLockPath = new URL(
  "hermes-source-lock.json",
  hermesRouteReceiptDir,
);
const hermesRouteReceiptPatchPath = new URL(
  "hermes-agent-3c27eb6-route-receipt.patch",
  hermesRouteReceiptDir,
);
const hermesRouteReceiptApplicatorPath = new URL(
  "apply-hermes-route-receipt.py",
  hermesRouteReceiptDir,
);
const hermesRouteReceiptApplicatorTestPath = new URL(
  "apply_hermes_route_receipt_test.py",
  hermesRouteReceiptDir,
);
const hermesRouteReceiptReadmePath = new URL("README.md", hermesRouteReceiptDir);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dockerfile = readFileSync(dockerfilePath, "utf8");
const workflow = readFileSync(workflowPath, "utf8");
const runtimeEnv = readFileSync(runtimeEnvPath, "utf8");
const service = readFileSync(servicePath, "utf8");
const controlledSwarmService = readFileSync(controlledSwarmServicePath, "utf8");
const handshakeService = readFileSync(handshakeServicePath, "utf8");
const installDark = readFileSync(installDarkPath, "utf8");
const provisionTirith = readFileSync(provisionTirithPath, "utf8");
const hermesExecutionDockerfile = readFileSync(hermesExecutionDockerfilePath, "utf8");
const patchHermesCommandSecurity = readFileSync(patchHermesCommandSecurityPath, "utf8");
const patchHermesStartupUpdateCheck = readFileSync(patchHermesStartupUpdateCheckPath, "utf8");
const buildHermesExecutionImage = readFileSync(buildHermesExecutionImagePath, "utf8");
const verifyHermesCommandSecurityImage = readFileSync(verifyHermesCommandSecurityImagePath, "utf8");
const loadHermesExecutionImage = readFileSync(loadHermesExecutionImagePath, "utf8");
const preflight = readFileSync(preflightPath, "utf8");
const waitPaperclipControlPlane = readFileSync(waitPaperclipControlPlanePath, "utf8");
const verifyRuntimeDeadman = readFileSync(verifyRuntimeDeadmanPath, "utf8");
const verifyDark = readFileSync(verifyDarkPath, "utf8");
const rehearseZeroWork = readFileSync(rehearseZeroWorkPath, "utf8");
const verifyCampaignDeadman = readFileSync(verifyCampaignDeadmanPath, "utf8");
const rehearseCampaignDeadman = readFileSync(rehearseCampaignDeadmanPath, "utf8");
const activateControlledSwarm = readFileSync(activateControlledSwarmPath, "utf8");
const activateControlledSwarmRuntime = readFileSync(
  activateControlledSwarmRuntimePath,
  "utf8",
);
const commissionControlledSwarm = readFileSync(commissionControlledSwarmPath, "utf8");
const controlledSwarmCommissioner = readFileSync(controlledSwarmCommissionerPath, "utf8");
const rehearseControlledSwarmCommissioningRecovery = readFileSync(
  rehearseControlledSwarmCommissioningRecoveryPath,
  "utf8",
);
const controlledSwarmCommissioningRecoveryService = readFileSync(
  controlledSwarmCommissioningRecoveryServicePath,
  "utf8",
);
const setControlledSwarmCommissioning = readFileSync(setControlledSwarmCommissioningPath, "utf8");
const paperclipHostctl = readFileSync(paperclipHostctlPath, "utf8");
const stopControlledSwarm = readFileSync(stopControlledSwarmPath, "utf8");
const rehearseZeroWorkExecutable = rehearseZeroWork
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"))
  .join("\n");
const rollback = readFileSync(rollbackPath, "utf8");
const backupDark = readFileSync(backupDarkPath, "utf8");
const verifyRollbackDark = readFileSync(verifyRollbackDarkPath, "utf8");
const hermesRouteReceiptLock = JSON.parse(
  readFileSync(hermesRouteReceiptLockPath, "utf8"),
);
const hermesRouteReceiptPatch = readFileSync(hermesRouteReceiptPatchPath);
const hermesRouteReceiptApplicator = readFileSync(
  hermesRouteReceiptApplicatorPath,
  "utf8",
);
const hermesRouteReceiptReadme = readFileSync(
  hermesRouteReceiptReadmePath,
  "utf8",
);
try {
  execFileSync("python3", [paperclipHostctlTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Paperclip host-writer lock tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [verifyProductServiceLifecyclePath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(
    `Product/campaign service lifecycle verification failed: ${
      error instanceof Error ? error.message : error
    }`,
  );
}
try {
  execFileSync("node", ["--test", canonicalPatchDigestTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Canonical patch digest tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [hermesRouteReceiptApplicatorTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(
    `Hermes route-receipt applicator tests failed: ${
      error instanceof Error ? error.message : error
    }`,
  );
}
try {
  execFileSync("python3", [patchHermesStartupUpdateCheckTestPath.pathname], {
    stdio: "inherit",
  });
} catch {
  fail("Hermes startup update-check patch tests failed");
}

try {
  execFileSync("bash", [rollbackDarkQueryFailureTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Rollback terminal query-failure tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("bash", [backupDarkTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Cold-backup journal guard tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [githubPushBrokerTestPath.pathname], {
    stdio: "inherit",
  });
  execFileSync("node", ["--test", githubPushToolTestPath.pathname], {
    stdio: "inherit",
  });
  execFileSync("python3", [registeredPublishPathTestPath.pathname], {
    stdio: "inherit",
  });
} catch {
  fail("GitHub push broker contract tests failed");
}
const hermesExecutionConfig = readFileSync(hermesExecutionConfigPath, "utf8");
const hermesExecutionPolicy = JSON.parse(readFileSync(hermesExecutionPolicyPath, "utf8"));
const hermesExecutionGhConfig = readFileSync(hermesExecutionGhConfigPath, "utf8");
const hermesExecutionService = readFileSync(hermesExecutionServicePath, "utf8");
const githubPushBroker = readFileSync(githubPushBrokerPath, "utf8");
const githubPushBrokerService = readFileSync(githubPushBrokerServicePath, "utf8");
const prepareHermesExecution = readFileSync(prepareHermesExecutionPath, "utf8");
const verifyHermesExecution = readFileSync(verifyHermesExecutionPath, "utf8");
const hermesHandshakeConfig = readFileSync(hermesHandshakeConfigPath, "utf8");
const hermesHandshakePolicy = JSON.parse(readFileSync(hermesHandshakePolicyPath, "utf8"));
const hermesHandshakeService = readFileSync(hermesHandshakeServicePath, "utf8");
const prepareHermesHandshake = readFileSync(prepareHermesHandshakePath, "utf8");
const verifyHermesHandshake = readFileSync(verifyHermesHandshakePath, "utf8");
const installHermesHandshakeEgress = readFileSync(installHermesHandshakeEgressPath, "utf8");
const removeHermesHandshakeEgress = readFileSync(removeHermesHandshakeEgressPath, "utf8");
const inspectHermesHandshakeTopology = readFileSync(inspectHermesHandshakeTopologyPath, "utf8");
const rehearseHermesHandshakeEgressFailure = readFileSync(rehearseHermesHandshakeEgressFailurePath, "utf8");
const rehearseHandshakeControlPlaneFirewall = readFileSync(rehearseHandshakeControlPlaneFirewallPath, "utf8");
const hermesHandshakeEgressProxy = readFileSync(hermesHandshakeEgressProxyPath, "utf8");
const hermesHandshakeEgressService = readFileSync(hermesHandshakeEgressServicePath, "utf8");
const verifyHermesHandshakeLiveReadiness = readFileSync(verifyHermesHandshakeLiveReadinessPath, "utf8");
const verifyHermesHandshakeEgressBoundary = readFileSync(verifyHermesHandshakeEgressBoundaryPath, "utf8");
try {
  execFileSync("python3", [hermesHandshakeEgressProxyTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Hermes handshake egress proxy tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("bash", [hermesHandshakeCleanupPreflightTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Hermes handshake cleanup preflight tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [verifyHermesHandshakeLiveReadinessTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Hermes handshake live-readiness tests failed: ${error instanceof Error ? error.message : error}`);
}
const hermesHandshakeGuard = readFileSync(hermesHandshakeGuardPath, "utf8");
const restoreHermesWorkspaceObserver = readFileSync(restoreHermesWorkspaceObserverPath, "utf8");
const githubAppCredentials = readFileSync(githubAppCredentialsPath, "utf8");
const stopHermesExecution = readFileSync(stopHermesExecutionPath, "utf8");
const verifyLifecycleHistory = readFileSync(verifyLifecycleHistoryPath, "utf8");
const hermesCronDisabled = readFileSync(hermesCronDisabledPath, "utf8");
const githubAppConfig = JSON.parse(readFileSync(githubAppConfigPath, "utf8"));
try {
  execFileSync("python3", [githubAppCredentialsTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`GitHub App broker unit tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [stopHermesExecutionTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`Hermes stop helper unit tests failed: ${error instanceof Error ? error.message : error}`);
}
try {
  execFileSync("python3", [verifyLifecycleHistoryTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`lifecycle history verifier unit tests failed: ${error instanceof Error ? error.message : error}`);
}
const vexPath = new URL(`../${manifest.buildInputs?.vex ?? ""}`, import.meta.url);
let vex = null;
try {
  vex = JSON.parse(readFileSync(vexPath, "utf8"));
} catch (error) {
  fail(`declared VEX cannot be read: ${error instanceof Error ? error.message : error}`);
}

function fail(message) {
  console.error(`GLoops distribution verification failed: ${message}`);
  process.exitCode = 1;
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitCanonicalDiff(range) {
  return execFileSync(
    "git",
    ["diff", "--no-color", "--full-index", range],
    {
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sha256Hex = /^[0-9a-f]{64}$/u;
const canonicalPatchDigestAlgorithm =
  "git-diff-no-color-full-index-sha256-v1";
const legacyPatchDigests = new Map([
  [
    "real-plugin-host-version",
    "8c475e0aa67fa1cbbfc27dea407402cb0783f5b0f5bcc3a6c92427274451cb22",
  ],
]);
const expectedHermesRouteReceiptFiles = [
  "agent/conversation_loop.py",
  "agent/usage_pricing.py",
  "gateway/platforms/api_server.py",
  "gateway/run_evidence.py",
  "tests/agent/test_usage_pricing.py",
  "tests/gateway/test_api_server_runs.py",
  "tests/gateway/test_run_evidence.py",
  "tests/run_agent/test_run_evidence_capture.py",
];
if (hermesRouteReceiptLock.schemaVersion !== 1) {
  fail("Hermes route-receipt source lock schemaVersion must be 1");
}
if (
  JSON.stringify(hermesRouteReceiptLock.upstream) !==
  JSON.stringify({
    repository: "https://github.com/NousResearch/hermes-agent.git",
    commit: "3c27eb6234bf91b8ceee9e9071591b31e9b148cb",
    tree: "52abdd27375d83d290cab00c1dc98210039b77f4",
    archiveSha256:
      "a68e96f385768ec6c466122bf21fcb697680a5f349c9a673badfbe27752b6928",
  })
) {
  fail("Hermes route-receipt upstream source identity drifted");
}
if (
  hermesRouteReceiptLock.runtimeBaseImage?.wholeImageSourceCommitCertified !== false ||
  hermesRouteReceiptLock.runtimeBaseImage?.overlayTouchedFilesSourceCommitCertified !== true ||
  typeof hermesRouteReceiptLock.runtimeBaseImage?.reference !== "string" ||
  typeof hermesRouteReceiptLock.runtimeBaseImage?.certificationMethod !== "string"
) {
  fail("Hermes route-receipt runtime source-certification boundary drifted");
}
if (
  hermesRouteReceiptLock.overlay?.patch !==
    "hermes-agent-3c27eb6-route-receipt.patch" ||
  !sha256Hex.test(hermesRouteReceiptLock.overlay?.patchSha256 ?? "") ||
  createHash("sha256").update(hermesRouteReceiptPatch).digest("hex") !==
    hermesRouteReceiptLock.overlay.patchSha256
) {
  fail("Hermes route-receipt patch digest or name is inconsistent");
}
if (hermesRouteReceiptPatch.includes("rawPayloadDisposition")) {
  fail("Hermes semantic projection must not claim Paperclip raw-payload disposal");
}
if (
  JSON.stringify(Object.keys(hermesRouteReceiptLock.files ?? {}).sort()) !==
  JSON.stringify([...expectedHermesRouteReceiptFiles].sort())
) {
  fail("Hermes route-receipt touched-file inventory drifted");
}
for (const [relativePath, facts] of Object.entries(
  hermesRouteReceiptLock.files ?? {},
)) {
  if (!sha256Hex.test(facts.postimageSha256 ?? "")) {
    fail(`Hermes route-receipt ${relativePath} lacks a postimage digest`);
  }
  const preimageIsValid =
    facts.preimage === "absent"
      ? facts.preimageSha256 === undefined
      : sha256Hex.test(facts.preimageSha256 ?? "");
  if (!preimageIsValid) {
    fail(`Hermes route-receipt ${relativePath} has an invalid preimage`);
  }
}
for (const required of [
  "verify_upstream_identity",
  "--source-archive",
  "archiveSha256",
  "JOURNAL_SCHEMA",
  "recover_transaction",
  "fsync_directory",
  "patch/source-lock file inventories differ",
  "symlink targets are not allowed",
  "exact hunk mismatch",
  "rendered postimage digest mismatch",
]) {
  if (!hermesRouteReceiptApplicator.includes(required)) {
    fail(`Hermes route-receipt applicator lacks guard: ${required}`);
  }
}
for (const required of [
  "downstream GLoops Gate 2.25 overlay",
  "Ollama Cloud subscription route",
  "one crash-recoverable transaction",
  "rawPayloadDisposition=not_retained",
]) {
  if (!hermesRouteReceiptReadme.includes(required)) {
    fail(`Hermes route-receipt README lacks contract: ${required}`);
  }
}

function verifyHermesReferenceReceipt(summaryResult) {
  const label = summaryResult?.label ?? "unknown";
  const relativePath = summaryResult?.rawReceipt;
  if (typeof relativePath !== "string" || !relativePath.startsWith("gloops-distribution/security/evidence/")) {
    fail(`${label}: raw receipt must be a committed security evidence path`);
    return;
  }
  const receiptPath = new URL(`../${relativePath}`, import.meta.url);
  let raw;
  try {
    raw = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    fail(`${label}: raw receipt cannot be read: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (sha256File(receiptPath) !== summaryResult.rawReceiptSha256) {
    fail(`${label}: raw receipt digest does not match the certification summary`);
  }
  if (
    raw.schemaVersion !== "gloops.hermes-reference-matrix.v1" ||
    raw.status !== "passed" ||
    raw.totalRuns !== 20 ||
    raw.passedRuns !== 20 ||
    !Array.isArray(raw.runs) ||
    raw.runs.length !== 20
  ) {
    fail(`${label}: raw receipt must record a passed 20-of-20 matrix`);
    return;
  }
  if (
    !/^[0-9a-f]{40}$/u.test(raw.runtimeSource?.commit ?? "") ||
    raw.runtimeSource?.treeClean !== true ||
    raw.runtimeSource?.observedFrom !== "/api/health serverInfo.git" ||
    summaryResult.sourceCommit !== raw.runtimeSource.commit ||
    summaryResult.sourceTreeClean !== true
  ) {
    fail(`${label}: runtime source must be an exact clean commit reproduced by the summary`);
  }
  const boundary = raw.boundary ?? {};
  if (
    boundary.disposableCompanyPerRun !== true ||
    boundary.localTrustedRequired !== true ||
    boundary.productionPortRejected !== true ||
    boundary.realProviderCredentialsRejected !== true
  ) {
    fail(`${label}: raw receipt is missing deterministic boundary attestations`);
  }
  const labels = new Set();
  const companyIds = new Set();
  const durations = [];
  for (const run of raw.runs) {
    const cleanup = run?.cleanup ?? {};
    const claimedKeyProof = run?.claimedKeyProof ?? {};
    if (
      run?.result !== "passed" ||
      run?.e2ePassed !== true ||
      claimedKeyProof.readableByUid10001 !== true ||
      claimedKeyProof.mode !== "600" ||
      claimedKeyProof.owner !== "10001:10001" ||
      cleanup.companyAbsent !== true ||
      cleanup.containerAbsent !== true ||
      cleanup.stateAbsent !== true ||
      cleanup.claimedKeyAbsent !== true
    ) {
      fail(`${label}: every run must pass E2E and all four cleanup assertions`);
    }
    if (labels.has(run.label) || companyIds.has(run.companyId)) {
      fail(`${label}: run labels and disposable company ids must be unique`);
    }
    labels.add(run.label);
    companyIds.add(run.companyId);
    if (!Number.isInteger(run.durationSeconds) || run.durationSeconds < 0) {
      fail(`${label}: every run must record a non-negative integer duration`);
    } else {
      durations.push(run.durationSeconds);
    }
  }
  if (durations.length !== 20) return;
  const minimum = Math.min(...durations);
  const maximum = Math.max(...durations);
  const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  if (
    summaryResult.minimumDurationSeconds !== minimum ||
    summaryResult.maximumDurationSeconds !== maximum ||
    summaryResult.averageDurationSeconds !== average ||
    summaryResult.startedAt !== raw.startedAt ||
    summaryResult.completedAt !== raw.completedAt
  ) {
    fail(`${label}: summary statistics do not reproduce from the committed raw receipt`);
  }
}

let hermesReferenceCertification;
try {
  hermesReferenceCertification = JSON.parse(readFileSync(hermesReferenceCertificationPath, "utf8"));
} catch (error) {
  fail(`Hermes reference certification cannot be read: ${error instanceof Error ? error.message : error}`);
}
if (hermesReferenceCertification) {
  if (hermesReferenceCertification.schemaVersion !== 1) {
    fail("Hermes reference certification schema version must be 1");
  }
  if (!Array.isArray(hermesReferenceCertification.results) || hermesReferenceCertification.results.length !== 2) {
    fail("Hermes reference certification must contain exactly upstream and fork results");
  } else {
    for (const result of hermesReferenceCertification.results) verifyHermesReferenceReceipt(result);
  }
  const certificationInputs = hermesReferenceCertification.inputs ?? {};
  const resultSources = Object.fromEntries(
    hermesReferenceCertification.results.map((result) => [result.label, result.sourceCommit]),
  );
  if (
    resultSources["fork-stable-strict"] !== certificationInputs.gloopsPaperclipCommit ||
    resultSources["upstream-master-strict"] !== certificationInputs.upstreamPaperclipCommit
  ) {
    fail("Hermes reference result runtime commits must match the declared fork and upstream inputs");
  }
  for (const [label, path, expected] of [
    ["reference matrix", hermesReferenceMatrixPath, certificationInputs.matrixScriptSha256],
    ["reference mock", hermesReferenceMockPath, certificationInputs.referenceMockSha256],
    ["Hermes gateway E2E", hermesGatewayE2ePath, certificationInputs.e2eScriptSha256],
  ]) {
    if (sha256File(path) !== expected) {
      fail(`${label}: certification input digest does not match the current source`);
    }
  }
}

let hermesStartupEgressRootCause;
try {
  hermesStartupEgressRootCause = JSON.parse(readFileSync(hermesStartupEgressRootCausePath, "utf8"));
} catch (error) {
  fail(`Hermes startup egress root-cause receipt cannot be read: ${error instanceof Error ? error.message : error}`);
}
if (
  hermesStartupEgressRootCause?.schemaVersion !== 1 ||
  hermesStartupEgressRootCause?.status !== "verified" ||
  hermesStartupEgressRootCause?.attribution?.initiatingSubsystem !==
    "Hermes TUI gateway automatic startup update checker" ||
  hermesStartupEgressRootCause?.remediation?.failClosed !== true ||
  hermesStartupEgressRootCause?.remediation?.unknownOrAlreadyPatchedSourceRejected !== true
) {
  fail("Hermes startup egress root-cause attribution and remediation must be exact");
}

if (manifest.schemaVersion !== 1) fail("schemaVersion must be 1");

const distribution = manifest.distribution ?? {};
if (distribution.stableBranch !== "gloops/stable") {
  fail("stableBranch must be gloops/stable");
}
if (distribution.upstreamMirrorBranch !== "master") {
  fail("upstreamMirrorBranch must be master");
}
if (!/^ghcr\.io\/gloopsai\/[a-z0-9._-]+$/.test(distribution.image ?? "")) {
  fail("image must be an owned lowercase ghcr.io/gloopsai repository");
}
if (!/^sha256:[0-9a-f]{64}$/.test(distribution.digest ?? "")) {
  fail("distribution digest must be an immutable SHA-256 digest");
}
if (!/^\d{4}\.\d{3}\.\d+-gloops\.\d+$/.test(distribution.version ?? "")) {
  fail("distribution version must use YYYY.DDD.PATCH-gloops.REVISION");
}

const upstream = manifest.upstream ?? {};
if (upstream.repository !== "https://github.com/paperclipai/paperclip.git") {
  fail("upstream repository is not canonical");
}

const buildInputs = manifest.buildInputs ?? {};
if (!/^node:[^@]+@sha256:[0-9a-f]{64}$/.test(buildInputs.baseImage ?? "")) {
  fail("baseImage must be pinned by SHA-256 digest");
}
if (buildInputs.runtimeTarget !== "gloops-production") {
  fail("runtimeTarget must be the control-plane-only gloops-production stage");
}
if (!Array.isArray(buildInputs.bundledAgentClis) || buildInputs.bundledAgentClis.length !== 0) {
  fail("the GLoops control-plane image must not bundle agent CLIs");
}
if (buildInputs.vex !== `gloops-distribution/security/vex-${distribution.version}.json`) {
  fail("buildInputs.vex must name the versioned distribution VEX");
}
const gloopsStage = dockerfile.match(
  /FROM node:[^\n]+ AS gloops-production([\s\S]+)$/,
);
if (!gloopsStage) {
  fail("Dockerfile must define the gloops-production runtime stage");
} else {
  for (const forbidden of [
    "@anthropic-ai/claude-code",
    "@openai/codex",
    "opencode-ai",
    "@google/gemini-cli",
  ]) {
    if (gloopsStage[1].includes(forbidden)) {
      fail(`gloops-production must not install ${forbidden}`);
    }
  }
  if (!gloopsStage[1].includes('CMD ["node", "dist/index.js"]')) {
    fail("gloops-production must run the compiled server without a TypeScript loader");
  }
  if (!/ARG USER_UID=995\s+ARG USER_GID=985/.test(gloopsStage[1])) {
    fail("gloops-production image identity must match the Hermes runtime UID/GID");
  }
  if (!/apt-get install[^\n]+locales/.test(gloopsStage[1]) || !/locale-gen en_US\.UTF-8/.test(gloopsStage[1])) {
    fail("gloops-production must include the locale required by restored embedded Postgres clusters");
  }
  if (!/apt-get install[^\n]+openssh-client/.test(gloopsStage[1])) {
    fail("gloops-production must include the SSH client required by remote execution environments");
  }
  // Workspace validation (Hermes canary and git-sensitive adapters) spawns `git`
  // in the control-plane container; ENOENT becomes workspace_validation_failed.
  if (!/apt-get install[^\n]+\bgit\b/.test(gloopsStage[1])) {
    fail("gloops-production must include the git binary required by workspace validation");
  }
  if (!/command -v git/.test(gloopsStage[1]) || !/git --version/.test(gloopsStage[1])) {
    fail("gloops-production must assert at image build time that git is present and executable");
  }
}
if (!dockerfile.includes("node scripts/prepare-gloops-runtime.mjs")) {
  fail("Dockerfile must prepare compiled workspace packages for the GLoops runtime");
}
if (!dockerfile.includes("await prepareEmbeddedPostgresNativeRuntime();")) {
  fail("Dockerfile must prepare embedded Postgres shared-library aliases before read-only launch");
}
if (!/^\s+target: gloops-production$/m.test(workflow)) {
  fail("distribution workflow must build the gloops-production target");
}
if (/\b(CLAUDE_CODE|CODEX|OPENCODE|GEMINI_CLI)_VERSION=/m.test(workflow)) {
  fail("distribution workflow must not pass agent CLI build arguments");
}
if (!gloopsStage?.[1].includes("/usr/local/lib/node_modules/npm")) {
  fail("gloops-production must remove the npm build/package-management toolchain");
}
if (!/^PAPERCLIP_HOME=\/home\/paperclip\/\.paperclip$/m.test(runtimeEnv)) {
  fail("Hermes runtime must point PAPERCLIP_HOME at the writable state mount");
}
if (!/^HOME=\/home\/paperclip$/m.test(runtimeEnv)) {
  fail("Hermes runtime HOME must contain the writable Paperclip state mount");
}
if (!/^PAPERCLIP_CONFIG=\/home\/paperclip\/\.paperclip\/instances\/default\/config\.json$/m.test(runtimeEnv)) {
  fail("Hermes runtime must load the persisted instance configuration from the state mount");
}
if (!/^PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false$/m.test(runtimeEnv)) {
  fail("release distribution must clear the release-pin activation interlock");
}
if (!/^PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS=89ed0964-d918-4fcc-b830-5be49d2d4089$/m.test(runtimeEnv)) {
  fail("release distribution must freeze the exact GLoops company backlog");
}
if (!/^PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=$/m.test(runtimeEnv)) {
  fail("release distribution must not readmit any issue without a separately reviewed resource budget");
}
if (!/^PAPERCLIP_CONTROLLED_SWARM_READMIT_WORK_ITEM_IDS=$/m.test(runtimeEnv)) {
  fail("release distribution must not readmit any controlled-swarm work item by default");
}
if (!/^HEARTBEAT_SCHEDULER_ENABLED=false$/m.test(runtimeEnv) ||
    !preflight.includes("[HEARTBEAT_SCHEDULER_ENABLED]='false'")) {
  fail("inert activation must keep the global heartbeat scheduler disabled in both runtime and preflight");
}
if (!preflight.includes("[PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS]='89ed0964-d918-4fcc-b830-5be49d2d4089'")) {
  fail("activation preflight must bind the exact frozen GLoops company");
}
if (!preflight.includes('"/usr/local/lib/paperclip-gloops/verify-backlog-readmit-window.py"')) {
  fail("activation preflight must run the single-UUID backlog readmit verifier");
}
if (!installDark.includes('verify-backlog-readmit-window.py')) {
  fail("dark installer must install the single-UUID backlog readmit verifier");
}
if (!service.includes("src=/home/paperclip/.paperclip,dst=/home/paperclip/.paperclip")) {
  fail("Hermes service must mount the persisted Paperclip home at the runtime home path");
}
if (!service.includes("--user 995:985")) {
  fail("Hermes service UID/GID must match the GLoops image identity");
}
if (!service.includes("--network paperclip-execution")) {
  fail("Paperclip and Hermes must share the named execution network");
}
if (!service.includes("ExecStartPost=/usr/local/lib/paperclip-gloops/wait-paperclip-control-plane.sh")) {
  fail("Paperclip systemd readiness must wait for container health");
}
if (!service.includes("TimeoutStopSec=100")) {
  fail("Paperclip stop budget must cover secret clearing, token revocation, and graceful container shutdown");
}
const refreshProjectorIndex = service.indexOf(
  "ExecStartPre=/usr/local/lib/paperclip-gloops/github-app-credentials.py refresh-projector",
);
const paperclipPreflightIndex = service.indexOf(
  "ExecStartPre=/usr/local/lib/paperclip-gloops/preflight.sh",
);
if (
  refreshProjectorIndex < 0 ||
  paperclipPreflightIndex < 0 ||
  refreshProjectorIndex > paperclipPreflightIndex
) {
  fail("Paperclip must mint the projector role before live preflight so failed activation can archive a complete credential lifecycle");
}
for (const required of [
  "HEARTBEAT_SCHEDULER_ENABLED=false",
  "PAPERCLIP_EXECUTION_RECOVERY_DRIVER_ENABLED=false",
  "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
  "PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false",
  "PAPERCLIP_MTE_ENABLED=false",
  "issue_recovery_actions",
  "agent_wakeup_requests",
  'plugin_jobs, plugin_job_runs, "',
  "repository_mutation_receipts IN ACCESS EXCLUSIVE MODE",
  "persistent Hermes session could auto-resume",
  "iptables -I DOCKER-USER 1",
  "iptables -L DOCKER-USER -v -n -x",
  "paperclip-execution must have IPv6 disabled for exact egress accounting",
  "zero-work rehearsal attempted ${blocked_packets:-unknown} external network packet(s)",
  "zero-work rehearsal created persistent Hermes session state",
  "timeout --signal=TERM --kill-after=5s 180s docker exec",
  "IN ACCESS EXCLUSIVE MODE",
  "evidence_pid=$!",
  "kill -0 \"${evidence_pid}\"",
  '"${LIB_DIR}/github-app-credentials.py" clear-projector',
  '"${LIB_DIR}/verify-hermes-execution-profile.sh" --live',
  "systemctl daemon-reload",
  "verify-dark.sh",
]) {
  if (!rehearseZeroWorkExecutable.includes(required)) {
    fail(`zero-work rehearsal is missing ${required}`);
  }
}
for (const required of [
  'socket.getaddrinfo("github.com", 443)',
  '("1.1.1.1", 443, "direct Internet")',
  '("172.30.241.1", 22, "non-proxy host access")',
  'CONNECT github.com:443 HTTP/1.1',
  'response.startswith(b"HTTP/1.1 403")',
]) {
  if (!verifyHermesHandshakeEgressBoundary.includes(required)) {
    fail(`Hermes handshake executable negative egress proof is missing ${required}`);
  }
}
for (const [surface, content, required] of [
  ["deadman verifier", verifyCampaignDeadman, "--wait-seconds"],
  ["deadman verifier", verifyCampaignDeadman, "wait_for_status"],
  ["deadman verifier", verifyCampaignDeadman, "DeadmanVerificationError"],
  ["zero-work rehearsal", rehearseZeroWorkExecutable, "--require-status unarmed"],
  ["live preflight", preflight, "--wait-seconds 15"],
  ["deadman rehearsal", rehearseCampaignDeadman, "--logical-duration-seconds"],
  ["deadman rehearsal", rehearseCampaignDeadman, "module.validate_duration_seconds("],
  ["deadman rehearsal", rehearseCampaignDeadman, "duration is not sanctioned"],
  ["deadman rehearsal", rehearseCampaignDeadman, "productionEpochCreated"],
  ["deadman rehearsal", rehearseCampaignDeadman, "providersInvoked"],
  ["controlled-swarm activation", activateControlledSwarm, "CONTROLLED_SWARM_ACTIVATION_APPROVED"],
  ["controlled-swarm activation", activateControlledSwarm, "no recent exact-artifact deadman rehearsal receipt exists"],
  ["controlled-swarm activation", activateControlledSwarm, "PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false"],
  ["controlled-swarm activation", activateControlledSwarm, "controlled-swarm approval is stale, malformed, or artifact-mismatched"],
  ["controlled-swarm activation", activateControlledSwarm, "inert activation unexpectedly armed the campaign epoch"],
  ["controlled-swarm activation", activateControlledSwarm, "inert activation requires the execution-commissioning barrier"],
  ["controlled-swarm activation", activateControlledSwarm, "--require-status unarmed"],
  ["controlled-swarm activation runtime delegation", activateControlledSwarm, '"${LIB_DIR}/activate-controlled-swarm-runtime.sh"'],
  ["controlled-swarm commissioning wrapper", commissionControlledSwarm, "controlled-swarm-commissioner.py"],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "CONTROLLED_SWARM_COMMISSIONING_APPROVED"],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "commission_twelve_ollama_roles"],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "the company roster is not the exact authorized 16 identities"],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "has drifted from the exact paused charter"],
  ["controlled-swarm compact charter", controlledSwarmCommissioner, "def compact_instructions(name: str) -> str:"],
  ["controlled-swarm compact charter receipt", controlledSwarmCommissioner, '"instructionSet": instruction_receipt'],
  ["controlled-swarm compact charter journal", controlledSwarmCommissioner, "gloops.controlled-swarm-rollback-journal.v2"],
  ["controlled-swarm phase journal", controlledSwarmCommissioner, "ROLLBACK_JOURNAL_PHASES"],
  ["controlled-swarm idempotent recovery", controlledSwarmCommissioner, "def recover(self) -> bool:"],
  ["controlled-swarm compact charter durable journal", controlledSwarmCommissioner, "os.fsync(output.fileno())"],
  ["controlled-swarm compact charter durable journal", controlledSwarmCommissioner, "self._fsync_directory(path.parent)"],
  ["controlled-swarm compact charter rollback", controlledSwarmCommissioner, "self._rollback_from_journal(token)"],
  ["controlled-swarm effective runtime fence", controlledSwarmCommissioner, "def _fence_effective_runtime(self) -> None:"],
  ["controlled-swarm effective runtime stop", controlledSwarmCommissioner, "self.platform.stop_paperclip()"],
  ["controlled-swarm gateway authentication", controlledSwarmCommissioner, '"binding": "per-agent-secret-ref"'],
  ["controlled-swarm gateway route evidence", controlledSwarmCommissioner, "SIDECAR_ROUTE_EVIDENCE"],
  ["controlled-swarm compact charter receipt preflight", preflight, "--verify-receipt"],
  ["controlled-swarm compact charter live verification", controlledSwarmService, "--verify-live-if-commissioned"],
  ["controlled-swarm interrupted transaction install guard", installDark, "unresolved commissioning rollback journal"],
  ["controlled-swarm recovery service install", installDark, "paperclip-controlled-swarm-commissioning-recovery.service"],
  ["controlled-swarm recovery rehearsal install", installDark, "rehearse-controlled-swarm-commissioning-recovery.py"],
  ["controlled-swarm interrupted transaction dark guard", verifyDark, "commissioning-rollback.json"],
  ["controlled-swarm recovery service dark mask", verifyDark, "paperclip-controlled-swarm-commissioning-recovery.service is masked"],
  ["controlled-swarm recovery boot enable", activateControlledSwarmRuntime, '"${SYSTEMCTL}" enable "${COMMISSIONING_RECOVERY}"'],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=true"],
  ["controlled-swarm commissioning", controlledSwarmCommissioner, "commissioning unexpectedly armed the campaign epoch"],
  ["controlled-swarm commissioning rollback", controlledSwarmCommissioner, "self.platform.set_barrier(False)"],
  ["controlled-swarm recovery wrapper delegation", commissionControlledSwarm, "systemctl start --wait"],
  ["controlled-swarm recovery wrapper unit", commissionControlledSwarm, "paperclip-controlled-swarm-commissioning-recovery.service"],
  ["controlled-swarm recovery service root identity", controlledSwarmCommissioningRecoveryService, "User=root"],
  ["controlled-swarm recovery service orphan condition", controlledSwarmCommissioningRecoveryService, "ConditionPathExists=/var/lib/paperclip-gloops/controlled-swarm/commissioning-rollback.json"],
  ["controlled-swarm recovery service bounded entrypoint", controlledSwarmCommissioningRecoveryService, "--recover-interrupted"],
  ["controlled-swarm recovery rehearsal SIGKILL", rehearseControlledSwarmCommissioningRecovery, "os.WTERMSIG(status) != 9"],
  ["controlled-swarm recovery rehearsal receipt", rehearseControlledSwarmCommissioningRecovery, "controlled-swarm-commissioning-recovery-rehearsal.v1"],
  ["controlled-swarm recovery rehearsal corrupt refusal", rehearseControlledSwarmCommissioningRecovery, "corruptJournalRefused"],
  ["controlled-swarm recovery rehearsal rollback dark", rehearseControlledSwarmCommissioningRecovery, "rollbackFailureRemainedDark"],
  ["controlled-swarm installed recovery unit proof", rehearseControlledSwarmCommissioningRecovery, "def rehearse_installed_recovery_unit(module: Any)"],
  ["controlled-swarm installed recovery unit receipt", rehearseControlledSwarmCommissioningRecovery, '"systemdUnitExecuted": True'],
  ["controlled-swarm installed recovery phase matrix", rehearseControlledSwarmCommissioningRecovery, '"phaseMatrix": phase_rows'],
  ["controlled-swarm exact wrapper proof", rehearseControlledSwarmCommissioningRecovery, "def rehearse_exact_installed_wrapper(module: Any)"],
  ["controlled-swarm exact wrapper invocation", rehearseControlledSwarmCommissioningRecovery, '"--rehearsal-crash-after-phase"'],
  ["controlled-swarm exact commissioner SIGKILL claim", rehearseControlledSwarmCommissioningRecovery, '"realHostCommissionerSigkilled": True'],
  ["controlled-swarm exact proof predicate", rehearseControlledSwarmCommissioningRecovery, "def exact_host_proof_passed("],
  ["controlled-swarm exact recovery no-op proof", rehearseControlledSwarmCommissioningRecovery, '"repeatedRecoveryNoOp": True'],
  ["controlled-swarm exact recovery repository boundary", rehearseControlledSwarmCommissioningRecovery, '"repositoriesMutated": False'],
  ["controlled-swarm fail-closed stop-before-barrier helper", rehearseControlledSwarmCommissioningRecovery, "def fail_closed_fence(paths: Any, platform: Any)"],
  ["controlled-swarm fail-closed inactive proof", rehearseControlledSwarmCommissioningRecovery, '"paperclipInactiveBeforeBarrierWrite": True'],
  ["controlled-swarm one-use approval cleanup", rehearseControlledSwarmCommissioningRecovery, "def cleanup_one_use_approvals(paths: Any)"],
  ["controlled-swarm effective unit evidence", rehearseControlledSwarmCommissioningRecovery, "def effective_unit_evidence()"],
  ["controlled-swarm canonical unit digest binding", rehearseControlledSwarmCommissioningRecovery, "EXPECTED_RECOVERY_UNIT_SHA256"],
  ["controlled-swarm loaded unit argv binding", rehearseControlledSwarmCommissioningRecovery, '"loadedExecCommands": loaded_exec_commands'],
  ["controlled-swarm loaded unit security binding", rehearseControlledSwarmCommissioningRecovery, '"loadedSecurityProperties": loaded_security'],
  ["controlled-swarm loaded unit Conditions receipt", rehearseControlledSwarmCommissioningRecovery, '"loadedConditionsRaw": unit_properties["Conditions"]'],
  ["controlled-swarm loaded unit digest", rehearseControlledSwarmCommissioningRecovery, "def loaded_unit_contract_digest("],
  ["controlled-swarm exact stop timeout", controlledSwarmCommissioningRecoveryService, "TimeoutStopSec=180"],
  ["controlled-swarm loaded stop timeout", rehearseControlledSwarmCommissioningRecovery, '"loadedTimeoutStopMicroseconds": loaded_timeout_stop_usec'],
  ["controlled-swarm unique systemd invocation proof", rehearseControlledSwarmCommissioningRecovery, '"invocationId": invocation_id'],
  ["controlled-swarm repository content digest", rehearseControlledSwarmCommissioningRecovery, "def repository_content_digest(repository: Path)"],
  ["controlled-swarm command-specific status proof", rehearseControlledSwarmCommissioningRecovery, "def exec_status_for_argv("],
  ["controlled-swarm one-read credential snapshot", rehearseControlledSwarmCommissioningRecovery, "def credential_history_snapshot()"],
  ["controlled-swarm one-read active receipt", rehearseControlledSwarmCommissioningRecovery, "def protected_json_snapshot("],
  ["controlled-swarm active receipt byte digest", rehearseControlledSwarmCommissioningRecovery, "return raw, payload, sha256_bytes(raw)"],
  ["controlled-swarm duplicate-key rejection", rehearseControlledSwarmCommissioningRecovery, "object_pairs_hook=strict_json_object"],
  ["controlled-swarm non-finite rejection", rehearseControlledSwarmCommissioningRecovery, "parse_constant=reject_json_constant"],
  ["controlled-swarm finite canonical history", rehearseControlledSwarmCommissioningRecovery, "allow_nan=False"],
  ["controlled-swarm credential lifecycle proof", rehearseControlledSwarmCommissioningRecovery, "def credential_lifecycle_evidence("],
  ["controlled-swarm credential exact-prefix proof", rehearseControlledSwarmCommissioningRecovery, "history[:-1] != pre_history"],
  ["controlled-swarm credential broker digest", rehearseControlledSwarmCommissioningRecovery, '"credentialBrokerSha256"'],
  ["controlled-swarm read-only projector permissions", rehearseControlledSwarmCommissioningRecovery, '"contents": "read"'],
  ["controlled-swarm durable credential transition proof", rehearseControlledSwarmCommissioningRecovery, '"durableLifecycleTransition": True'],
  ["controlled-swarm exact revoke argv proof", rehearseControlledSwarmCommissioningRecovery, '"revokeProjectorCommandSucceeded": True'],
  ["controlled-swarm exact topology proof claim", rehearseControlledSwarmCommissioningRecovery, '"gate2ExactTopologyClaimed": exact_host_proven'],
  ["controlled-swarm exact topology outcome", rehearseControlledSwarmCommissioningRecovery, '"exact_host_conjunctive_passed"'],
  ["controlled-swarm split artifact proof label", rehearseControlledSwarmCommissioningRecovery, '"split_artifact_matrix_passed"'],
  ["controlled-swarm source-only proof label", rehearseControlledSwarmCommissioningRecovery, '"source_harness_passed"'],
  ["controlled-swarm commissioning revalidation", controlledSwarmCommissioner, "require_compact_instructions=True"],
  ["controlled-swarm commissioning barrier", setControlledSwarmCommissioning, "commissioning barrier line is missing or duplicated"],
  ["controlled-swarm commissioning barrier", setControlledSwarmCommissioning, "os.replace(temporary, path)"],
  ["host writer controller install", installDark, 'paperclip-hostctl.py" "${LIB_DIR}/paperclip-hostctl.py'],
  ["host writer controller", paperclipHostctl, "fcntl.LOCK_EX | fcntl.LOCK_NB"],
  ["host writer identity journal", paperclipHostctl, '"event": "pre"'],
  ["host writer terminal receipt", paperclipHostctl, '"event": "post"'],
  ["host writer out-of-band guard", paperclipHostctl, "runtime.env hash mismatch refuses mutation"],
  ["commissioning host writer delegation", setControlledSwarmCommissioning, "paperclip-hostctl.py"],
  ["controlled-swarm durable stop handoff", stopControlledSwarm, '"${STOP_ACTUATOR}" operator_requested_stop'],
  ["controlled-swarm stop commissioning barrier", stopControlledSwarm, '"${SET_COMMISSIONING}" false'],
  ["controlled-swarm stop product health", stopControlledSwarm, "systemctl is-active --quiet paperclip-gloops.service"],
]) {
  if (!content.includes(required)) {
    fail(`${surface} is missing ${required}`);
  }
}
if (service.includes("--verify-live-if-commissioned")) {
  fail("general Paperclip service must not own campaign commissioning verification");
}
const recoveryUnitSha256 = createHash("sha256")
  .update(controlledSwarmCommissioningRecoveryService)
  .digest("hex");
const recoveryUnitPin = rehearseControlledSwarmCommissioningRecovery.match(
  /EXPECTED_RECOVERY_UNIT_SHA256\s*=\s*\(\s*"sha256:([0-9a-f]{64})"\s*\)/,
);
if (
  recoveryUnitPin === null
  || recoveryUnitPin[1] !== recoveryUnitSha256
) {
  fail(
    "controlled-swarm rehearsal canonical unit digest does not match the release asset",
  );
}
if (
  controlledSwarmCommissioningRecoveryService.includes(
    "PAPERCLIP_CONTROLLED_SWARM_COMMISSIONED=false",
  )
) {
  fail("controlled-swarm recovery service must fence true persisted state itself");
}
if (
  commissionControlledSwarm.includes(
    'set-controlled-swarm-commissioning.py" false',
  )
) {
  fail("controlled-swarm wrapper must not mask recovery-unit fencing");
}
for (const [surface, content, required] of [
  ["Hermes derivative Dockerfile", hermesExecutionDockerfile, "FROM gloops/hermes-execution:moa-receipt-v2@sha256:fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b"],
  ["Hermes derivative patch", patchHermesCommandSecurity, 'if cfg["tirith_fail_open"]:'],
  ["Hermes derivative patch", patchHermesCommandSecurity, '"action": "block"'],
  ["Hermes startup update patch", patchHermesStartupUpdateCheck, "def prefetch_update_check():"],
  ["Hermes startup update patch", patchHermesStartupUpdateCheck, "return None"],
  ["Hermes derivative Dockerfile", hermesExecutionDockerfile, "COPY hermes-agent-3c27eb6.tar.gz /tmp/hermes-source.tar.gz"],
  ["Hermes derivative Dockerfile", hermesExecutionDockerfile, "--mode source"],
  ["Hermes derivative Dockerfile", hermesExecutionDockerfile, "--source-archive /tmp/hermes-source.tar.gz"],
  ["Hermes derivative builder", buildHermesExecutionImage, "hermes-agent-gloops:v020-route-receipt-v1"],
  ["Hermes derivative builder", buildHermesExecutionImage, "--network none"],
  ["Hermes derivative builder", buildHermesExecutionImage, "--provenance=false"],
  ["Hermes command-security verifier", verifyHermesCommandSecurityImage, "range(security._CRASH_LIMIT)"],
  ["Hermes command-security verifier", verifyHermesCommandSecurityImage, "assert security._circuit_open is True"],
  ["Hermes command-security verifier", verifyHermesCommandSecurityImage, "tirith disabled (circuit breaker, fail-closed)"],
  ["Hermes command-security verifier", verifyHermesCommandSecurityImage, "assert security._install_thread is None"],
  ["Hermes command-security verifier", verifyHermesCommandSecurityImage, "startup update check is disabled"],
  ["runtime deadman verifier", verifyRuntimeDeadman, "--property Type=exec"],
  ["runtime deadman verifier", verifyRuntimeDeadman, "--property RuntimeMaxSec=2"],
  ["runtime deadman verifier", verifyRuntimeDeadman, "result}\" == 'timeout'"],
  ["Hermes image loader", loadHermesExecutionImage, "24bd9079c4594463703fb5a90c0b6b19caec07f8ebd73326fe1828231fec19ef"],
  ["Hermes image loader", loadHermesExecutionImage, "zstd -t"],
  ["Hermes image loader", loadHermesExecutionImage, "docker load"],
  ["dark installer", installDark, '"${SCRIPT_DIR}/route-receipt/hermes-source-lock.json" "${LIB_DIR}/route-receipt/hermes-source-lock.json"'],
  ["cold rollback backup", backupDark, "hermes-execution-cd65e466dcd2878e9618ccb98e217c451a4460d787cf502f07d90ea3b37bc9ec.tar.zst"],
  ["cold rollback backup", backupDark, "sha256sum hermes-execution-*.tar.zst"],
  ["cold rollback backup transaction guard", backupDark, "refuse_unresolved_commissioning"],
  ["cold rollback backup transaction journal", backupDark, "commissioning-rollback.json"],
  ["rollback restore transaction guard", rollback, "refusing rollback restore with an unresolved commissioning rollback journal"],
  ["rollback terminal transaction guard", verifyRollbackDark, "commissioning-rollback.json"],
]) {
  if (!content.includes(required)) {
    fail(`${surface} is missing ${required}`);
  }
}
const cleanupMatch = rehearseZeroWork.match(/cleanup\(\) \{([\s\S]*?)\n\}/);
if (!rehearseZeroWork.includes(
  '"${LIB_DIR}/github-push-broker.py" assert-quiescent',
)) {
  fail("zero-work rehearsal must refuse pending broker recovery work before activation");
}
for (const required of [
  'kill "${evidence_pid}"',
  'systemctl stop "${PAPERCLIP_UNIT}"',
  'systemctl stop "${HERMES_UNIT}"',
  'systemctl stop "${GITHUB_BROKER_UNIT}"',
  "iptables -D DOCKER-USER",
  "failed to remove zero-work egress proof rule",
  'rm -f "${CONFIG_DIR}/ACTIVATION_APPROVED" "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"',
  "systemctl mask \\",
  '"${GITHUB_BROKER_UNIT}"',
  '"${LIB_DIR}/verify-dark.sh"',
]) {
  if (!cleanupMatch?.[1].includes(required)) {
    fail(`zero-work cleanup is missing ${required}`);
  }
}
const trapIndex = rehearseZeroWorkExecutable.indexOf("trap cleanup EXIT");
const egressDenyIndex = rehearseZeroWorkExecutable.indexOf("iptables -I DOCKER-USER 1");
const unmaskIndex = rehearseZeroWorkExecutable.indexOf(
  "systemctl unmask \\",
);
const daemonReloadIndex = rehearseZeroWorkExecutable.indexOf("systemctl daemon-reload", unmaskIndex);
const hermesMarkerIndex = rehearseZeroWorkExecutable.indexOf(
  'install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"',
);
const brokerStartActivationIndex = rehearseZeroWorkExecutable.indexOf(
  'systemctl start "${GITHUB_BROKER_UNIT}"',
  hermesMarkerIndex,
);
const hermesStartActivationIndex = rehearseZeroWorkExecutable.indexOf(
  'systemctl start "${HERMES_UNIT}"',
  brokerStartActivationIndex,
);
const paperclipMarkerIndex = rehearseZeroWorkExecutable.indexOf(
  'install -m 0600 -o root -g root /dev/null "${CONFIG_DIR}/ACTIVATION_APPROVED"',
  hermesStartActivationIndex,
);
const paperclipStartActivationIndex = rehearseZeroWorkExecutable.indexOf(
  'systemctl start "${PAPERCLIP_UNIT}"',
  paperclipMarkerIndex,
);
const lockIndex = rehearseZeroWorkExecutable.indexOf("IN ACCESS EXCLUSIVE MODE");
const clearProjectorIndex = rehearseZeroWorkExecutable.indexOf(
  '"${LIB_DIR}/github-app-credentials.py" clear-projector',
);
const holderIndex = rehearseZeroWorkExecutable.indexOf("evidence_pid=$!");
const stopIndex = rehearseZeroWorkExecutable.indexOf(
  'systemctl stop "${PAPERCLIP_UNIT}"',
  holderIndex,
);
const hermesStopIndex = rehearseZeroWorkExecutable.indexOf(
  'systemctl stop "${HERMES_UNIT}"',
  stopIndex + 1,
);
const inspectIndex = rehearseZeroWorkExecutable.indexOf('node - "${evidence_output}"');
if (
  trapIndex < 0 ||
  egressDenyIndex < 0 ||
  unmaskIndex < 0 ||
  daemonReloadIndex < 0 ||
  hermesMarkerIndex < 0 ||
  brokerStartActivationIndex < 0 ||
  hermesStartActivationIndex < 0 ||
  paperclipMarkerIndex < 0 ||
  paperclipStartActivationIndex < 0 ||
  clearProjectorIndex < 0 ||
  lockIndex < 0 ||
  holderIndex < 0 ||
  stopIndex < 0 ||
  hermesStopIndex < 0 ||
  inspectIndex < 0 ||
  !(
    trapIndex < egressDenyIndex &&
    egressDenyIndex < unmaskIndex &&
    unmaskIndex < daemonReloadIndex &&
    daemonReloadIndex < hermesMarkerIndex &&
    hermesMarkerIndex < brokerStartActivationIndex &&
    brokerStartActivationIndex < hermesStartActivationIndex &&
    hermesStartActivationIndex < paperclipMarkerIndex &&
    paperclipMarkerIndex < paperclipStartActivationIndex &&
    paperclipStartActivationIndex < clearProjectorIndex &&
    clearProjectorIndex < lockIndex &&
    lockIndex < holderIndex &&
    holderIndex < stopIndex &&
    stopIndex < hermesStopIndex &&
    hermesStopIndex < inspectIndex
  )
) {
  fail("zero-work rehearsal activation, evidence-lock, and shutdown command order is invalid");
}
if (!installDark.includes('rehearse-zero-work.sh')) {
  fail("dark installer must install the zero-work rehearsal harness");
}
if (!rehearseZeroWork.includes(
  "select count(*)::int as count from plugin_jobs where created_at >= ${since}",
)) {
  fail("zero-work rehearsal must bound plugin-job registrations to the closed interval");
}
if (!rehearseZeroWork.includes(
  "select count(*)::int as count from repository_mutation_receipts where created_at >= ${since}",
)) {
  fail("zero-work rehearsal must bound repository mutations to the closed interval");
}
for (const required of [
  "VERSION='0.3.3'",
  "ARCHIVE_SHA256='6cdbe35e8f9ccf42e70ad95b501c93cd218ac18201c3df958d54f6ba0d995ce2'",
  "BINARY_SHA256='55a15bbcc726a9021c41be0e823878597560c23fec458ced3b804d1cbce19afe'",
  'https://github.com/sheeki03/tirith/releases/download/v${VERSION}/${ARCHIVE}',
  "curl --fail --location --proto '=https' --tlsv1.2",
  'tar -xOf "${stage}/${ARCHIVE}" tirith',
  'install -m 0555 -o root -g root',
]) {
  if (!provisionTirith.includes(required)) {
    fail(`Tirith provisioner is missing ${required}`);
  }
}
for (const required of [
  "did not become healthy within",
  "\"${CONTAINER}\" == 'paperclip-gloops-handshake'",
  "http://${HANDSHAKE_EXPECTED_IP}:3100/api/health",
  "docker network inspect --format '{{.Internal}}'",
  "docker network inspect --format '{{.Id}}'",
  "docker inspect --format '{{json .NetworkSettings.Networks}}'",
  "docker inspect --format '{{json .NetworkSettings.Ports}}'",
  '.["paperclip-handshake"].NetworkID // empty',
  '.["paperclip-handshake"].IPAddress // empty',
  'keys | sort | join(",")',
  "network_internal=${network_internal:-missing}",
  "container_ip=${container_ip:-missing}",
  "published_bindings=${published_binding_count:-missing}",
  "curl --fail --silent --show-error --max-time 5 --header 'Host: 127.0.0.1'",
  "\"${CONTAINER}\" == 'paperclip-gloops'",
  '.["paperclip-execution"].NetworkID // empty',
  '.["3100/tcp"] as $binding',
  "port_keys=${port_keys:-missing}",
  "exact_loopback_binding=${exact_loopback_binding:-missing}",
  "'http://127.0.0.1:3100/api/health'",
  "command -v jq",
  "unsupported Paperclip control-plane container",
]) {
  if (!waitPaperclipControlPlane.includes(required)) {
    fail(`Paperclip control-plane readiness barrier is missing ${required}`);
  }
}

const hermesExecutionImage =
  "sha256:cd65e466dcd2878e9618ccb98e217c451a4460d787cf502f07d90ea3b37bc9ec";
if (hermesExecutionPolicy.schemaVersion !== "gloops.hermes-execution-profile.v2") {
  fail("Hermes execution policy schema is not pinned");
}
if (
  JSON.stringify(hermesExecutionPolicy.allowedProviders) !==
  JSON.stringify(["ollama-cloud"])
) {
  fail("Hermes bounded-pilot provider allowlist must contain only Ollama Cloud");
}
if (
  JSON.stringify(hermesExecutionPolicy.allowedRuntimeEnvironment) !==
  JSON.stringify(["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "HERMES_OUTBOUND_WEBHOOK_SECRET", "OLLAMA_API_KEY"])
) {
  fail("Hermes execution runtime environment allowlist is not exact");
}
if (
  JSON.stringify(hermesExecutionPolicy.allowedCredentialFiles) !==
    JSON.stringify(["/opt/data/auth.json"]) ||
  JSON.stringify(hermesExecutionPolicy.github) !== JSON.stringify({
    principal: "root-owned-github-app-broker",
    credentialType: "root-owned-unix-socket-broker",
    appId: 4307157,
    installationId: 146796843,
    repositoryId: 1297008772,
    allowedRepositories: ["gloopsAI/gloops-paperclip-plugin"],
    permissions: { contents: "write", metadata: "read" },
    credentialMount: "none",
    maximumLifetimeSeconds: 3600,
    clientSocket: "/run/paperclip-github-broker/broker.sock",
    clientTool: "/opt/data/bin/github-push-tool.bundle.cjs",
    mutationClass: "create_one_branch_ref",
    maxLeases: 1,
    maxMutations: 1,
    branchPattern: "refs/heads/paperclip/<paperclip-run-id>/calibration",
    darkState: "broker-masked-socket-and-authorization-absent",
  }) ||
  !hermesExecutionPolicy.forbiddenProviders?.includes("openai-codex")
) {
  fail("Hermes bounded-pilot GitHub credential and no-fallback boundary is not exact");
}
if (
  !prepareHermesExecution.includes('rm -rf "${PROFILE_DIR}/gh"') ||
  !prepareHermesExecution.includes('rm -f "${PROFILE_DIR}/gitconfig"')
) {
  fail("Hermes profile preparation must remove legacy GitHub credential and config projections");
}
if (
  hermesExecutionPolicy.grok?.mode !== "host-cli-only" ||
  hermesExecutionPolicy.grok?.apiEnvironmentAllowed !== false
) {
  fail("Grok must remain host-CLI-only with API configuration forbidden");
}
if (
  hermesExecutionPolicy.network?.name !== "paperclip-execution" ||
  hermesExecutionPolicy.network?.apiAlias !== "hermes-execution" ||
  hermesExecutionPolicy.network?.apiPort !== 8642 ||
  hermesExecutionPolicy.network?.apiAuthentication !== "bearer-key-required" ||
  JSON.stringify(hermesExecutionPolicy.network?.publishedPorts) !== "[]"
) {
  fail("Hermes inter-container network contract is incomplete");
}
if (hermesExecutionPolicy.runtime?.image !== hermesExecutionImage) {
  fail("Hermes execution image must be immutable and exact");
}
if (hermesExecutionPolicy.runtime?.imageAcquisition !== "root-only-content-addressed-archive") {
  fail("Hermes execution image acquisition must be explicit");
}
if (
  JSON.stringify(hermesExecutionPolicy.runtime?.imageArchive) !==
  JSON.stringify({
    path: "/opt/paperclip/release-artifacts/hermes-execution-cd65e466dcd2878e9618ccb98e217c451a4460d787cf502f07d90ea3b37bc9ec.tar.zst",
    sha256: "24bd9079c4594463703fb5a90c0b6b19caec07f8ebd73326fe1828231fec19ef",
  })
) {
  fail("Hermes execution image archive must be content-addressed and exact");
}
if (
  JSON.stringify(hermesExecutionPolicy.runtime?.commandSecurity) !==
  JSON.stringify({
    scanner: "tirith",
    version: "0.3.3",
    path: "/opt/data/bin/tirith",
    sha256: "55a15bbcc726a9021c41be0e823878597560c23fec458ced3b804d1cbce19afe",
    mount: "read-only",
    autoInstall: false,
    failureMode: "closed",
  })
) {
  fail("Hermes command scanner must be exact, immutable, offline, and fail-closed");
}
if (
  JSON.stringify(hermesExecutionPolicy.runtime?.imageCorrection) !==
  JSON.stringify({
    baseImage: "gloops/hermes-execution:moa-receipt-v2@sha256:fd1f8f68f600f8da0c42a38361d7333a8487015ed04ec5e6bcbed8b4bb9cb00b",
    scope: "v0.20.0-source-overlay-route-receipt-tirith-fail-closed-no-update-check",
    buildNetwork: "none",
    sourceLock: "/usr/local/lib/paperclip-gloops/route-receipt/hermes-source-lock.json",
    behavioralVerification: "63-contract-tests-plus-exact-runtime-projection",
  })
) {
  fail("Hermes execution image correction must be narrow, offline, and behaviorally verified");
}
if (
  JSON.stringify(hermesExecutionPolicy.runtime?.backgroundExecution) !==
  JSON.stringify({
    cronProvider: "disabled",
    kanbanDispatcher: false,
    paperclipPluginScheduler: "empty-tables-locked-and-receipted",
    resumePendingSessions: "empty-directory-precondition",
    zeroWorkEgress: "deny-before-start-with-zero-attempt-counter",
  })
) {
  fail("Hermes and Paperclip background execution containment is not explicit");
}
if (
  !/^model:\n  provider: ollama-cloud\n  default: kimi-k2\.7-code$/m.test(hermesExecutionConfig) ||
  /fallback_providers|openai-codex|chatgpt\.com\/backend-api\/codex/m.test(hermesExecutionConfig)
) {
  fail("Hermes bounded-pilot routing must use Ollama Cloud with no fallback provider");
}
if (
  !/^cron:\n  provider: disabled$/m.test(hermesExecutionConfig) ||
  !/^kanban:\n  dispatch_in_gateway: false$/m.test(hermesExecutionConfig) ||
  !/^security:\n  redact_secrets: true\n  tirith_enabled: true\n  tirith_path: \/opt\/data\/bin\/tirith\n  tirith_fail_open: false$/m.test(hermesExecutionConfig)
) {
  fail("Hermes background execution and command-security policy must be exact");
}
for (const forbidden of ["anthropic", "openrouter", "xai", "grok", "slack", "agentmail", "smtp", "discord", "telegram", "plugins"]) {
  if (hermesExecutionConfig.toLowerCase().includes(forbidden)) {
    fail(`Hermes execution configuration must not include ${forbidden}`);
  }
}
for (const required of [
  "default_preset: ollama-build",
  "provider: moa",
  "model: ollama-build",
  "max_turns: 320",
]) {
  if (!hermesExecutionConfig.includes(required)) {
    fail(`Hermes execution configuration is missing ${required}`);
  }
}
if (
  hermesHandshakePolicy.schemaVersion !== "gloops.hermes-provider-handshake.v1" ||
  JSON.stringify(hermesHandshakePolicy.allowedProviders) !== JSON.stringify(["ollama-cloud"]) ||
  JSON.stringify(hermesHandshakePolicy.allowedRuntimeEnvironment) !== JSON.stringify(["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "OLLAMA_API_KEY", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"]) ||
  JSON.stringify(hermesHandshakePolicy.allowedCredentialFiles) !==
    JSON.stringify(["/opt/handshake-profile/auth.json", "/opt/data/auth.json"]) ||
  JSON.stringify(hermesHandshakePolicy.network) !== JSON.stringify({
    name: "paperclip-handshake",
    internal: true,
    ipv6: false,
    containerDns: "loopback-static-resolv-conf",
    apiAlias: "hermes-execution",
    apiPort: 8642,
    apiAuthentication: "bearer-key-required",
    publishedPorts: [],
    internetEgress: "single-connect-exact-authority-and-tls-sni-proxy",
    proxyAuthority: "ollama.com:443",
    proxyTlsSni: "ollama.com",
    proxyTunnelBudget: 1,
    proxyMaxConnections: 4,
  }) ||
  JSON.stringify(hermesHandshakePolicy.runtime?.persistentPaths) !== "[]" ||
  JSON.stringify(hermesHandshakePolicy.runtime?.repositoryMounts) !== "[]" ||
  hermesHandshakePolicy.runtime?.githubCredentials !== false ||
  hermesHandshakePolicy.runtime?.sessionKeyStrategy !== "none" ||
  JSON.stringify(hermesHandshakePolicy.runtime?.providerInvocationBudget) !==
    JSON.stringify({ maxTurns: 1, maxProviderAttempts: 1, maxApplicationAttempts: 1, maxPrimaryRecoveryAttempts: 0, maxSdkRetries: 0, maxToolCalls: 0, maxWallMs: 900000 })
) {
  fail("Hermes provider-handshake policy must be one-turn, zero-tool, sessionless, and repository-free");
}
for (const required of [
  "platform_toolsets:\n  api_server: []",
  "mcp_servers: {}",
  "max_turns: 1",
  "context_length: 262144",
  "cron:\n  provider: disabled",
  "dispatch_in_gateway: false",
]) {
  if (!hermesHandshakeConfig.includes(required)) {
    fail(`Hermes provider-handshake configuration is missing ${required}`);
  }
}
for (const required of [
  `Environment=HERMES_HANDSHAKE_IMAGE=${hermesExecutionImage}`,
  "--network paperclip-handshake",
  "--ip 172.30.241.3",
  "--dns 127.0.0.1",
  "src=/usr/local/lib/paperclip-gloops/hermes-handshake-resolv.conf,dst=/etc/resolv.conf,readonly",
  "HTTPS_PROXY=http://172.30.241.1:18080",
  "--network-alias hermes-execution",
  "--read-only",
  "--tmpfs /opt/data:rw,noexec,nosuid,nodev,size=128m,uid=10000,gid=10000,mode=0700",
  "--memory 1024m",
  "--memory-swap 1024m",
  "--cpus 1.0",
  "--pids-limit 256",
  "src=/opt/paperclip/hermes-handshake-profile/config.yaml,dst=/opt/handshake-profile/config.yaml,readonly",
  "src=/opt/paperclip/hermes-handshake-profile/auth.json,dst=/opt/handshake-profile/auth.json,readonly",
  "src=/opt/paperclip/hermes-handshake-profile/cron-disabled,dst=/opt/data/plugins/disabled,readonly",
  "--env PYTHONPATH=/opt/paperclip-handshake-guard",
  "src=/usr/local/lib/paperclip-gloops/hermes-handshake-guard/sitecustomize.py,dst=/opt/paperclip-handshake-guard/sitecustomize.py,readonly",
  "h.try_recover_primary_transport._paperclip_handshake_guard",
  "httpx.Client._send_single_request._paperclip_handshake_guard",
  "httpx.AsyncClient._send_single_request._paperclip_handshake_guard",
  "--entrypoint /bin/sh",
  "cp /opt/handshake-profile/config.yaml /opt/data/config.yaml",
  "chmod 0400 /opt/data/config.yaml",
  "chown 10000:10000 /opt/data/config.yaml",
  "cp /opt/handshake-profile/auth.json /opt/data/auth.json",
  "chmod 0600 /opt/data/auth.json",
  "chown 10000:10000 /opt/data/auth.json",
  "Conflicts=paperclip-hermes-execution.service",
  "ExecStartPre=/usr/bin/test ! -e /etc/paperclip-gloops/HERMES_EXECUTION_APPROVED",
  "ExecStartPre=/usr/bin/mv /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE",
  "BindsTo=paperclip-hermes-handshake-egress.service",
  "ExecStopPost=-/usr/bin/rm -f /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE /etc/paperclip-gloops/HERMES_HANDSHAKE_APPROVED",
  "ExecStopPost=+/usr/local/lib/paperclip-gloops/remove-hermes-handshake-egress.sh",
  "RuntimeMaxSec=900",
  "verify-hermes-handshake-profile.sh --live",
]) {
  if (!hermesHandshakeService.includes(required)) {
    fail(`Hermes provider-handshake service is missing ${required}`);
  }
}
for (const required of [
  "readonly NETWORK='paperclip-handshake'",
  "readonly SUBNET='172.30.241.0/29'",
  "readonly HERMES_IP='172.30.241.3'",
  "--internal --attachable",
  "--opt com.docker.network.bridge.name=pc-hshake0",
  "iptables -N \"${INPUT_CHAIN}\"",
  "iptables -I INPUT 1 -s \"${SUBNET}\"",
  "iptables -N \"${FORWARD_CHAIN}\"",
  "iptables -I DOCKER-USER 1 -s \"${SUBNET}\"",
  "paperclip-handshake-control-plane-response",
  "--sport \"${PAPERCLIP_PORT}\"",
  "--ctstate ESTABLISHED,RELATED",
  "paperclip-handshake-host-deny",
  "paperclip-handshake-forward-deny",
  "paperclip-handshake-established",
  "paperclip-handshake-api",
  "-j REJECT --reject-with icmp-port-unreachable",
  "schema=gloops.hermes-handshake-egress.v2",
  "HANDSHAKE_EGRESS_ACTIVE",
]) {
  if (!installHermesHandshakeEgress.includes(required)) {
    fail(`Hermes handshake egress installer is missing ${required}`);
  }
}
for (const forbidden of ["getent", "ollama.com", "api.x.ai", "grok", "xai"] ) {
  if (installHermesHandshakeEgress.includes(forbidden)) {
    fail(`Hermes handshake egress installer contains forbidden surface ${forbidden}`);
  }
}
for (const required of [
  "rehearse-handshake-control-plane-firewall.sh",
  "sudo gloops-distribution/deploy/hermes/rehearse-handshake-control-plane-firewall.sh",
]) {
  if (!workflow.includes(required)) {
    fail(`distribution workflow is missing live firewall proof ${required}`);
  }
}
// Serial stable-head publication: one concurrency group per ref so successive
// merges to gloops/stable cancel superseded multiarch runs before they publish.
for (const required of [
  "concurrency:",
  "group: gloops-distribution-${{ github.workflow }}-${{ github.ref }}",
  "cancel-in-progress: true",
]) {
  if (!workflow.includes(required)) {
    fail(`distribution workflow is missing stable-publication supersession ${required}`);
  }
}
for (const required of [
  "node:lts-trixie-slim@sha256:366fdef91728b1b7fa18c84fba63b6e79ed77b7e10cc206878e9705da4d7b169",
  "--network paperclip-handshake --ip 172.30.241.4",
  "--header 'Host: 127.0.0.1'",
  "iptables -D PCLIP-HS-IN",
  "iptables -I PCLIP-HS-IN 2",
  "paperclip-handshake-control-plane-response",
  "wait-paperclip-control-plane.sh",
]) {
  if (!rehearseHandshakeControlPlaneFirewall.includes(required)) {
    fail(`handshake control-plane firewall rehearsal is missing ${required}`);
  }
}
for (const forbidden of ["OLLAMA", "api.x.ai", "grok", "xai", "--publish"]) {
  if (rehearseHandshakeControlPlaneFirewall.includes(forbidden)) {
    fail(`handshake control-plane firewall rehearsal contains forbidden surface ${forbidden}`);
  }
}
for (const required of [
  "inspect-hermes-handshake-topology.sh",
  "iptables -nL INPUT",
  "iptables -nL DOCKER-USER",
  'args[-2:] == ["-j", target]',
  "shlex.split(rule)",
  "subprocess.run([\"iptables\", \"-D\"",
  "iptables -F \"${chain}\"",
  "iptables -X \"${chain}\"",
  "refusing to weaken the handshake boundary while a container remains attached",
  "docker network rm \"${NETWORK}\"",
  "rm -f \"${STATE_FILE}\"",
]) {
  if (!removeHermesHandshakeEgress.includes(required)) {
    fail(`Hermes handshake egress cleanup is missing ${required}`);
  }
}
for (const required of [
  "docker info",
  "Docker daemon/topology is unavailable",
  "Docker network inventory is unavailable",
  "docker network ls",
  "docker network inspect",
  "echo 'attached'",
]) {
  if (!inspectHermesHandshakeTopology.includes(required)) {
    fail(`Hermes handshake topology inspection is missing ${required}`);
  }
}
for (const required of [
  'TARGET = "ollama.com"',
  'line != f"CONNECT {TARGET}:{TARGET_PORT} HTTP/1.1"',
  'if sni != TARGET:',
  "address.is_global",
  "socket.AF_INET",
  "one-tunnel budget is exhausted",
  "client source is not the fixed Hermes address",
  "first tunneled payload is not a TLS handshake",
  "BoundedSemaphore(max_connections)",
  "if not self.connection_slots.acquire(blocking=False):",
  "503 Service Unavailable",
]) {
  if (!hermesHandshakeEgressProxy.includes(required)) {
    fail(`Hermes handshake SNI proxy is missing ${required}`);
  }
}
for (const required of [
  "Before=paperclip-hermes-handshake.service",
  "StopWhenUnneeded=yes",
  "install-hermes-handshake-egress.sh",
  "hermes-handshake-egress-proxy.py --listen 172.30.241.1 --port 18080 --allowed-client 172.30.241.3 --max-connections 4",
  "remove-hermes-handshake-egress.sh",
  "DynamicUser=yes",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK",
  "CapabilityBoundingSet=",
  "MemoryMax=128M",
  "CPUQuota=50%",
  "LimitNOFILE=64",
  "RuntimeMaxSec=900",
]) {
  if (!hermesHandshakeEgressService.includes(required)) {
    fail(`Hermes handshake egress service is missing ${required}`);
  }
}
if (hermesHandshakeEgressService.split("\n").filter((line) => line === "TasksMax=64").length !== 1) {
  fail("Hermes handshake egress service must declare exactly one TasksMax=64 directive");
}
if (!verifyDark.includes("/usr/local/lib/paperclip-gloops/verify-hermes-handshake-live-readiness.py")) {
  fail("dark verifier must execute the installed Hermes live-readiness verifier");
}
if (!readFileSync(installDarkPath, "utf8").includes(
  'install -m 0555 -o root -g root "${SCRIPT_DIR}/verify-hermes-handshake-live-readiness.py"',
)) {
  fail("dark installer must install the Hermes live-readiness verifier as immutable root-owned code");
}
for (const required of [
  "EXPECTED_UNIT_SHA256",
  "EXPECTED_PROXY_SHA256",
  "proxy ancestor is not traversable by DynamicUser",
  "proxy ancestor is writable outside root",
  "chain is not root-protected and traversable",
  "higher-precedence egress unit override exists",
  "paperclip-.service.d",
  "service.d",
  ".wants",
  "installed egress unit hash",
  "installed egress proxy hash",
  "RestrictAddressFamilies=AF_INET AF_UNIX AF_NETLINK",
  "full DynamicUser path and exact masked egress unit",
]) {
  if (!verifyHermesHandshakeLiveReadiness.includes(required)) {
    fail(`Hermes installed live-readiness verifier is missing ${required}`);
  }
}
for (const required of [
  "kill -KILL \"${proxy_pid}\"",
  "unexpected proxy exit stopped Hermes",
  "remove-hermes-handshake-egress.sh",
  "verify-dark.sh",
]) {
  if (!rehearseHermesHandshakeEgressFailure.includes(required)) {
    fail(`Hermes handshake failure rehearsal is missing ${required}`);
  }
}
for (const required of [
  "class ProviderAttemptBudgetExhausted(RuntimeError):",
  "class ForbiddenProviderTransport(RuntimeError):",
  "if _provider_attempts >= 1:",
  "paperclip handshake permits one total provider attempt",
  "def _guard_provider_request(",
  "if request.url.scheme != \"https\" or host != \"ollama.com\":",
  "def _guarded_sync_send(",
  "async def _guarded_async_send(",
  "httpx.Client._send_single_request = _guarded_sync_send",
  "httpx.AsyncClient._send_single_request = _guarded_async_send",
  "def _deny_primary_transport_recovery(",
  "del agent, api_error, retry_count, max_retries",
  "_paperclip_handshake_guard = True",
  "agent_runtime_helpers.try_recover_primary_transport = _deny_primary_transport_recovery",
]) {
  if (!hermesHandshakeGuard.includes(required)) {
    fail(`Hermes provider-handshake recovery guard is missing ${required}`);
  }
}
for (const forbidden of [
  "github-app-credentials.py",
  "/opt/data/.config/gh",
  "/opt/data/workspace",
  "/opt/data/sessions",
  "HERMES_KANBAN_TASK",
  "--publish",
]) {
  if (hermesHandshakeService.includes(forbidden)) {
    fail(`Hermes provider-handshake service contains forbidden authority ${forbidden}`);
  }
}
for (const required of [
  "_get_platform_tools(config, \"api_server\")",
  "assert toolsets == []",
  "assert tools == []",
  "repository/session/GitHub mounts",
  "all(.RW == false)",
  "admission is mutually exclusive",
  "^paperclip-gloops(-handshake)?$",
  "every Paperclip control plane must be inactive before the handshake sidecar starts",
  "readonly TOPOLOGY_INSPECTOR='/usr/local/lib/paperclip-gloops/inspect-hermes-handshake-topology.sh'",
  '[[ -x "${TOPOLOGY_INSPECTOR}" ]]',
  "handshake topology inspector is installed separately and executable",
  "grep -Fxc 'TasksMax=64'",
  "systemctl show --property=TasksMax --value paperclip-hermes-handshake-egress.service",
  "live handshake egress service effective task ceiling is exactly 64",
  "handshake cron provider is an exact inert shutdown-only implementation",
  'if ! docker logs "${CONTAINER}" >"${cron_logs}" 2>&1; then',
  "handshake runtime logs are unavailable for cron-provider verification",
  "handshake runtime did not start the built-in cron ticker",
  '"/opt/data/plugins/disabled"',
]) {
  if (!verifyHermesHandshake.includes(required)) {
    fail(`Hermes provider-handshake verifier is missing ${required}`);
  }
}
for (const required of [
  '"ollama-cloud": [.credential_pool["ollama-cloud"][]',
  'install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-handshake-config.yaml"',
  'install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-cron-disabled/__init__.py"',
  'rm -f "${CONFIG_DIR}/HERMES_HANDSHAKE_APPROVED"',
]) {
  if (!prepareHermesHandshake.includes(required)) {
    fail(`Hermes provider-handshake profile preparation is missing ${required}`);
  }
}
for (const required of [
  `Environment=HERMES_EXECUTION_IMAGE=${hermesExecutionImage}`,
  "--network paperclip-execution",
  "--network-alias hermes-execution",
  "--read-only",
  "--tmpfs /opt/data:rw,nosuid,nodev,size=768m,uid=10000,gid=10000,mode=0700",
  "--cap-drop ALL",
  "--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETGID --cap-add SETUID --cap-add KILL --security-opt no-new-privileges:true",
  "--security-opt no-new-privileges:true",
  "--env-file /etc/paperclip-gloops/hermes-execution.env",
  "--env PNPM_STORE_DIR=/opt/data/cache/pnpm/store",
  "--env XDG_CACHE_HOME=/opt/data/cache",
  "Requires=docker.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service",
  "BindsTo=paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service",
  "src=/run/paperclip-github-broker,dst=/run/paperclip-github-broker",
  "src=/opt/paperclip/hermes-execution-profile/cron-disabled,dst=/opt/data/plugins/disabled,readonly",
  "src=/usr/local/lib/paperclip-gloops/tools,dst=/opt/data/bin,readonly",
  "--health-cmd",
  "http://127.0.0.1:8642/v1/models",
  "--memory 2048m",
  "--memory-swap 2048m",
  "--cpus 2.0",
  "--pids-limit 512",
  "gateway run --replace",
  "ExecStartPost=/usr/local/lib/paperclip-gloops/restore-hermes-workspace-observer.sh",
  "ExecStop=/usr/local/lib/paperclip-gloops/stop-hermes-execution.py",
  "TimeoutStopSec=120",
]) {
  if (!hermesExecutionService.includes(required)) {
    fail(`Hermes execution service is missing ${required}`);
  }
}
for (const forbidden of [
  "dst=/opt/data/.config/gh",
  "dst=/opt/data/.gitconfig",
  "github-app-credentials.py refresh-hermes",
  "github-app-credentials.py revoke-hermes",
]) {
  if (hermesExecutionService.includes(forbidden)) {
    fail(`Hermes execution service retains forbidden legacy GitHub surface ${forbidden}`);
  }
}
for (const forbidden of [
  "paperclip-campaign-deadman.service",
  "/run/paperclip-campaign",
]) {
  if (hermesExecutionService.includes(forbidden)) {
    fail(`general Hermes execution service retains campaign lifecycle coupling ${forbidden}`);
  }
}
for (const required of [
  "Type=simple",
  "ConditionPathExists=/etc/paperclip-gloops/HERMES_EXECUTION_APPROVED",
  "ExecStartPre=/usr/local/lib/paperclip-gloops/github-push-broker.py verify-journal",
  "ExecStart=/usr/local/lib/paperclip-gloops/github-push-broker.py serve",
  "RuntimeDirectory=paperclip-github-broker",
  "NoNewPrivileges=yes",
  "ProtectSystem=strict",
  "ReadWritePaths=/var/lib/paperclip-gloops/github-push-broker /run/paperclip-github-broker",
]) {
  if (!githubPushBrokerService.includes(required)) {
    fail(`root GitHub push broker service is missing ${required}`);
  }
}
for (const required of [
  "SO_PEERCRED",
  "paperclip-github-push-{mode}-",
  "LoadCredential=github-token:",
  "\"validate\"",
  "RestrictAddressFamilies=AF_UNIX",
  "create_one_branch_ref",
  "reconciled_success",
  "bounded_failure",
  "conflict",
  "record_mint_intent",
  "reconcile_pending",
  "verify_journal",
  "draft_pull_request_authorization",
  'draft["base"] != authorization["defaultBranch"]',
  '{"contents": "read", "pull_requests": "write"}',
  '{"pull_requests": "read"}',
  "draft_pr_intent",
  "record_draft_pr_envelope",
  "SET token_expires_at = MAX(COALESCE(token_expires_at, ?), ?), updated_at = ?",
  "observe_draft_pull_request",
  "list_draft_pull_request",
]) {
  if (!githubPushBroker.includes(required)) {
    fail(`root GitHub push broker is missing ${required}`);
  }
}
for (const path of ["cache", "logs", "memories", "sessions"]) {
  const mount = `--mount type=bind,src=/opt/paperclip/hermes-execution-state/${path},dst=/opt/data/${path}`;
  if (!hermesExecutionService.includes(`${mount} `)) {
    fail(`Hermes execution service is missing persistent state mount ${mount}`);
  }
}
for (const required of [
  "SYSTEMD_STOP_TIMEOUT_SECONDS = 120",
  "HELPER_BUDGET_SECONDS = 100",
  "CONTAINER_STOP_TIMEOUT_SECONDS = 20",
  "RECEIPT_RESERVE_SECONDS = 12",
  "FORCED_DARK_RESERVE_SECONDS = CONTAINER_STOP_TIMEOUT_SECONDS + RECEIPT_RESERVE_SECONDS",
  "PLANNED_STOP_TIMEOUT_SECONDS = HELPER_BUDGET_SECONDS - FORCED_DARK_RESERVE_SECONDS",
  "timeout=timeout_before(deadline, 15)",
  "timeout=timeout_before(deadline, CONTAINER_STOP_TIMEOUT_SECONDS)",
  "acquire_history_lock(lock_fd, deadline)",
  "signal.setitimer(signal.ITIMER_REAL, remaining)",
  "append_receipt(receipt, helper_deadline)",
  "write_planned_stop_marker(expected_pid)",
  '["/command/s6-svc", "-d", "/run/service/gateway-default"]',
  '_write_gateway_desired_state("gateway-default", "stopped")',
  'dispatch != {"dispatched": True, "targetPid": before["pid"]}',
]) {
  if (!stopHermesExecution.includes(required)) {
    fail(`Hermes planned-stop helper is missing bounded deadline invariant ${required}`);
  }
}
for (const forbidden of ["/opt/paperclip/hermes-home", "--publish", "XAI_API_KEY", "GROK_API_KEY", "SLACK_"]) {
  if (hermesExecutionService.includes(forbidden)) {
    fail(`Hermes execution service contains forbidden runtime surface ${forbidden}`);
  }
}
for (const error of validateHermesRuntimePrivileges(hermesExecutionService)) {
  fail(error);
}
for (const required of [
  "Conflicts=paperclip-hermes-handshake.service",
  "ExecCondition=/usr/bin/test ! -e /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE",
]) {
  if (!hermesExecutionService.includes(required)) {
    fail(`general Hermes execution service is missing handshake exclusion ${required}`);
  }
}
for (const required of [
  "Conflicts=paperclip-gloops-handshake.service",
  "ExecCondition=/usr/bin/test ! -e /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE",
]) {
  if (!service.includes(required)) {
    fail(`general Paperclip service is missing handshake exclusion ${required}`);
  }
}
for (const required of [
  "Requires=docker.service paperclip-hermes-handshake.service",
  "Conflicts=paperclip-gloops.service",
  "Environment=PAPERCLIP_CONTAINER=paperclip-gloops-handshake",
  "ExecStartPre=/usr/bin/test -e /run/paperclip-gloops/HERMES_HANDSHAKE_ACTIVE",
  "ExecStartPre=/usr/bin/systemctl is-active --quiet paperclip-hermes-handshake.service",
  "ExecStartPre=/usr/bin/mv /etc/paperclip-gloops/ACTIVATION_APPROVED /run/paperclip-gloops/PAPERCLIP_HANDSHAKE_ACTIVE",
  "--network paperclip-handshake",
  "--ip 172.30.241.4",
  "--add-host hermes-execution:172.30.241.3",
  "--dns 127.0.0.1",
  "--env PAPERCLIP_OPERATOR_ONLY_MODE=true",
  "src=/usr/local/lib/paperclip-gloops/hermes-handshake-resolv.conf,dst=/etc/resolv.conf,readonly",
  "PAPERCLIP_HANDSHAKE_ACTIVE /etc/paperclip-gloops/ACTIVATION_APPROVED",
  "RuntimeMaxSec=900",
]) {
  if (!handshakeService.includes(required)) {
    fail(`Paperclip handshake service is missing ${required}`);
  }
}
for (const forbidden of [
  "github-app-credentials.py",
  "/opt/data/workspace",
  "Restart=on-failure",
  "--publish",
]) {
  if (handshakeService.includes(forbidden)) {
    fail(`Paperclip handshake service contains forbidden authority ${forbidden}`);
  }
}
for (const required of [
  "prepare-hermes-execution-profile.sh",
  "verify-hermes-execution-profile.sh",
  "verify-hermes-command-security-image.sh",
  "load-hermes-execution-image.sh",
  "verify-runtime-deadman.sh",
  "provision-tirith.sh",
  "restore-hermes-workspace-observer.sh",
  "wait-paperclip-control-plane.sh",
  "paperclip-hermes-execution.service",
  'install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-gloops.service" /usr/local/lib/systemd/system/paperclip-gloops.service',
  'install -m 0644 -o root -g root "${SCRIPT_DIR}/paperclip-controlled-swarm.service" /usr/local/lib/systemd/system/paperclip-controlled-swarm.service',
  "paperclip-hermes-handshake.service",
  "paperclip-hermes-handshake-egress.service",
  "paperclip-gloops-handshake.service",
  "hermes-execution-config.yaml",
  "hermes-execution-policy.json",
  "hermes-handshake-config.yaml",
  "hermes-handshake-policy.json",
  "prepare-hermes-handshake-profile.sh",
  "verify-hermes-handshake-profile.sh",
  "install-hermes-handshake-egress.sh",
  "remove-hermes-handshake-egress.sh",
  "inspect-hermes-handshake-topology.sh",
  "hermes-handshake-egress-proxy.py",
  "hermes-handshake-resolv.conf",
  "verify-hermes-handshake-egress-boundary.sh",
  "rehearse-hermes-handshake-egress-failure.sh",
  "rehearse-handshake-control-plane-firewall.sh",
  "verify-rollback-dark.sh",
  "hermes-handshake-guard/sitecustomize.py",
  "github-app-credentials.py",
  "github-push-broker.py",
  "github-push-tool.bundle.cjs",
  "paperclip-github-push-broker.service",
  "github-broker-receipt-token",
  "paperclip-git-worker",
  "stop-hermes-execution.py",
  "verify-lifecycle-history.py",
  "github-app-credentials.py\" migrate-persistent-state",
  "github-app-credentials.py\" reconcile-expired-mint-intents",
  "github-app-credentials.py\" revoke-projector",
  "hermes-cron-disabled",
  "github-app.json",
  "systemctl mask paperclip-gloops.service paperclip-controlled-swarm.service paperclip-gloops-handshake.service paperclip-hermes-execution.service paperclip-hermes-handshake.service paperclip-hermes-handshake-egress.service paperclip-github-push-broker.service paperclip-github-read-broker.service paperclip-platform-ops-broker.service paperclip-campaign-deadman.service paperclip-controlled-swarm-commissioning-recovery.service",
  "load-hermes-execution-image.sh",
  "refusing installation while a Paperclip or Hermes container exists",
]) {
  if (!installDark.includes(required)) {
    fail(`dark installer does not govern ${required}`);
  }
}
if (!backupDark.includes("refusing cold backup while a Paperclip or Hermes container exists")) {
  fail("cold backup must reject orphan Paperclip or Hermes containers");
}
if (!backupDark.includes("paperclip-hermes-handshake-egress.service")) {
  fail("cold backup must reject an active handshake egress service");
}
const backupJournalGuardIndex = backupDark.indexOf(
  'refuse_unresolved_commissioning "${COMMISSIONING_ROLLBACK_JOURNAL}"',
);
if (
  backupJournalGuardIndex < 0
  || backupJournalGuardIndex > backupDark.indexOf('stamp="$(date -u')
) {
  fail("cold backup must reject an unresolved commissioning journal before staging");
}
if (!prepareHermesExecution.includes("paperclip-hermes-handshake-egress.service") ||
    !prepareHermesHandshake.includes("paperclip-hermes-handshake-egress.service")) {
  fail("both Hermes profile preparations must reject an active handshake egress service");
}
for (const required of [
  "did not become healthy within",
  "chown \"${HERMES_UID}:${PAPERCLIP_GID}\" \"${WORKSPACE}\"",
  "chmod 2770 \"${WORKSPACE}\"",
  "docker run --rm --pull never --user \"${PAPERCLIP_UID}:${PAPERCLIP_GID}\"",
  "--network none --read-only --cap-drop ALL --security-opt no-new-privileges:true",
  "mkdir \"$probe\"",
  "printf ok >\"$probe/owner\"",
  "test -r /workspace/gloops-paperclip-plugin/.git/HEAD",
]) {
  if (!restoreHermesWorkspaceObserver.includes(required)) {
    fail(`Hermes workspace observer restoration is missing ${required}`);
  }
}
if (!preflight.includes("verify-hermes-execution-profile.sh --live")) {
  fail("Paperclip activation preflight must require a live verified Hermes execution profile");
}
for (const required of [
  "HERMES_HANDSHAKE_ACTIVE",
  "PAPERCLIP_HANDSHAKE_ACTIVE",
  "execution and handshake activation markers are mutually exclusive",
  "verify-hermes-handshake-profile.sh --live",
  "the general Hermes execution sidecar must be inactive during a handshake",
  "the Hermes handshake sidecar must be inactive during general execution",
]) {
  if (!preflight.includes(required)) {
    fail(`Paperclip preflight is missing handshake-profile selection invariant ${required}`);
  }
}
if (!preflight.includes("Host-level Hermes profiles are outside this pilot") ||
    /hermes_route_config=/.test(preflight)) {
  fail("Paperclip preflight must not bind the isolated pilot to unrelated host-level model routing");
}
if (!preflight.includes("FORBIDDEN_PROVIDER_ENDPOINT_PATTERN=") ||
    !preflight.includes("Grok/xAI API endpoint configuration is forbidden")) {
  fail("Paperclip preflight must still reject literal Grok/xAI API endpoints globally");
}
if (!verifyDark.includes("verify-hermes-execution-profile.sh --source")) {
  fail("dark verification must validate the installed Hermes execution profile");
}
if (!verifyDark.includes("verify-hermes-handshake-profile.sh --source")) {
  fail("dark verification must validate the installed Hermes provider-handshake profile");
}
for (const required of [
  "HERMES_EXECUTION_APPROVED",
  "HERMES_HANDSHAKE_APPROVED",
  "paperclip-hermes-execution.service",
  "paperclip-hermes-handshake.service",
  "paperclip-hermes-handshake-egress.service",
  "paperclip-gloops-handshake.service",
  "hermes-execution-profile",
  "hermes-handshake-profile",
  "hermes-execution-state",
  "hermes-execution-*.tar.zst",
  "/usr/local/lib/paperclip-gloops/tools",
  "docker network rm paperclip-execution",
  "github-app-credentials.py revoke-projector",
  "github-app-credentials.py revoke-hermes",
  "/run/paperclip-gloops",
  "remove-hermes-handshake-egress.sh",
  "refusing rollback while a Paperclip or Hermes container exists",
  "verify-rollback-dark.sh",
]) {
  if (!rollback.includes(required)) {
    fail(`rollback does not remove ${required}`);
  }
}
for (const required of [
  "paperclip-hermes-handshake-egress.service",
  "cannot inspect Docker topology",
  "cannot inspect firewall topology",
  "cannot inspect Docker containers",
  "cannot inspect Docker networks",
  "cannot capture firewall topology",
  "cannot inspect listeners",
  "paperclip.service boot-eligible",
  "rollback left governed unit unmasked",
  "HANDSHAKE_EGRESS_ACTIVE",
  "paperclip-execution paperclip-handshake",
  "PCLIP-HS-IN",
  "PCLIP-HS-FWD",
  "3100|8642|18080",
  "PASS rollback terminal state is inactive",
]) {
  if (!verifyRollbackDark.includes(required)) {
    fail(`rollback terminal dark verifier is missing ${required}`);
  }
}
for (const required of [
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=0.0.0.0",
  "API_SERVER_PORT=8642",
  "secrets.token_hex(32)",
  '"ollama-cloud": [.credential_pool["ollama-cloud"][]',
  'base_url == "https://ollama.com/v1"',
  'rm -rf "${PROFILE_DIR}/gh"',
  'rm -f "${PROFILE_DIR}/gitconfig"',
  'install -d -m 0700 -o "${HERMES_UID}" -g "${HERMES_GID}" "${STATE_DIR}/${path}"',
]) {
  if (!prepareHermesExecution.includes(required)) {
    fail(`Hermes profile preparation is missing ${required}`);
  }
}
if (prepareHermesExecution.includes("github-app-credentials.py\" refresh")) {
  fail("dark profile preparation must not mint a GitHub installation token");
}
for (const required of [
  "credential pool is limited to Ollama Cloud with no fallback credential",
  "persistent Hermes state is writable only by the fixed Hermes identity",
  "Hermes receives an immutable broker client and no GitHub installation token or credential config",
  "live Hermes can reach only the authenticated broker socket and observes no GitHub token",
  "docker exec -i --user 10000:10000",
  "docker exec -i --user 10000:10000 \"${CONTAINER}\" /opt/hermes/.venv/bin/python - <<'PY'",
  "live container publishes no host ports",
  "live authenticated API boundary is healthy",
  "live Hermes identity exclusively owns the ephemeral lifecycle root",
  "live persistent Hermes state mounts are exact and writable only by the fixed Hermes identity",
  "pinned Tirith command scanner is immutable and verified before activation",
  "live Tirith scanner is the exact read-only pre-provisioned binary",
  "--arg destination '/opt/data/bin'",
  "docker inspect --format '{{json .Mounts}}'",
  'type == "array"',
  'and all(.[];',
  'and (.Source | type) == "string"',
  "live mount metadata is invalid or includes the broad Hermes home",
  '([.[] | select(.Destination == $destination)] | length) == 1',
  '.Type == "bind"',
  '.Source == $source',
  '.Destination == $destination',
  '.RW == true',
  'docker exec -i --user 10000:10000 "${CONTAINER}" /opt/hermes/.venv/bin/python - <<\'PY\'',
  "live API rejects unauthenticated execution-plane access",
  "live Paperclip identity can use the shared workspace transaction boundary",
  "Grok is host-CLI-only with no API configuration",
]) {
  if (!verifyHermesExecution.includes(required)) {
    fail(`Hermes execution verification is missing ${required}`);
  }
}
if (/\bgh api\b/.test(verifyHermesExecution) || /\bgh api\b/.test(preflight)) {
  fail("closed-interval verification must not make external GitHub API requests");
}
for (const line of verifyHermesExecution.split("\n").filter((value) => value.includes("docker run"))) {
  if (!line.includes("--pull never")) {
    fail("Hermes verification must not contact a registry for an absent image");
  }
}
if (JSON.stringify(githubAppConfig) !== JSON.stringify({
  appId: 4307157,
  installationId: 146796843,
  repositoryId: 1297008772,
  repository: "gloopsAI/gloops-paperclip-plugin",
  privateKeyPath: "/etc/paperclip-gloops/github-app/private-key.pem",
  boardTokenPath: "/etc/paperclip-gloops/operator-board-token",
})) {
  fail("GitHub App broker configuration is not exact");
}
for (const required of [
  '"repository_ids": [config["repositoryId"]]',
  '"contents": "write"',
  '"contents": "read"',
  '"pull_requests": "write"',
  '"pull_requests": "read"',
  'seconds < 2700 or seconds > 3900',
  'ALLOWED_REPOSITORIES = frozenset({',
  '"gloopsAI/gloops-paperclip-plugin",',
  '"gloopsAI/paperclip-gym",',
  'if raw["repository"] not in ALLOWED_REPOSITORIES:',
  'len(repositories) > len(ALLOWED_REPOSITORIES)',
  'installation["total_count"] != len(repositories)',
  'repository.get("full_name") not in ALLOWED_REPOSITORIES',
  'detail.get("private") is not True',
  'revoke_value(token)',
  'except CredentialRetentionError as error:',
  'except Exception:',
  'record_revocation(token_path, token)',
  'archive_completed_receipt()',
  'credential-history.jsonl',
  '"revokedAt": None',
  '"expiredAt": None',
  'record_expiration(token_path, token, expiry_receipt)',
  'def read_root_secret(path: Path, label: str)',
  'mode not in {0o400, 0o600}',
  'def resolve_bound_projector_secret(config: dict[str, object], board_token: str)',
  '"/plugins/gloops.trusted-execution-projector/config"',
  'f"/companies/{company_id}/secrets"',
  'durable_unlink(PROJECTOR_ROTATED)',
  'print(f"github-app-credentials: {error}", file=sys.stderr)',
  'RUNTIME = Path("/var/lib/paperclip-gloops/credential-runtime")',
  'LEGACY_RUNTIME = Path("/run/paperclip-gloops")',
  'MINT_INTENTS = RUNTIME / "mint-intents.json"',
  'MIGRATION_BASELINE = RUNTIME / "migration-baseline.json"',
  'EXPIRY_HISTORY = Path("/var/lib/paperclip-gloops/credential-expiry-history.jsonl")',
  'def ensure_runtime() -> None:',
  'fsync_directory(RUNTIME.parent.parent)',
  'begin_mint_intent(role)',
  'clear_mint_intent(role)',
  'safeAfter',
  'observedAt',
  'begin_migration_quarantine()',
  'if basis != "expiry-quarantine-completed":',
  'ensure_migration_quarantine_intents(baseline)',
  'complete_migration_baseline(baseline, "expiry-quarantine-completed")',
  'append_expiry_receipt(role, intent, token, now)',
  'append_uncertainty_clearance(role, intent, now)',
  'migrate_persistent_state()',
  'reconcile_expired_mint_intents()',
  'fsync_directory(HISTORY.parent)',
  'token_revocation_is_recorded(token_path, token)',
  'token_mint_is_recorded(token_path, token)',
  'GitHub credential lifecycle changed after archival',
  'error.status not in {401, 404}',
]) {
  if (!githubAppCredentials.includes(required)) {
    fail(`GitHub App broker is missing ${required}`);
  }
}
const refreshRole = githubAppCredentials.match(/def refresh_role\([\s\S]*?\n\ndef paperclip_request/)?.[0] ?? "";
const intentIndex = refreshRole.indexOf("begin_mint_intent(role)");
const handleIndex = refreshRole.indexOf("atomic_write(token_path, token");
const receiptIndex = refreshRole.indexOf("record_mint(config, role, token");
const clearIntentIndex = refreshRole.indexOf("clear_mint_intent(role)");
if (
  intentIndex < 0 || handleIndex < intentIndex || receiptIndex < handleIndex || clearIntentIndex < receiptIndex
) {
  fail("GitHub App mint lifecycle must retain its intent through durable handle and receipt persistence");
}
for (const required of [
  'S6_PLANNED_STOP_COMMAND',
  '"targetPid": expected_pid',
  'gateway_state.json',
  "'gateway_state':r.get('gateway_state')",
  'receipt["gatewayState"] = "stopped" if graceful else None',
  'hermes-stop-history.jsonl',
  'receipt["plannedStopAccepted"] = graceful',
  'receipt["containerStopped"] = stopped',
  "atomic_write(HISTORY, payload)",
]) {
  if (!stopHermesExecution.includes(required)) {
    fail(`Hermes stop helper is missing ${required}`);
  }
}
if (
  !hermesCronDisabled.includes("class DisabledCronScheduler(CronScheduler)") ||
  !hermesCronDisabled.includes("stop_event.wait()") ||
  /fire_due|on_jobs_changed|reconcile|cron_tick|while\s/.test(hermesCronDisabled)
) {
  fail("Hermes disabled cron provider must be shutdown-only and unable to fire work");
}
for (const forbidden of ["zach-hermes", "xai", "grok", "GITHUB_TOKEN", "GH_TOKEN"]) {
  if (githubAppCredentials.includes(forbidden)) {
    fail(`GitHub App broker contains forbidden identity or provider surface ${forbidden}`);
  }
}
for (const required of [
  "ExecStartPre=/usr/local/lib/paperclip-gloops/github-app-credentials.py refresh-projector",
  "ExecStartPost=/usr/local/lib/paperclip-gloops/github-app-credentials.py rotate-projector",
  "ExecStop=/usr/local/lib/paperclip-gloops/github-app-credentials.py clear-projector",
  "ExecStopPost=-/usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-projector",
]) {
  if (!service.includes(required)) {
    fail(`Paperclip service is missing projector credential lifecycle step ${required}`);
  }
}
if (hermesExecutionService.includes("revoke-projector")) {
  fail("Hermes service must not own the independently restarted projector credential");
}
for (const required of [
  "/usr/local/lib/paperclip-gloops/verify-lifecycle-history.py",
  "/var/lib/paperclip-gloops/credential-history.jsonl",
  "/var/lib/paperclip-gloops/hermes-stop-history.jsonl",
  "/var/lib/paperclip-gloops/credential-expiry-history.jsonl",
  "/var/lib/paperclip-gloops/credential-runtime/credential-receipt.json",
  "migration-baseline.json",
  'value.status !== "complete"',
  "FAIL durable Hermes execution lifecycle evidence is invalid",
  "PASS durable credential cleanup state is root-only",
  "FAIL a zero-work egress proof rule remains installed while dark",
  "FAIL Hermes handshake egress firewall policy remains while dark",
  "PASS no Hermes handshake egress policy remains while dark",
  "PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=false",
  "PAPERCLIP_BACKLOG_BANKRUPTCY_FROZEN_COMPANY_IDS=89ed0964-d918-4fcc-b830-5be49d2d4089",
  "PAPERCLIP_BACKLOG_BANKRUPTCY_READMIT_ISSUE_IDS=",
]) {
  if (!verifyDark.includes(required)) {
    fail(`dark verification is missing revocation evidence ${required}`);
  }
}
if (verifyDark.includes("PAPERCLIP_RUNTIME_RELEASE_PIN_REQUIRED=true")) {
  fail("dark verification still requires the source-only release-pin interlock");
}
for (const required of [
  "verify_chain(records, \"lifecycleId\")",
  "verify_chain(records, \"attemptId\")",
  "durable current receipt does not exactly equal credential-history tail",
  "durable current receipt is missing despite credential history",
  "credential lifecycle has no stop attempt",
  "non-legacy credential history has no stop history",
  'verify_expirations(expirations)',
  'credential handle was disposed before its expiry envelope',
  'gloops.github-app-expiry-receipt.v1',
  'gloops.github-app-uncertainty-clearance.v1',
  'credential expiry binding has no exact expiry receipt',
  'token-free uncertainty cleared before its observed expiry envelope',
  'token-free clearance fields are malformed',
  "PASS lifecycle histories are",
]) {
  if (!verifyLifecycleHistory.includes(required)) {
    fail(`lifecycle history verifier is missing ${required}`);
  }
}
for (const required of [
  "/var/lib/paperclip-gloops/credential-runtime/hermes-github-token",
  "/var/lib/paperclip-gloops/credential-runtime/projector-github-token",
  "/var/lib/paperclip-gloops/credential-runtime/projector-token-rotated",
  "/var/lib/paperclip-gloops/credential-runtime/mint-intents.json",
  "/run/paperclip-gloops/hermes-github-token",
  "/run/paperclip-gloops/projector-github-token",
  "/run/paperclip-gloops/projector-token-rotated",
  "/opt/paperclip/hermes-execution-profile/gh/hosts.yml",
]) {
  if (!verifyDark.includes(required)) {
    fail(`dark verification does not reject residual credential ${required}`);
  }
}
for (const providerConfigPath of [
  "/opt/paperclip/hermes-home/.env",
  "/opt/paperclip/hermes-home/config.yaml",
  "/opt/paperclip/grok-shared-runner/runner.env",
]) {
  if (!verifyDark.includes(providerConfigPath)) {
    fail(`dark verification must inspect ${providerConfigPath} for forbidden Grok/xAI API configuration`);
  }
  if (!preflight.includes(providerConfigPath)) {
    fail(`activation preflight must inspect ${providerConfigPath} for forbidden Grok/xAI API configuration`);
  }
}
const approvedImage = `${distribution.image}@${distribution.digest}`;
for (const [label, contents] of [
  ["install-dark.sh", installDark],
  ["verify-dark.sh", verifyDark],
]) {
  const imageRefs = contents.match(/ghcr\.io\/gloopsai\/paperclip-gloops@sha256:[0-9a-f]{64}/g) ?? [];
  if (imageRefs.length !== 1 || imageRefs[0] !== approvedImage) {
    fail(`${label} must pin exactly the manifest-approved image digest`);
  }
}
if (
  !preflight.includes("readonly APPROVED_IMAGE_FILE='/etc/paperclip-gloops/approved-image'") ||
  !preflight.includes('readonly EXPECTED_IMAGE="$(tr -d') ||
  !preflight.includes('[[ "${PAPERCLIP_IMAGE:-}" == "${EXPECTED_IMAGE}" ]]')
) {
  fail("preflight.sh must bind the runtime image to the root-owned approved-image receipt");
}
for (const [label, contents] of [
  ["paperclip-gloops.service", service],
  ["paperclip-gloops-handshake.service", handshakeService],
]) {
  if (!contents.includes("EnvironmentFile=/etc/paperclip-gloops/runtime.env")) {
    fail(`${label} must load the root-owned runtime environment`);
  }
  if (!contents.includes("${PAPERCLIP_IMAGE}")) {
    fail(`${label} must launch the image selected by the root-owned runtime environment`);
  }
  const imageRefs = contents.match(/ghcr\.io\/gloopsai\/paperclip-gloops@sha256:[0-9a-f]{64}/g) ?? [];
  if (imageRefs.length !== 0) {
    fail(`${label} must not override the runtime-selected immutable image`);
  }
}

if (vex) {
  if (vex["@context"] !== "https://openvex.dev/ns/v0.2.0") {
    fail("VEX must use the OpenVEX 0.2 context");
  }
  const expectedVulnerabilities = new Map([
    ["CVE-2026-41679", "fixed"],
    ["GHSA-3xx2-mqjm-hg9x", "fixed"],
    ["GHSA-47wq-cj9q-wpmp", "fixed"],
    ["GHSA-vr7g-88fq-vhq3", "fixed"],
    ["CVE-2026-41208", "fixed"],
    ["GHSA-w8hx-hqjv-vjcq", "fixed"],
    ["GHSA-xfqj-r5qw-8g4j", "fixed"],
    ["CVE-2026-13221", "not_affected"],
    ["CVE-2026-42496", "not_affected"],
    ["CVE-2026-8376", "not_affected"],
  ]);
  for (const statement of vex.statements ?? []) {
    const id = statement.vulnerability?.["@id"];
    const expectedStatus = expectedVulnerabilities.get(id);
    if (!expectedStatus) {
      fail(`VEX contains an unexpected or duplicate vulnerability: ${id}`);
    }
    expectedVulnerabilities.delete(id);
    if (statement.status !== expectedStatus) {
      fail(`${id}: VEX status must be ${expectedStatus}`);
    }
    if (!statement.impact_statement?.includes("evidence:")) {
      fail(`${id}: VEX must identify exact evidence`);
    }
  }
  if (expectedVulnerabilities.size > 0) {
    fail(`VEX is missing scanner findings: ${[...expectedVulnerabilities.keys()].join(", ")}`);
  }
}
if (!/^[0-9a-f]{40}$/.test(upstream.baseCommit ?? "")) {
  fail("upstream baseCommit must be a full SHA");
} else {
  try {
    git("merge-base", "--is-ancestor", upstream.baseCommit, "HEAD");
  } catch {
    fail(`upstream base ${upstream.baseCommit} is not an ancestor of HEAD`);
  }
}

if (!Array.isArray(manifest.patches) || manifest.patches.length === 0) {
  fail("at least one downstream patch must be declared");
}

const patchIds = new Set();
for (const patch of manifest.patches ?? []) {
  if (!patch.id || patchIds.has(patch.id))
    fail(`patch id is missing or duplicated: ${patch.id}`);
  patchIds.add(patch.id);

  if (patch.sourceKind === "upstream") {
    if (
      !/^https:\/\/github\.com\/paperclipai\/paperclip\/pull\/\d+$/.test(
        patch.upstreamPullRequest ?? "",
      )
    ) {
      fail(
        `${patch.id}: upstream patches require a canonical Paperclip PR URL`,
      );
    }
  } else if (patch.sourceKind === "downstream") {
    if (patch.upstreamPullRequest !== null) {
      fail(
        `${patch.id}: downstream-only patches must use a null upstreamPullRequest`,
      );
    }
  } else {
    fail(`${patch.id}: sourceKind must be upstream or downstream`);
  }
  if (!/^[0-9a-f]{40}$/.test(patch.sourceHead ?? "")) {
    fail(`${patch.id}: sourceHead must be a full SHA`);
  }
  if (!/^[0-9a-f]{40}$/.test(patch.sourceBase ?? "")) {
    fail(`${patch.id}: sourceBase must be a full SHA`);
  }
  if (!/^[0-9a-f]{64}$/.test(patch.patchDiffSha256 ?? "")) {
    fail(`${patch.id}: patchDiffSha256 must be a SHA-256 digest`);
  }
  if (patch.patchDiffAlgorithm === canonicalPatchDigestAlgorithm) {
    try {
      const canonicalDiff = gitCanonicalDiff(
        `${patch.sourceBase}..${patch.sourceHead}`,
      );
      const canonicalDigest = createHash("sha256")
        .update(canonicalDiff)
        .digest("hex");
      if (canonicalDigest !== patch.patchDiffSha256) {
        fail(
          `${patch.id}: patchDiffSha256 does not match canonical full-index digest (expected ${canonicalDigest})`,
        );
      }
    } catch (error) {
      fail(
        `${patch.id}: cannot compute canonical patch digest: ${error instanceof Error ? error.message : error}`,
      );
    }
  } else if (patch.patchDiffAlgorithm === "git-diff-default-sha256-v0") {
    const expectedLegacyDigest = legacyPatchDigests.get(patch.id);
    if (patch.patchDiffSha256 !== expectedLegacyDigest) {
      fail(`${patch.id}: legacy patch digest is not on the explicit allowlist`);
    }
    try {
      git("cat-file", "-e", `${patch.sourceBase}^{commit}`);
      git("cat-file", "-e", `${patch.sourceHead}^{commit}`);
      fail(
        `${patch.id}: legacy patch revisions are reachable and must be migrated to the canonical digest`,
      );
    } catch {
      // The legacy exception remains valid only while at least one revision is absent.
    }
  } else {
    fail(`${patch.id}: patchDiffAlgorithm is missing or unsupported`);
  }
  if (!patch.owner || !patch.retirementCondition) {
    fail(`${patch.id}: owner and retirementCondition are required`);
  }
  if (
    !Array.isArray(patch.integratedCommits) ||
    patch.integratedCommits.length === 0
  ) {
    fail(`${patch.id}: integratedCommits must be non-empty`);
    continue;
  }

  for (const commit of patch.integratedCommits) {
    if (!/^[0-9a-f]{7,40}$/.test(commit)) {
      fail(`${patch.id}: invalid integrated commit ${commit}`);
      continue;
    }
    try {
      git("merge-base", "--is-ancestor", commit, "HEAD");
    } catch {
      fail(
        `${patch.id}: integrated commit ${commit} is not an ancestor of HEAD`,
      );
    }
  }
}

const releasePolicy = manifest.releasePolicy ?? {};
if (releasePolicy.autoDeploy !== false) fail("autoDeploy must remain false");
if (releasePolicy.productionReference !== "digest") {
  fail("productionReference must be digest");
}

const requiredEvidence = new Set(releasePolicy.requiredEvidence ?? []);
for (const item of [
  "paperclip-ci",
  "gloops-maintenance-canary",
  "container-sbom",
  "container-provenance",
  "container-vex",
  "independent-exact-head-acceptance",
]) {
  if (!requiredEvidence.has(item))
    fail(`required evidence is missing: ${item}`);
}

if (!process.exitCode) {
  console.log(
    `PASS: ${distribution.name} ${distribution.version} declares ${manifest.patches.length} owned patches on ${upstream.baseCommit}`,
  );
}
