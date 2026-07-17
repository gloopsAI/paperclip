import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  asNumber,
  asString,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import {
  PAPERCLIP_EXECUTION_CONTEXT_KEY,
  assertPromptFitsInvocationBudget,
  hasProhibitedGrokApiConfiguration,
  readBoundExecutionContext,
  renderBoundExecutionContext,
} from "@paperclipai/adapter-utils/execution-envelope";
import {
  ADAPTER_TYPE,
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
  STOP_GRACE_MS,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

type SessionKeyStrategy = "issue" | "agent" | "run" | "none";

type SseFrame = {
  event: string | null;
  data: string;
};

type HermesHttpError = Error & {
  status?: number;
  code?: string;
  retryNotBefore?: string | null;
  body?: unknown;
};

type TerminalState = {
  runId: string;
  status: string;
  eventName?: string | null;
  payload?: Record<string, unknown> | null;
  output?: string | null;
};

const execFileAsync = promisify(execFile);
const GIT_SHA = /^[0-9a-f]{40}$/;
const ZERO_USAGE: UsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

type ExecutionState = {
  runId: string;
  outputChunks: string[];
  lastEventName: string | null;
  terminal: TerminalState | null;
  resolveTerminal: (state: TerminalState) => void;
  terminalPromise: Promise<TerminalState>;
  toolCallCount: number;
  toolCallIds: Set<string>;
  outputBytes: number;
};

type TextRedactor = (value: string) => string;

const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);

const SENSITIVE_KEY_PATTERN =
  /(^|[_-])(auth|authorization|token|secret|password|api[_-]?key|private[_-]?key)([_-]|$)/i;
const BEARER_TOKEN_PATTERN = /Bearer\s+\S+/gi;
const HERMES_SESSION_KEY_HEADER_PATTERN = /(X-Hermes-Session-Key\s*[:=]\s*)([^\s,;]+)/gi;
const PAPERCLIP_SESSION_KEY_PATTERN =
  /\bpaperclip:(?:company:[A-Za-z0-9-]+:agent:[A-Za-z0-9-]+(?::(?:issue|run):[A-Za-z0-9-]+)?|run:[A-Za-z0-9-]+)\b/gi;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "cancelled",
  "canceled",
  "stopped",
  "interrupted",
]);

