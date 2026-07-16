import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const joinScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-join.sh");
const e2eScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-e2e.sh");
const referenceMatrixScript = path.join(repoRoot, "scripts", "smoke", "hermes-gateway-reference-matrix.sh");
const entrypointScript = path.join(repoRoot, "docker", "hermes-gateway-smoke", "entrypoint.sh");
const providerVariables = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_BASE_URL",
  "XAI_BASE_URL",
  "GROK_BASE_URL",
];

function referenceEnv(overrides = {}) {
  const env = { ...process.env };
  for (const variable of providerVariables) delete env[variable];
  delete env.COMPANY_ID;
  delete env.PAPERCLIP_COMPANY_ID;
  return {
    ...env,
    PAPERCLIP_API_URL: "http://127.0.0.1:3189",
    PAPERCLIP_API_URL_FOR_HERMES: "http://host.docker.internal:3189",
    PAPERCLIP_AUTH_HEADER: "Bearer test-only",
    REFERENCE_DISPOSABLE_ACK: "delete-disposable-companies",
    REFERENCE_MOCK_PROBE_URL: "http://127.0.0.1:8787/health",
    HERMES_REFERENCE_MOCK_BASE_URL: "http://host.docker.internal:8787/v1",
    ...overrides,
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
}

function assertSuccess(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function extractFunction(scriptText, name) {
  const lines = scriptText.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name}() {`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (index > start && lines[index].trim() === "}") {
      return collected.join("\n");
    }
  }
  assert.fail(`unterminated function ${name}`);
}

function runBashFunctions(scriptPath, functionNames, body) {
  const scriptText = fs.readFileSync(scriptPath, "utf8");
  const functions = functionNames.map((name) => extractFunction(scriptText, name)).join("\n\n");
  return run("bash", ["-c", `set -euo pipefail\n${functions}\n${body}`]);
}

test("Hermes gateway smoke shell scripts pass bash syntax validation", () => {
  const result = run("bash", ["-n", joinScript, e2eScript, referenceMatrixScript, entrypointScript]);
  assertSuccess(result, "bash -n");
});

test("reference matrix help exposes bounded-run and receipt controls", () => {
  const result = run("bash", [referenceMatrixScript, "--help"]);
  assertSuccess(result, "hermes-gateway-reference-matrix.sh --help");
  assert.match(result.stdout, /REFERENCE_RUNS=20/u);
  assert.match(result.stdout, /REFERENCE_DELAY_SECONDS=11/u);
  assert.match(result.stdout, /REFERENCE_RECEIPT/u);
  assert.match(result.stdout, /delete-disposable-companies/u);
  assert.match(result.stdout, /strict Paperclip\/Hermes Docker E2E/u);
  assert.match(result.stdout, /never starts the\s+Paperclip server/u);
});

test("reference matrix accepts only a tied disposable local boundary", () => {
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv(),
  });
  assertSuccess(result, "reference boundary validation");
});

test("reference matrix rejects a remote or production Paperclip destination", () => {
  for (const paperclipUrl of ["https://paperclip.example.com", "http://127.0.0.1:3100"]) {
    const result = run("bash", [referenceMatrixScript, "--validate-config"], {
      env: referenceEnv({
        PAPERCLIP_API_URL: paperclipUrl,
        PAPERCLIP_API_URL_FOR_HERMES: "http://host.docker.internal:3100",
      }),
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /loopback|production port/u);
  }
});

test("reference matrix rejects a model endpoint not tied to the local mock", () => {
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv({ HERMES_REFERENCE_MOCK_BASE_URL: "https://api.example.com/v1" }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /tie exactly to the local reference mock port/u);
});

test("reference matrix rejects real provider credentials without revealing them", () => {
  const secret = "xai-real-secret-must-not-appear";
  const result = run("bash", [referenceMatrixScript, "--validate-config"], {
    env: referenceEnv({ XAI_API_KEY: secret }),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /XAI_API_KEY must be unset/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret, "u"));
});

test("Hermes gateway smoke help documents operator safety flags", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = run("bash", [script, "--help"]);
    assertSuccess(result, `${path.basename(script)} --help`);
    assert.match(result.stdout, /HERMES_GATEWAY_API_BASE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_PROBE_URL/);
    assert.match(result.stdout, /HERMES_GATEWAY_ALLOW_INSECURE_HTTP/);
    assert.match(result.stdout, /redact|redacted|Raw .*keys are redacted/i);
  }

  const e2eHelp = run("bash", [e2eScript, "--help"]).stdout;
  assert.match(e2eHelp, /HERMES_SMOKE_KEEP/);
  assert.match(e2eHelp, /HERMES_SMOKE_STRICT_CLEANUP/);
  assert.match(e2eHelp, /HERMES_SMOKE_DELETE_COMPANY/);
  assert.match(e2eHelp, /HERMES_SMOKE_NETWORK/);
  assert.match(e2eHelp, /HERMES_SMOKE_MODEL_DEFAULT/);
  assert.match(e2eHelp, /Docker/);
});

test("E2E helper can seed a minimal Hermes model config without secrets", () => {
  const result = runBashFunctions(
    e2eScript,
    ["log", "fail", "yaml_single_quote", "write_hermes_model_config"],
    `
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
HERMES_SMOKE_STATE_DIR="$tmp"
HERMES_SMOKE_MODEL_PROVIDER="openrouter"
HERMES_SMOKE_MODEL_DEFAULT="z-ai/glm-5.2"
HERMES_SMOKE_MODEL_BASE_URL="https://openrouter.ai/api/v1"
mkdir -p "$HERMES_SMOKE_STATE_DIR/hermes-home"
write_hermes_model_config
config="$HERMES_SMOKE_STATE_DIR/hermes-home/config.yaml"
grep -Fq "default: 'z-ai/glm-5.2'" "$config"
grep -Fq "provider: 'openrouter'" "$config"
grep -Fq "base_url: 'https://openrouter.ai/api/v1'" "$config"
grep -Fq "command_allowlist:" "$config"
grep -Fq -- "- execute_code" "$config"
! grep -Eiq "api[_-]?key|token|secret" "$config"
`,
  );
  assertSuccess(result, "write_hermes_model_config");
});

test("join helper redacts known secrets without exposing raw key material", () => {
  const result = runBashFunctions(
    joinScript,
    ["redact_text"],
    `
HERMES_GATEWAY_API_KEY="gateway-secret"
CLAIM_SECRET="claim-secret"
AGENT_API_KEY="agent-secret"
PAPERCLIP_API_KEY="paperclip-secret"
PAPERCLIP_AUTH_HEADER="Bearer board-secret"
PAPERCLIP_COOKIE="session=board-cookie"
output="$(redact_text "gateway-secret claim-secret agent-secret paperclip-secret Bearer board-secret session=board-cookie")"
[[ "$output" != *"gateway-secret"* ]]
[[ "$output" != *"claim-secret"* ]]
[[ "$output" != *"agent-secret"* ]]
[[ "$output" != *"paperclip-secret"* ]]
[[ "$output" != *"board-secret"* ]]
[[ "$output" != *"board-cookie"* ]]
[[ "$output" == *"[redacted len=14]"* ]]
`,
  );
  assertSuccess(result, "redact_text");
});

test("URL helpers distinguish loopback HTTP from unsafe remote HTTP", () => {
  for (const script of [joinScript, e2eScript]) {
    const result = runBashFunctions(
      script,
      ["url_host", "is_loopback_http_host", "is_remote_plain_http"],
      `
is_remote_plain_http "http://192.168.1.20:8642"
is_remote_plain_http "http://hermes-gateway.local:8642"
is_remote_plain_http "http://127.example.com:8642"
is_remote_plain_http "http://localhost.evil:8642"
! is_remote_plain_http "https://192.168.1.20:8642"
! is_remote_plain_http "http://127.0.0.1:8642"
! is_remote_plain_http "http://127.44.55.66:8642"
! is_remote_plain_http "http://localhost:8642"
! is_remote_plain_http "http://[::1]:8642"
[[ "$(url_host "http://[::1]:8642/health")" == "::1" ]]
[[ "$(url_host "http://127.example.com:8642/health")" == "127.example.com" ]]
`,
    );
    assertSuccess(result, `${path.basename(script)} URL helpers`);
  }
});

test("join helper normalizes trailing slashes for URL comparisons", () => {
  const result = runBashFunctions(
    joinScript,
    ["strip_trailing_slash"],
    `
[[ "$(strip_trailing_slash "http://127.0.0.1:8642///")" == "http://127.0.0.1:8642" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/")" == "https://gateway.example.com" ]]
[[ "$(strip_trailing_slash "https://gateway.example.com/path/")" == "https://gateway.example.com/path" ]]
`,
  );
  assertSuccess(result, "strip_trailing_slash");
});
