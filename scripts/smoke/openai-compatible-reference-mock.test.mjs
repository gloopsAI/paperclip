import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let child;
let baseUrl;

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitUntilReady(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The child may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("reference mock did not become ready");
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(here, "openai-compatible-reference-mock.mjs")], {
    env: { ...process.env, MOCK_LLM_HOST: "127.0.0.1", MOCK_LLM_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitUntilReady(baseUrl);
});

after(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
});

test("returns a non-streaming marker completion", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "reference-mock",
      messages: [{ role: "user", content: "Reply HERMES_DIRECT_OK_unit-test" }],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, "HERMES_DIRECT_OK_unit-test");
  assert.equal(payload.choices[0].finish_reason, "stop");
});

test("returns standards-compatible streaming completion frames", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "reference-mock",
      stream: true,
      messages: [{ role: "user", content: "Reply HERMES_DIRECT_OK_stream-test" }],
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/u);
  const body = await response.text();
  assert.match(body, /HERMES_DIRECT_OK_stream-test/u);
  assert.match(body, /"finish_reason":"stop"/u);
  assert.match(body, /data: \[DONE\]/u);
});

test("emits one bounded execute_code call for a Paperclip smoke issue", async () => {
  const issueId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "reference-mock",
      messages: [
        {
          role: "user",
          content: [
            `- Run ID: ${runId}`,
            "- Paperclip API URL: http://host.docker.internal:3189",
            "HERMES_PAPERCLIP_E2E_OK_tool-test",
            JSON.stringify({ issue: { id: issueId, identifier: "HER-1" } }),
          ].join("\n"),
        },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].finish_reason, "tool_calls");
  const call = payload.choices[0].message.tool_calls[0];
  assert.equal(call.function.name, "execute_code");
  const { code } = JSON.parse(call.function.arguments);
  assert.match(code, new RegExp(issueId, "u"));
  assert.match(code, new RegExp(runId, "u"));
  assert.match(code, /paperclip-claimed-api-key\.json/u);
  assert.match(code, /'status': 'done'/u);
  assert.doesNotMatch(code, /Bearer\s+[A-Za-z0-9_-]{16,}/u);
});

test("stops requesting tools after a tool result", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "reference-mock",
      messages: [
        {
          role: "user",
          content: [
            "- Run ID: 22222222-2222-4222-8222-222222222222",
            "- Paperclip API URL: http://host.docker.internal:3189",
            "HERMES_PAPERCLIP_E2E_OK_tool-test",
            JSON.stringify({ issue: { id: "11111111-1111-4111-8111-111111111111" } }),
          ].join("\n"),
        },
        { role: "tool", tool_call_id: "call-1", content: "PAPERCLIP_REFERENCE_TASK_DONE" },
      ],
    }),
  });
  const payload = await response.json();
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.equal(payload.choices[0].message.content, "HERMES_PAPERCLIP_E2E_OK_tool-test");
});