const FAILURE_STATUSES = new Set(["failed", "error"]);
const CANCELLED_STATUSES = new Set(["cancelled", "canceled", "stopped", "interrupted"]);
const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseNonNegativeNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string"
      ? Number.parseFloat(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, parsed);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeSessionKeyStrategy(value: unknown): SessionKeyStrategy {
  const raw = asString(value, "issue").trim().toLowerCase();
  if (raw === "agent" || raw === "run" || raw === "none") return raw;
  return "issue";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (
      url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
      HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
    ) {
      url.pathname = "/api";
    } else {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    url.search = "";
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function apiUrl(baseUrl: URL, path: string): string {
  const base = baseUrl.toString().replace(/\/+$/, "");
  return `${base}${path}`;
}

function issueIdFromContext(ctx: AdapterExecutionContext): string | null {
  return nonEmpty(ctx.context.taskId) ?? nonEmpty(ctx.context.issueId);
}

export function resolveSessionKey(input: {
  strategy: SessionKeyStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
}): string | null {
  if (input.strategy === "none") return null;
  if (input.strategy === "agent") {
    return `paperclip:company:${input.companyId}:agent:${input.agentId}`;
  }
  if (input.strategy === "run") {
    return `paperclip:run:${input.runId}`;
  }
  const issuePart = input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`;
  return `paperclip:company:${input.companyId}:agent:${input.agentId}:${issuePart}`;
}

function stringifyForLog(value: unknown, maxChars = 4_000): string {
  const text = JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

function sanitizeSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(HERMES_SESSION_KEY_HEADER_PATTERN, "$1[redacted]")
    .replace(PAPERCLIP_SESSION_KEY_PATTERN, "[redacted-session-key]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTextRedactor(secrets: Array<string | null | undefined>): TextRedactor {
  const exactSecrets = [...new Set(secrets.filter((secret): secret is string => typeof secret === "string" && secret.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((secret) => ({
      secret,
      regex: new RegExp(escapeRegExp(secret), "g"),
    }));

  return (value: string) => {
    let result = sanitizeSensitiveText(value);
    for (const entry of exactSecrets) {
      result = result.replace(entry.regex, `[redacted len=${entry.secret.length}]`);
    }
    return result;
  };
}

function redactForLog(value: unknown, keyPath: string[] = [], depth = 0, redactText: TextRedactor = sanitizeSensitiveText): unknown {
  const key = keyPath[keyPath.length - 1] ?? "";
  if (typeof value === "string") {
    if (SENSITIVE_KEY_PATTERN.test(key)) return `[redacted len=${value.length}]`;
    const sanitized = redactText(value);
    return sanitized.length > 500
      ? `${sanitized.slice(0, 500)}... [truncated ${sanitized.length - 500} chars]`
      : sanitized;
  }
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth > 5) return "[array-truncated]";
    return value.slice(0, 40).map((entry, index) => redactForLog(entry, [...keyPath, String(index)], depth + 1, redactText));
  }
  if (typeof value === "object") {
    if (depth > 5) return "[object-truncated]";
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[entryKey] = redactForLog(entryValue, [...keyPath, entryKey], depth + 1, redactText);
    }
    return out;
  }
  return redactText(String(value));
}

function parseHeaders(value: unknown): Record<string, string> {
  const source =
    typeof value === "string" && value.trim().length > 0
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  const parsed = parseObject(source);
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = key.trim();
    if (!normalized || CRITICAL_HEADERS.has(normalized.toLowerCase())) continue;
    if (typeof entry === "string") headers[normalized] = entry;
  }
  return headers;
}

function buildHeaders(input: {
  apiKey: string;
  sessionKey: string | null;
  runId: string;
  extraHeaders: Record<string, string>;
  accept: string;
  contentType?: string;
}): Record<string, string> {
  return {
    ...input.extraHeaders,
    Authorization: `Bearer ${input.apiKey}`,
    Accept: input.accept,
    ...(input.contentType ? { "Content-Type": input.contentType } : {}),
    "Idempotency-Key": input.runId,
    ...(input.sessionKey ? { "X-Hermes-Session-Key": input.sessionKey } : {}),
  };
}

export function buildInput(ctx: AdapterExecutionContext, paperclipApiUrl: string | null): string {
  const rawBinding = ctx.context[PAPERCLIP_EXECUTION_CONTEXT_KEY];
  const binding = readBoundExecutionContext(rawBinding);
  if (rawBinding !== undefined && rawBinding !== null && !binding) {
    const error = new Error("Bound execution context failed validation") as Error & { code?: string };
    error.code = "execution_context.invalid_binding";
    throw error;
  }
  if (binding) {
    return [
      `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
      "",
      "Execution contract:",
      "- Continue only the bound work packet below.",
      "- Preserve its authority, exact-head, verification, and continuation constraints.",
      "- Do not reconstruct or request legacy transcript/task context.",
      "- Leave a terminal execution-truth receipt or an explicitly bounded continuation.",
      "",
      renderBoundExecutionContext(binding),
    ].join("\n");
  }
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake);
  const wakePayloadJson = stringifyPaperclipWakePayload(ctx.context.paperclipWake);
  const taskMarkdown = nonEmpty(ctx.context.paperclipTaskMarkdown);
  const sessionHandoff = nonEmpty(ctx.context.paperclipSessionHandoffMarkdown);
  const issueWorkMode = readPaperclipIssueWorkModeFromContext(ctx.context);
  const lines = [
    `You are ${ctx.agent.name}, an AI agent employee in a Paperclip-managed company.`,
    "",
    "Paperclip runtime identity:",
    `- Agent ID: ${ctx.agent.id}`,
    `- Company ID: ${ctx.agent.companyId}`,
    `- Run ID: ${ctx.runId}`,
    ...(paperclipApiUrl ? [`- Paperclip API URL: ${paperclipApiUrl}`] : []),
    ...(issueWorkMode ? [`- Issue work mode: ${issueWorkMode}`] : []),
    "",
    "Execution contract:",
    "- Take concrete action in this run when the task is actionable.",
    "- Do not stop at a plan unless the issue asks for planning only.",
    "- Leave durable progress and update the issue to a clear final disposition.",
    "- Use X-Paperclip-Run-Id on mutating Paperclip API requests when a Paperclip API key is available.",
    "",
    wakePrompt,
    ...(sessionHandoff ? ["", sessionHandoff] : []),
    ...(taskMarkdown ? ["", taskMarkdown] : []),
    ...(wakePayloadJson
      ? [
          "",
          "Structured wake payload JSON:",
          "```json",
          wakePayloadJson,
          "```",
        ]
      : []),
  ];
  return lines.filter((line) => line !== null && line !== undefined).join("\n").trim();
}

