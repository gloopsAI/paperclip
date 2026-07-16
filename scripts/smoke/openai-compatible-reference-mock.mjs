#!/usr/bin/env node

import http from "node:http";
import process from "node:process";

const host = process.env.MOCK_LLM_HOST ?? "0.0.0.0";
const port = Number(process.env.MOCK_LLM_PORT ?? "8787");

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function collectText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).join("\n");
  if (!value || typeof value !== "object") return "";
  return Object.values(value).map(collectText).join("\n");
}

function responseText(body) {
  const text = collectText(body);
  const marker = text.match(/(?:HERMES_DIRECT_OK|HERMES_PAPERCLIP_E2E_OK)_[A-Za-z0-9_.-]+/u)?.[0];
  return marker ?? "REFERENCE_MOCK_ACK";
}

function streamingJson(res, body, content, toolCall = null) {
  const id = `chatcmpl-reference-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const chunk = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model ?? "reference-mock",
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };
  chunk({ role: "assistant" });
  if (toolCall) {
    chunk({
      tool_calls: [
        {
          index: 0,
          id: toolCall.id,
          type: "function",
          function: { name: toolCall.name, arguments: toolCall.arguments },
        },
      ],
    }, "tool_calls");
    res.end("data: [DONE]\n\n");
    return;
  }
  chunk({ content });
  chunk({}, "stop");
  res.end("data: [DONE]\n\n");
}

function paperclipToolCall(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.some((message) => message?.role === "tool")) return null;
  const text = collectText(messages);
  const marker = text.match(/HERMES_PAPERCLIP_E2E_OK_[A-Za-z0-9_.-]+/u)?.[0];
  const issueId =
    text.match(/PAPERCLIP_TASK_ID=([0-9a-f-]{36})/iu)?.[1] ??
    text.match(/"issueId"\s*:\s*"([0-9a-f-]{36})"/iu)?.[1] ??
    text.match(/"issue"\s*:\s*\{[^}]*"id"\s*:\s*"([0-9a-f-]{36})"/iu)?.[1];
  const apiUrl =
    text.match(/PAPERCLIP_API_URL=(https?:\/\/[^\s]+)/iu)?.[1] ??
    text.match(/Paperclip API URL:\s*(https?:\/\/[^\s]+)/iu)?.[1];
  const runId =
    text.match(/PAPERCLIP_RUN_ID=([0-9a-f-]{36})/iu)?.[1] ??
    text.match(/Run ID:\s*([0-9a-f-]{36})/iu)?.[1];
  if (!marker || !issueId || !apiUrl || !runId) return null;

  const code = [
    "import json, urllib.request",
    "with open('/home/hermes/workspace/paperclip-claimed-api-key.json', encoding='utf-8') as handle:",
    "    token = json.load(handle)['token']",
    `base = ${JSON.stringify(apiUrl.replace(/[.,;)]$/u, "").replace(/\/$/u, ""))}`,
    `issue_id = ${JSON.stringify(issueId)}`,
    `run_id = ${JSON.stringify(runId)}`,
    `marker = ${JSON.stringify(marker)}`,
    "headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-Paperclip-Run-Id': run_id}",
    "def send(method, path, payload):",
    "    request = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=headers, method=method)",
    "    with urllib.request.urlopen(request, timeout=15) as response:",
    "        return response.status",
    "send('POST', '/api/issues/' + issue_id + '/comments', {'body': marker})",
    "send('PATCH', '/api/issues/' + issue_id, {'status': 'done'})",
    "print('PAPERCLIP_REFERENCE_TASK_DONE')",
  ].join("\n");
  return {
    id: `call-reference-${Date.now()}`,
    name: "execute_code",
    arguments: JSON.stringify({ code }),
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/models")) {
    json(
      res,
      200,
      req.url === "/health"
        ? { status: "ok" }
        : { object: "list", data: [{ id: "reference-mock", object: "model" }] },
    );
    return;
  }

  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    json(res, 404, { error: { message: "unsupported reference-mock route" } });
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      json(res, 400, { error: { message: "invalid JSON" } });
      return;
    }

    const content = responseText(body);
    const toolCall = paperclipToolCall(body);
    const toolNames = Array.isArray(body.tools)
      ? body.tools
        .map((tool) => tool?.function?.name)
        .filter((name) => typeof name === "string")
      : [];
    process.stdout.write(
      `${JSON.stringify({ event: "mock_completion", path: req.url, model: body.model ?? null, streaming: body.stream === true, toolNames, action: toolCall ? "execute_code" : "respond", content })}\n`,
    );
    if (body.stream === true) {
      streamingJson(res, body, content, toolCall);
      return;
    }
    json(res, 200, {
      id: `chatcmpl-reference-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "reference-mock",
      choices: [
        {
          index: 0,
          message: toolCall
            ? { role: "assistant", content: null, tool_calls: [{ id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] }
            : { role: "assistant", content },
          finish_reason: toolCall ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    });
  });
});

server.listen(port, host, () => {
  process.stdout.write(`${JSON.stringify({ event: "reference_mock_ready", host, port })}\n`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
