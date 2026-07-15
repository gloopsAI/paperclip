#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { validateHermesRuntimePrivileges } from "./gloops-runtime-policy.mjs";

const manifestPath = new URL(
  "../gloops-distribution/manifest.json",
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
const installDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/install-dark.sh",
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
const verifyDarkPath = new URL(
  "../gloops-distribution/deploy/hermes/verify-dark.sh",
  import.meta.url,
);
const rehearseZeroWorkPath = new URL(
  "../gloops-distribution/deploy/hermes/rehearse-zero-work.sh",
  import.meta.url,
);
const rollbackPath = new URL(
  "../gloops-distribution/deploy/hermes/rollback.sh",
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
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const dockerfile = readFileSync(dockerfilePath, "utf8");
const workflow = readFileSync(workflowPath, "utf8");
const runtimeEnv = readFileSync(runtimeEnvPath, "utf8");
const service = readFileSync(servicePath, "utf8");
const installDark = readFileSync(installDarkPath, "utf8");
const preflight = readFileSync(preflightPath, "utf8");
const waitPaperclipControlPlane = readFileSync(waitPaperclipControlPlanePath, "utf8");
const verifyDark = readFileSync(verifyDarkPath, "utf8");
const rehearseZeroWork = readFileSync(rehearseZeroWorkPath, "utf8");
const rollback = readFileSync(rollbackPath, "utf8");
const hermesExecutionConfig = readFileSync(hermesExecutionConfigPath, "utf8");
const hermesExecutionPolicy = JSON.parse(readFileSync(hermesExecutionPolicyPath, "utf8"));
const hermesExecutionGhConfig = readFileSync(hermesExecutionGhConfigPath, "utf8");
const hermesExecutionService = readFileSync(hermesExecutionServicePath, "utf8");
const prepareHermesExecution = readFileSync(prepareHermesExecutionPath, "utf8");
const verifyHermesExecution = readFileSync(verifyHermesExecutionPath, "utf8");
const restoreHermesWorkspaceObserver = readFileSync(restoreHermesWorkspaceObserverPath, "utf8");
const githubAppCredentials = readFileSync(githubAppCredentialsPath, "utf8");
const githubAppConfig = JSON.parse(readFileSync(githubAppConfigPath, "utf8"));
try {
  execFileSync("python3", [githubAppCredentialsTestPath.pathname], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  fail(`GitHub App broker unit tests failed: ${error instanceof Error ? error.message : error}`);
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
for (const required of [
  "HEARTBEAT_SCHEDULER_ENABLED=false",
  "PAPERCLIP_MTE_ENABLED=false",
  "issue_recovery_actions",
  "agent_wakeup_requests",
  "timeout --signal=TERM --kill-after=5s 180s docker exec",
  "IN ACCESS EXCLUSIVE MODE",
  "evidence_pid=$!",
  "kill -0 \"${evidence_pid}\"",
  "verify-dark.sh",
]) {
  if (!rehearseZeroWork.includes(required)) {
    fail(`zero-work rehearsal is missing ${required}`);
  }
}
const cleanupMatch = rehearseZeroWork.match(/cleanup\(\) \{([\s\S]*?)\n\}/);
for (const required of [
  'kill "${evidence_pid}"',
  'systemctl stop "${PAPERCLIP_UNIT}"',
  'systemctl stop "${HERMES_UNIT}"',
  'rm -f "${CONFIG_DIR}/ACTIVATION_APPROVED" "${CONFIG_DIR}/HERMES_EXECUTION_APPROVED"',
  'systemctl mask "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"',
  '"${LIB_DIR}/verify-dark.sh"',
]) {
  if (!cleanupMatch?.[1].includes(required)) {
    fail(`zero-work cleanup is missing ${required}`);
  }
}
const trapIndex = rehearseZeroWork.indexOf("trap cleanup EXIT");
const unmaskIndex = rehearseZeroWork.indexOf('systemctl unmask "${PAPERCLIP_UNIT}" "${HERMES_UNIT}"');
const lockIndex = rehearseZeroWork.indexOf("IN ACCESS EXCLUSIVE MODE");
const holderIndex = rehearseZeroWork.indexOf("evidence_pid=$!");
const stopIndex = rehearseZeroWork.indexOf(
  'systemctl stop "${PAPERCLIP_UNIT}"',
  holderIndex,
);
const hermesStopIndex = rehearseZeroWork.indexOf(
  'systemctl stop "${HERMES_UNIT}"',
  stopIndex + 1,
);
const inspectIndex = rehearseZeroWork.indexOf('node - "${evidence_output}"');
if (
  trapIndex < 0 ||
  unmaskIndex < 0 ||
  lockIndex < 0 ||
  holderIndex < 0 ||
  stopIndex < 0 ||
  hermesStopIndex < 0 ||
  inspectIndex < 0 ||
  !(trapIndex < unmaskIndex && lockIndex < holderIndex && holderIndex < stopIndex && stopIndex < hermesStopIndex && hermesStopIndex < inspectIndex)
) {
  fail("zero-work rehearsal must arm cleanup before activation and stop services under evidence locks before inspection");
}
if (!installDark.includes('rehearse-zero-work.sh')) {
  fail("dark installer must install the zero-work rehearsal harness");
}
for (const required of [
  "did not become healthy within",
  "http://127.0.0.1:3100/api/health",
  "curl --fail --silent --show-error --max-time 5",
]) {
  if (!waitPaperclipControlPlane.includes(required)) {
    fail(`Paperclip control-plane readiness barrier is missing ${required}`);
  }
}

const hermesExecutionImage =
  "hermes-agent@sha256:c58e0672b554d9a240bae881660a0294818f08f9523c9c512a1dadfdac6dae78";
if (hermesExecutionPolicy.schemaVersion !== "gloops.hermes-execution-profile.v1") {
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
  JSON.stringify(["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY", "API_SERVER_PORT", "OLLAMA_API_KEY"])
) {
  fail("Hermes execution runtime environment allowlist is not exact");
}
if (
  JSON.stringify(hermesExecutionPolicy.allowedCredentialFiles) !==
    JSON.stringify(["/opt/data/auth.json", "/opt/data/.config/gh/hosts.yml"]) ||
  JSON.stringify(hermesExecutionPolicy.github) !== JSON.stringify({
    principal: "gloops-autonomous-delivery[bot]",
    credentialType: "github-app-installation-token",
    appId: 4307157,
    installationId: 146796843,
    repositoryId: 1297008772,
    allowedRepositories: ["gloopsAI/gloops-paperclip-plugin"],
    minimumPermission: "push",
    credentialMount: "read-only",
    maximumLifetimeSeconds: 3600,
    darkState: "revoked-and-absent",
  }) ||
  !hermesExecutionPolicy.forbiddenProviders?.includes("openai-codex")
) {
  fail("Hermes bounded-pilot GitHub credential and no-fallback boundary is not exact");
}
if (hermesExecutionGhConfig !== 'version: "1"\n') {
  fail("Hermes GitHub CLI config must be deterministic and contain no mutable settings");
}
if (!prepareHermesExecution.includes('install -m 0400 -o 10000 -g 10000 "${LIB_DIR}/hermes-execution-gitconfig"') ||
    !readFileSync(new URL("../gloops-distribution/deploy/hermes/hermes-execution-gitconfig", import.meta.url), "utf8")
      .includes("4307157+gloops-autonomous-delivery[bot]@users.noreply.github.com")) {
  fail("Hermes git identity must use the exact GitHub App bot noreply address");
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
if (hermesExecutionPolicy.runtime?.imageAcquisition !== "preprovisioned-local-digest") {
  fail("Hermes execution image acquisition must be explicit");
}
if (
  !/^model:\n  provider: ollama-cloud\n  default: kimi-k2\.7-code$/m.test(hermesExecutionConfig) ||
  /fallback_providers|openai-codex|chatgpt\.com\/backend-api\/codex/m.test(hermesExecutionConfig)
) {
  fail("Hermes bounded-pilot routing must use Ollama Cloud with no fallback provider");
}
for (const forbidden of ["anthropic", "openrouter", "xai", "grok", "slack", "agentmail", "smtp", "discord", "telegram", "moa", "plugins"]) {
  if (hermesExecutionConfig.toLowerCase().includes(forbidden)) {
    fail(`Hermes execution configuration must not include ${forbidden}`);
  }
}
for (const required of [
  `Environment=HERMES_EXECUTION_IMAGE=${hermesExecutionImage}`,
  "--network paperclip-execution",
  "--network-alias hermes-execution",
  "--read-only",
  "--cap-drop ALL",
  "--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add SETGID --cap-add SETUID --cap-add KILL --security-opt no-new-privileges:true",
  "--security-opt no-new-privileges:true",
  "--env-file /etc/paperclip-gloops/hermes-execution.env",
  "src=/opt/paperclip/hermes-execution-profile/gh,dst=/opt/data/.config/gh,readonly",
  "src=/opt/paperclip/hermes-execution-profile/gitconfig,dst=/opt/data/.gitconfig,readonly",
  "--health-cmd",
  "http://127.0.0.1:8642/v1/models",
  "--memory 2048m",
  "--memory-swap 2048m",
  "--cpus 2.0",
  "--pids-limit 512",
  "gateway run --replace",
  "ExecStartPost=/usr/local/lib/paperclip-gloops/restore-hermes-workspace-observer.sh",
  "ExecStartPre=/usr/local/lib/paperclip-gloops/github-app-credentials.py refresh-hermes",
  "ExecStopPost=-/usr/local/lib/paperclip-gloops/github-app-credentials.py revoke-hermes",
  "TimeoutStopSec=90",
]) {
  if (!hermesExecutionService.includes(required)) {
    fail(`Hermes execution service is missing ${required}`);
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
  "prepare-hermes-execution-profile.sh",
  "verify-hermes-execution-profile.sh",
  "restore-hermes-workspace-observer.sh",
  "wait-paperclip-control-plane.sh",
  "paperclip-hermes-execution.service",
  "hermes-execution-config.yaml",
  "hermes-execution-policy.json",
  "hermes-execution-gitconfig",
  "hermes-execution-gh-config.yml",
  "github-app-credentials.py",
  "github-app.json",
  "systemctl mask paperclip-gloops.service paperclip-hermes-execution.service",
  "pre-provisioned immutable Hermes execution image is missing",
]) {
  if (!installDark.includes(required)) {
    fail(`dark installer does not govern ${required}`);
  }
}
for (const required of [
  "did not become healthy within",
  "chown \"${HERMES_UID}:${PAPERCLIP_GID}\" \"${WORKSPACE}\"",
  "chmod 0750 \"${WORKSPACE}\"",
  "docker run --rm --pull never --user \"${PAPERCLIP_UID}:${PAPERCLIP_GID}\"",
  "--network none --read-only --cap-drop ALL --security-opt no-new-privileges:true",
  "test -r /workspace/gloops-paperclip-plugin/.git/HEAD",
]) {
  if (!restoreHermesWorkspaceObserver.includes(required)) {
    fail(`Hermes workspace observer restoration is missing ${required}`);
  }
}
if (!preflight.includes("verify-hermes-execution-profile.sh --live")) {
  fail("Paperclip activation preflight must require a live verified Hermes execution profile");
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
for (const required of [
  "HERMES_EXECUTION_APPROVED",
  "paperclip-hermes-execution.service",
  "hermes-execution-profile",
  "hermes-execution-state",
  "docker network rm paperclip-execution",
  "github-app-credentials.py revoke-projector",
  "github-app-credentials.py revoke-hermes",
  "/run/paperclip-gloops",
]) {
  if (!rollback.includes(required)) {
    fail(`rollback does not remove ${required}`);
  }
}
for (const required of [
  "API_SERVER_ENABLED=true",
  "API_SERVER_HOST=0.0.0.0",
  "API_SERVER_PORT=8642",
  "secrets.token_hex(32)",
  '"ollama-cloud": [.credential_pool["ollama-cloud"][]',
  'base_url == "https://ollama.com/v1"',
  'chmod 0500 "${PROFILE_DIR}/gh"',
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
  "short-lived GitHub App credential has one-repository private write scope",
  "live GitHub App token has write access only to the declared private pilot boundary",
  "live container publishes no host ports",
  "live authenticated API boundary is healthy",
  "live API rejects unauthenticated execution-plane access",
  "live Paperclip observer can read the exact plugin pilot repository",
  "Grok is host-CLI-only with no API configuration",
]) {
  if (!verifyHermesExecution.includes(required)) {
    fail(`Hermes execution verification is missing ${required}`);
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
  'installation.get("total_count") != 1',
  'detail.get("private") is not True',
  'revoke_value(token)',
  'except CredentialRetentionError as error:',
  'except Exception:',
  'record_revocation(token_path, token)',
  '"revokedAt": None',
  'def read_root_secret(path: Path, label: str)',
  'mode not in {0o400, 0o600}',
  'def resolve_bound_projector_secret(config: dict[str, object], board_token: str)',
  '"/plugins/gloops.trusted-execution-projector/config"',
  'f"/companies/{company_id}/secrets"',
  'PROJECTOR_ROTATED.unlink(missing_ok=True)',
  'print(f"github-app-credentials: {error}", file=sys.stderr)',
]) {
  if (!githubAppCredentials.includes(required)) {
    fail(`GitHub App broker is missing ${required}`);
  }
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
  "GitHub App credential receipt records both successful revocations",
  ".hermes.revokedAt",
  ".projector.revokedAt",
]) {
  if (!verifyDark.includes(required)) {
    fail(`dark verification is missing revocation evidence ${required}`);
  }
}
for (const required of [
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
  ["preflight.sh", preflight],
  ["verify-dark.sh", verifyDark],
  ["paperclip-gloops.service", service],
]) {
  const imageRefs = contents.match(/ghcr\.io\/gloopsai\/paperclip-gloops@sha256:[0-9a-f]{64}/g) ?? [];
  if (imageRefs.length !== 1 || imageRefs[0] !== approvedImage) {
    fail(`${label} must pin exactly the manifest-approved image digest`);
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