export function buildRunBody(ctx: AdapterExecutionContext, sessionKey: string | null): Record<string, unknown> {
  const paperclipApiUrl = nonEmpty(ctx.config.paperclipApiUrl);
  const payloadTemplate = parseObject(ctx.config.payloadTemplate);
  if (hasProhibitedGrokApiConfiguration({ adapterConfig: ctx.config, payloadTemplate })) {
    const error = new Error("Grok/xAI API configuration is forbidden before Hermes dispatch") as Error & { code?: string };
    error.code = "execution_route.prohibited_grok_api";
    throw error;
  }
  const binding = readBoundExecutionContext(ctx.context[PAPERCLIP_EXECUTION_CONTEXT_KEY]);
  const input = binding ? buildInput(ctx, paperclipApiUrl) : nonEmpty(payloadTemplate.input) ?? buildInput(ctx, paperclipApiUrl);
  assertPromptFitsInvocationBudget(input, ctx.executionBudget);
  const instructions =
    nonEmpty(ctx.config.instructions) ??
    nonEmpty(payloadTemplate.instructions) ??
    "Follow the Paperclip wake instructions exactly. Do not expose secrets in logs, comments, or final output.";
  return {
    ...payloadTemplate,
    input,
    instructions,
    ...(ctx.executionBudget ? { execution_budget: ctx.executionBudget } : {}),
    ...(sessionKey ? { session_id: sessionKey } : {}),
  };
}

async function readResponseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function classifyHttpError(status: number): { code: string; family: AdapterExecutionResult["errorFamily"] | null } {
  if (status === 401 || status === 403) return { code: "hermes_gateway_auth_failed", family: null };
  if (status === 404) return { code: "hermes_gateway_runs_unsupported", family: null };
  if (status === 429) return { code: "hermes_gateway_rate_limited", family: "transient_upstream" };
  if (status >= 500) return { code: "hermes_gateway_upstream_error", family: "transient_upstream" };
  return { code: "hermes_gateway_protocol_error", family: null };
}

function fetchFailureMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
}

async function fetchJson(input: RequestInfo | URL, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, init);
  } catch (err) {
    const fetchErr = new Error(`Hermes gateway request failed: ${fetchFailureMessage(err)}`) as HermesHttpError;
    fetchErr.code = "hermes_gateway_connect_failed";
    throw fetchErr;
  }
  const body = await readResponseJson(response);
  if (!response.ok) {
    const classified = classifyHttpError(response.status);
    const err = new Error(`Hermes gateway HTTP ${response.status}`) as HermesHttpError;
    err.status = response.status;
    err.code = classified.code;
    err.retryNotBefore = response.headers.get("retry-after");
    err.body = body;
    throw err;
  }
  return body;
}

async function fetchJsonBeforeDeadline(
  input: RequestInfo | URL,
  init: RequestInit,
  deadlineAt: number,
): Promise<unknown> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("Hermes gateway reconciliation deadline expired");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await fetchJson(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractRunId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.run_id) ?? nonEmpty(record?.runId) ?? nonEmpty(record?.id);
}

function eventNameFromData(data: unknown, fallback: string | null): string | null {
  const record = asRecord(data);
  return nonEmpty(record?.event) ?? nonEmpty(record?.type) ?? fallback;
}

function parseJsonData(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return { text: data };
  }
}

export function parseSseFramesForTest(buffer: string): { frames: SseFrame[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames: SseFrame[] = [];
  let offset = 0;
  while (true) {
    const idx = normalized.indexOf("\n\n", offset);
    if (idx < 0) break;
    const rawFrame = normalized.slice(offset, idx);
    offset = idx + 2;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of rawFrame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest: normalized.slice(offset) };
}

function createExecutionState(runId: string): ExecutionState {
  let resolveTerminal!: (state: TerminalState) => void;
  const terminalPromise = new Promise<TerminalState>((resolve) => {
    resolveTerminal = resolve;
  });
  return {
    runId,
    outputChunks: [],
    lastEventName: null,
    terminal: null,
    resolveTerminal,
    terminalPromise,
    toolCallCount: 0,
    toolCallIds: new Set<string>(),
    outputBytes: 0,
  };
}

function markTerminal(state: ExecutionState, terminal: TerminalState): void {
  if (state.terminal) return;
  state.terminal = terminal;
  state.resolveTerminal(terminal);
}

function extractStatus(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.status)?.toLowerCase() ?? null;
}

function extractOutput(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const direct =
    nonEmpty(record.output) ??
    nonEmpty(record.result) ??
    nonEmpty(record.text) ??
    nonEmpty(record.summary) ??
    nonEmpty(record.message);
  if (direct) return direct;
  const nested = asRecord(record.data) ?? asRecord(record.payload);
  return nested ? extractOutput(nested) : null;
}

async function handleEvent(
  ctx: AdapterExecutionContext,
  state: ExecutionState,
  frame: SseFrame,
  redactText: TextRedactor = sanitizeSensitiveText,
): Promise<void> {
  const parsed = parseJsonData(frame.data);
  const record = asRecord(parsed);
  const eventName = eventNameFromData(parsed, frame.event);
  state.lastEventName = eventName;
  await ctx.onLog(
    "stdout",
    `[hermes-gateway:event] run=${state.runId} event=${eventName ?? "message"} data=${stringifyForLog(redactForLog(parsed, [], 0, redactText), 8_000)}\n`,
  );

  const delta = nonEmpty(record?.delta) ?? nonEmpty(record?.text_delta);
  if (eventName === "message.delta" && delta) {
    const sanitizedDelta = redactText(delta);
    state.outputChunks.push(sanitizedDelta);
    state.outputBytes += Buffer.byteLength(sanitizedDelta, "utf8");
    await ctx.onLog("stdout", sanitizedDelta);
  }

  const toolCallId = nonEmpty(record?.toolCallId) ?? nonEmpty(record?.tool_call_id);
  const toolStarted = eventName === "tool.started" ||
    (eventName === "hermes.tool.progress" && record?.status === "running");
  if (toolStarted && (!toolCallId || !state.toolCallIds.has(toolCallId))) {
    if (toolCallId) state.toolCallIds.add(toolCallId);
    state.toolCallCount += 1;
  }

  const budget = ctx.executionBudget;
  const estimatedOutputTokens = Math.ceil(state.outputBytes / 4);
  const exceeded = budget
    ? state.toolCallCount > budget.maxToolCalls
      ? "tool_calls"
      : state.toolCallCount + 1 > budget.maxTurns
        ? "turns"
        : estimatedOutputTokens > budget.maxOutputTokens
          ? "output_tokens"
          : null
    : null;
  if (exceeded) {
    markTerminal(state, {
      runId: state.runId,
      status: "failed",
      eventName: "execution.budget_exceeded",
      payload: {
        error: `Hermes run stopped after exceeding reserved ${exceeded}`,
        error_code: "execution_admission.provider_budget_exceeded",
        exceeded,
        tool_call_count: state.toolCallCount,
        estimated_output_tokens: estimatedOutputTokens,
      },
    });
    return;
  }

  const status = extractStatus(parsed) ?? (eventName?.startsWith("run.") ? eventName.slice(4) : null);
  if (status && TERMINAL_STATUSES.has(status)) {
    markTerminal(state, {
      runId: state.runId,
      status,
      eventName,
      payload: record,
      output: extractOutput(parsed),
    });
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function pollStatus(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  intervalMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    await delay(input.intervalMs, input.signal);
    if (input.signal.aborted || input.state.terminal) break;
    try {
      const status = await fetchJson(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) {
        markTerminal(input.state, {
          runId: input.state.runId,
          status: normalized,
          payload: asRecord(status),
          output: extractOutput(status),
        });
      }
    } catch (err) {
      if (input.signal.aborted) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] status poll failed: ${redactErrorMessage(err, input.redactText)}\n`);
    }
  }
}

async function consumeEvents(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  state: ExecutionState;
  signal: AbortSignal;
  reconnectMs: number;
  redactText?: TextRedactor;
}): Promise<void> {
  while (!input.signal.aborted && !input.state.terminal) {
    try {
      const response = await fetch(apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.state.runId)}/events`), {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
      });
      if (!response.ok) {
        await input.ctx.onLog("stderr", `[hermes-gateway] event stream HTTP ${response.status}; falling back to polling\n`);
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      if (!response.body) {
        await input.ctx.onLog("stderr", "[hermes-gateway] event stream response had no body; falling back to polling\n");
        await delay(input.reconnectMs, input.signal);
        continue;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!input.signal.aborted && !input.state.terminal) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            const parsed = parseSseFramesForTest(`${buffer}\n\n`);
            buffer = parsed.rest;
            for (const frame of parsed.frames) {
              await handleEvent(input.ctx, input.state, frame, input.redactText);
              if (input.state.terminal) break;
            }
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFramesForTest(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          await handleEvent(input.ctx, input.state, frame, input.redactText);
          if (input.state.terminal) break;
        }
      }
    } catch (err) {
      if (input.signal.aborted || input.state.terminal) return;
      await input.ctx.onLog("stderr", `[hermes-gateway] event stream disconnected: ${redactErrorMessage(err, input.redactText)}\n`);
    }
    if (!input.state.terminal) await delay(input.reconnectMs, input.signal);
  }
}

function parseUsage(value: unknown): UsageSummary | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const source = asRecord(record.usage) ?? record;
  const inputTokens = asNumber(source.input_tokens ?? source.inputTokens ?? source.input, 0);
  const outputTokens = asNumber(source.output_tokens ?? source.outputTokens ?? source.output, 0);
  const cachedInputTokens = asNumber(source.cached_input_tokens ?? source.cachedInputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0 && cachedInputTokens <= 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
  };
}

function parseCostUsd(value: unknown): number | null {
  const record = asRecord(value);
  const raw = record?.cost_usd ?? record?.costUsd ?? asRecord(record?.usage)?.cost_usd ?? asRecord(record?.usage)?.costUsd;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSessionId(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.session_id) ?? nonEmpty(record?.sessionId) ?? nonEmpty(asRecord(record?.data)?.session_id);
}

function extractModel(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.model) ?? nonEmpty(asRecord(record?.usage)?.model);
}

function extractErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return nonEmpty(record?.error) ?? nonEmpty(record?.message) ?? nonEmpty(record?.detail) ?? extractOutput(value);
}

function executionRoute(model: string | null) {
  const providerId = model?.includes("/") ? model.split("/", 1)[0] : "hermes";
  return {
    provider_id: providerId,
    model_id: model,
    transport: "api",
    path_id: model?.includes("/") ? `${providerId}-cloud` : "hermes-gateway",
    runner: "hermes_gateway",
  };
}

function deterministicRefusal(input: {
  errorCode: string;
  errorMessage: string;
  model?: string | null;
  resultJson?: Record<string, unknown>;
}): AdapterExecutionResult {
  const model = input.model ?? null;
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
    providerInvocationAttempted: false,
    provider: "hermes_gateway",
    model,
    usage: ZERO_USAGE,
    usageBasis: "per_run",
    resultJson: {
      provider_invocation: { attempted: false },
      execution_route: executionRoute(model),
      ...input.resultJson,
    },
  };
}

function mergeTerminalPayload(
  terminal: TerminalState,
  finalStatus: Record<string, unknown> | null,
): TerminalState {
  if (!finalStatus) return terminal;
  const current = terminal.payload ?? {};
  const currentUsage = parseUsage(current);
  const finalUsage = parseUsage(finalStatus);
  return {
    ...terminal,
    status: extractStatus(finalStatus) ?? terminal.status,
    payload: {
      ...finalStatus,
      ...current,
      ...(!currentUsage && finalUsage ? { usage: finalStatus.usage } : {}),
      ...(!extractModel(current) && extractModel(finalStatus) ? { model: extractModel(finalStatus) } : {}),
    },
    output: terminal.output ?? extractOutput(finalStatus),
  };
}

function expectedWorkspaceHead(
  ctx: AdapterExecutionContext,
  binding: ReturnType<typeof readBoundExecutionContext>,
): { error: string } | { expected: string | null } {
  const configured = nonEmpty(ctx.config.expectedWorkspaceHeadSha)?.toLowerCase() ?? null;
  const packet: Record<string, unknown> = binding?.packet ?? {};
  const verification = asRecord(packet.verification);
  const workspace = asRecord(packet.workspace);
  const packetHead = (
    nonEmpty(verification?.exactHeadSha) ??
    nonEmpty(workspace?.exactHeadSha) ??
    nonEmpty(workspace?.headSha)
  )?.toLowerCase() ?? null;
  if (configured && packetHead && configured !== packetHead) {
    return { error: `Configured workspace head ${configured} does not match bound packet head ${packetHead}.` };
  }
  const expected = configured ?? packetHead;
  if (!expected) return { expected: null };
  if (!GIT_SHA.test(expected)) return { error: `Expected workspace head must be a full 40-character commit SHA; received ${expected}.` };
  return { expected };
}

async function verifyWorkspaceBeforeDispatch(
  ctx: AdapterExecutionContext,
  binding: ReturnType<typeof readBoundExecutionContext>,
): Promise<{ expected: string; actual: string; clean: true } | { error: string; expected?: string | null; actual?: string | null } | null> {
  const resolved = expectedWorkspaceHead(ctx, binding);
  if ("error" in resolved) return { error: resolved.error };
  const expected = resolved.expected;
  if (!expected) return null;
  const workspace = asRecord(ctx.context.paperclipWorkspace);
  const cwd = nonEmpty(workspace?.cwd);
  if (!cwd) return { error: "Exact workspace head was declared, but Paperclip did not provide a workspace cwd.", expected };
  try {
    const [{ stdout: headOutput }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd }),
    ]);
    const actual = headOutput.trim().toLowerCase();
    if (actual !== expected) {
      return { error: `Workspace HEAD ${actual || "unknown"} does not match declared head ${expected}.`, expected, actual: actual || null };
    }
    if (statusOutput.trim()) {
      return { error: "Workspace contains uncommitted or untracked changes.", expected, actual };
    }
    return { expected, actual, clean: true };
  } catch (error) {
    return { error: `Workspace Git validation failed: ${error instanceof Error ? error.message : String(error)}`, expected };
  }
}

function terminalResultCode(status: string): { exitCode: number; signal: string | null; errorCode: string | null } {
  if (status === "completed") return { exitCode: 0, signal: null, errorCode: null };
  if (FAILURE_STATUSES.has(status)) return { exitCode: 1, signal: null, errorCode: "hermes_gateway_run_failed" };
  if (CANCELLED_STATUSES.has(status)) return { exitCode: 1, signal: "SIGTERM", errorCode: "hermes_gateway_cancelled" };
  return { exitCode: 1, signal: null, errorCode: "hermes_gateway_protocol_error" };
}

export function mapFinalResultForTest(input: {
  terminal: TerminalState;
  outputChunks: string[];
  sessionKey: string | null;
  strategy: SessionKeyStrategy;
  toolCallCount?: number;
  redactText?: TextRedactor;
}): AdapterExecutionResult {
  const redactText = input.redactText ?? sanitizeSensitiveText;
  const payload = input.terminal.payload ?? {};
  const output = redactText(
    input.terminal.output ?? extractOutput(payload) ?? input.outputChunks.join("").trim(),
  );
  const sessionId = extractSessionId(payload) ?? input.sessionKey;
  const sessionDisplayId = sessionId ? redactText(sessionId) : null;
  const mapped = terminalResultCode(input.terminal.status);
  const payloadErrorCode = nonEmpty((payload as Record<string, unknown>).error_code);
  const usage = parseUsage(payload);
  const costUsd = parseCostUsd(payload);
  const model = extractModel(payload);
  const toolCallCount = Math.max(0, Math.floor(input.toolCallCount ?? 0));
  const errorMessage = mapped.errorCode
    ? redactText(extractErrorMessage(payload) ?? `Hermes run ${input.terminal.status}`)
    : null;
  return {
    exitCode: mapped.exitCode,
    signal: mapped.signal,
    timedOut: false,
    providerInvocationAttempted: true,
    provider: "hermes_gateway",
    model,
    ...(mapped.errorCode ? { errorCode: payloadErrorCode ?? mapped.errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(usage ? { usage, usageBasis: "per_run" as const } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(output ? { summary: output.slice(0, 2_000) } : {}),
    sessionId: sessionDisplayId,
    sessionParams: {
      hermesRunId: input.terminal.runId,
      ...(sessionId && sessionDisplayId === sessionId ? { hermesSessionId: sessionId } : {}),
      strategy: input.strategy,
    },
    sessionDisplayId,
    resultJson: {
      run_id: input.terminal.runId,
      status: input.terminal.status,
      session_id: sessionDisplayId,
      last_event: input.terminal.eventName ?? null,
      output: output ?? "",
      usage: usage ?? null,
      cost_usd: costUsd,
      execution_metrics: {
        tool_calls: toolCallCount,
        turns: toolCallCount + 1,
      },
      provider_invocation: { attempted: true },
      execution_route: executionRoute(model),
    },
  };
}

async function stopRun(input: {
  ctx: AdapterExecutionContext;
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineAt: number;
  redactText?: TextRedactor;
}): Promise<Record<string, unknown> | null> {
  try {
    const stopped = await fetchJsonBeforeDeadline(
      apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}/stop`),
      { method: "POST", headers: input.headers },
      input.deadlineAt,
    );
    await input.ctx.onLog("stdout", `[hermes-gateway] stop requested for run ${input.runId}\n`);
    return asRecord(stopped);
  } catch (err) {
    await input.ctx.onLog("stderr", `[hermes-gateway] stop request failed: ${redactErrorMessage(err, input.redactText)}\n`);
    return null;
  }
}

async function fetchFinalStatus(input: {
  baseUrl: URL;
  headers: Record<string, string>;
  runId: string;
  deadlineAt: number;
}): Promise<Record<string, unknown> | null> {
  while (Date.now() < input.deadlineAt) {
    try {
      const status = await fetchJsonBeforeDeadline(
        apiUrl(input.baseUrl, `/v1/runs/${encodeURIComponent(input.runId)}`),
        { method: "GET", headers: input.headers },
        input.deadlineAt,
      );
      const record = asRecord(status);
      const normalized = extractStatus(status);
      if (normalized && TERMINAL_STATUSES.has(normalized)) return record;
    } catch {
      return null;
    }
    const delayMs = Math.min(500, Math.max(0, input.deadlineAt - Date.now()));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

function redactErrorMessage(err: unknown, redactText: TextRedactor = sanitizeSensitiveText): string {
  if (err instanceof Error) return redactText(err.message);
  return redactText(String(err));
}

function errorResult(
  err: unknown,
  redactText: TextRedactor = sanitizeSensitiveText,
  providerInvocationAttempted = true,
): AdapterExecutionResult {
  const hermesError = err as HermesHttpError;
  const code = hermesError.code ?? "hermes_gateway_protocol_error";
  const classified = hermesError.status ? classifyHttpError(hermesError.status) : null;
  const errorMessage = code === "hermes_gateway_auth_failed"
    ? `${redactErrorMessage(err, redactText)}. Check adapterConfig.apiKey matches the Hermes API_SERVER_KEY for the running gateway.`
    : redactErrorMessage(err, redactText);
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    providerInvocationAttempted,
    ...(providerInvocationAttempted
      ? {}
      : {
          provider: "hermes_gateway",
          usage: ZERO_USAGE,
          usageBasis: "per_run" as const,
          resultJson: {
            provider_invocation: { attempted: false },
            execution_route: executionRoute(null),
          },
        }),
    errorCode: code,
    errorFamily: classified?.family ?? (code === "hermes_gateway_connect_failed" ? "transient_upstream" : null),
    retryNotBefore: hermesError.retryNotBefore ?? null,
    errorMessage,
    errorMeta: {
      ...(hermesError.status ? { status: hermesError.status } : {}),
      ...(hermesError.body ? { body: redactForLog(hermesError.body, [], 0, redactText) as Record<string, unknown> } : {}),
    },
  };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const apiBaseUrlValue = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  if (!apiBaseUrlValue) {
    return deterministicRefusal({
      errorCode: "hermes_gateway_api_base_url_missing",
      errorMessage: "Hermes gateway adapter requires apiBaseUrl.",
    });
  }

  const baseUrl = normalizeBaseUrl(apiBaseUrlValue);
  if (!baseUrl) {
    return deterministicRefusal({
      errorCode: "hermes_gateway_api_base_url_invalid",
      errorMessage: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    });
  }
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(ctx.config)) {
    return deterministicRefusal({
      errorCode: "hermes_gateway_plain_http_remote_denied",
      errorMessage: remotePlainHttpDeniedMessage(baseUrl.hostname),
    });
  }

  const apiKey = nonEmpty(ctx.config.apiKey) ?? nonEmpty(ctx.config.token);
  if (!apiKey) {
    return deterministicRefusal({
      errorCode: "hermes_gateway_api_key_missing",
      errorMessage: "Hermes gateway adapter requires apiKey.",
    });
  }

  const configuredTimeoutSec = parseNonNegativeNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const timeoutSec = ctx.executionBudget
    ? Math.max(0.001, Math.min(configuredTimeoutSec || Number.POSITIVE_INFINITY, ctx.executionBudget.maxWallMs / 1000))
    : configuredTimeoutSec;
  const timeoutMs = timeoutSec > 0 ? Math.ceil(timeoutSec * 1000) : 0;
  const reconnectMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS), 250, 30_000));
  const pollIntervalMs = Math.floor(clamp(parseNonNegativeNumber(ctx.config.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS), 250, 10_000));
  const rawBinding = ctx.context[PAPERCLIP_EXECUTION_CONTEXT_KEY];
  const binding = readBoundExecutionContext(rawBinding);
  if (rawBinding !== undefined && rawBinding !== null && !binding) {
    return deterministicRefusal({
      errorCode: "execution_context.invalid_binding",
      errorMessage: "Bound execution context failed validation before provider dispatch.",
    });
  }
  const configuredStrategy = normalizeSessionKeyStrategy(ctx.config.sessionKeyStrategy);
  const strategy: SessionKeyStrategy = binding ? "none" : configuredStrategy;
  const sessionKey = resolveSessionKey({
    strategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId: issueIdFromContext(ctx),
  });
  const extraHeaders = parseHeaders(ctx.config.headers);
  const runHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "application/json",
    contentType: "application/json",
  });
  const eventHeaders = buildHeaders({
    apiKey,
    sessionKey,
    runId: ctx.runId,
    extraHeaders,
    accept: "text/event-stream",
  });
  const redactText = createTextRedactor([
    apiKey,
    sessionKey,
    runHeaders.Authorization,
    runHeaders["X-Hermes-Session-Key"],
  ]);
  let body: Record<string, unknown>;
  try {
    body = buildRunBody(ctx, sessionKey);
  } catch (error) {
    return errorResult(error, redactText, false);
  }
  const workspaceVerification = await verifyWorkspaceBeforeDispatch(ctx, binding);
  if (workspaceVerification && "error" in workspaceVerification) {
    return deterministicRefusal({
      errorCode: "workspace_validation_failed",
      errorMessage: workspaceVerification.error,
      model: nonEmpty(parseObject(body).model),
      resultJson: { workspace: workspaceVerification },
    });
  }
  const createRunUrl = apiUrl(baseUrl, "/v1/runs");

  await ctx.onMeta?.({
    adapterType: ADAPTER_TYPE,
    command: "POST /v1/runs",
    commandArgs: [createRunUrl],
    context: {
      runId: ctx.runId,
      timeoutSec,
      eventReconnectMs: reconnectMs,
      sessionKeyStrategy: strategy,
      hasSessionKey: Boolean(sessionKey),
    },
  });
  await ctx.onLog("stdout", `[hermes-gateway] creating run at ${createRunUrl} (timeout=${timeoutSec}s, session=${strategy})\n`);
  await ctx.onLog("stdout", `[hermes-gateway] request headers (redacted): ${stringifyForLog(redactForLog(runHeaders, [], 0, redactText), 3_000)}\n`);

  let runId: string | null = null;
  try {
    const created = await fetchJson(createRunUrl, {
      method: "POST",
      headers: runHeaders,
      body: JSON.stringify(body),
    });
    runId = extractRunId(created);
    if (!runId) {
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        providerInvocationAttempted: true,
        errorCode: "hermes_gateway_protocol_error",
        errorMessage: "Hermes /v1/runs response did not include run_id.",
        errorMeta: { response: redactForLog(created, [], 0, redactText) as Record<string, unknown> },
      };
    }
  } catch (err) {
    return errorResult(err, redactText);
  }

  await ctx.onLog("stdout", `[hermes-gateway] run created: ${runId}\n`);

  const state = createExecutionState(runId);
  const controller = new AbortController();
  void consumeEvents({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    reconnectMs,
    redactText,
  }).catch(() => undefined);
  void pollStatus({
    ctx,
    baseUrl,
    headers: eventHeaders,
    state,
    signal: controller.signal,
    intervalMs: pollIntervalMs,
    redactText,
  }).catch(() => undefined);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    if (timeoutMs <= 0) return;
    timeoutTimer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([state.terminalPromise, timeoutPromise]);
  if (timeoutTimer) clearTimeout(timeoutTimer);
  controller.abort();

  if (outcome !== "timeout" && outcome.eventName === "execution.budget_exceeded") {
    await stopRun({
      ctx,
      baseUrl,
      headers: eventHeaders,
      runId,
      deadlineAt: Date.now() + STOP_GRACE_MS,
      redactText,
    });
  }

  if (outcome === "timeout") {
    const cleanupDeadline = Date.now() + STOP_GRACE_MS;
    await stopRun({ ctx, baseUrl, headers: eventHeaders, runId, deadlineAt: cleanupDeadline, redactText });
    const finalStatus = await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineAt: cleanupDeadline });
    return {
      exitCode: 1,
      signal: null,
      timedOut: true,
      providerInvocationAttempted: true,
      errorCode: "hermes_gateway_timeout",
      errorMessage: `Hermes gateway run timed out after ${timeoutSec}s.`,
      provider: "hermes_gateway",
      resultJson: {
        run_id: runId,
        status: extractStatus(finalStatus) ?? "timeout",
        last_event: state.lastEventName,
        final_status: redactForLog(finalStatus, [], 0, redactText),
        provider_invocation: { attempted: true },
        execution_route: executionRoute(extractModel(finalStatus)),
        ...(workspaceVerification ? { workspace: workspaceVerification } : {}),
      },
      sessionParams: {
        hermesRunId: runId,
        strategy,
      },
      sessionDisplayId: sessionKey ? redactText(sessionKey) : null,
    };
  }

  const needsFinalReconciliation = !parseUsage(outcome.payload) || !extractModel(outcome.payload);
  const reconciliationDeadline = Date.now() + Math.min(STOP_GRACE_MS, 2_000);
  const finalStatus = needsFinalReconciliation
    ? await fetchFinalStatus({ baseUrl, headers: eventHeaders, runId, deadlineAt: reconciliationDeadline })
    : null;
  const result = mapFinalResultForTest({
    terminal: mergeTerminalPayload(outcome, finalStatus),
    outputChunks: state.outputChunks,
    sessionKey,
    strategy,
    toolCallCount: state.toolCallCount,
    redactText,
  });
  result.resultJson = {
    ...parseObject(result.resultJson),
    ...(workspaceVerification ? { workspace: workspaceVerification } : {}),
    ...(finalStatus ? { final_status_reconciled: true } : {}),
  };
  return result;
}
