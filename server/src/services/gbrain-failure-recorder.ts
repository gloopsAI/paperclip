/**
 * GBrain failure recorder (OK-09 integration).
 *
 * Process-local ring buffer of recent server-side failure events, normalized
 * through the OK-09 microplane so they can flow into context compile as
 * `knownFailures`. Advisory only — never mutates authority or downstream
 * routing decisions.
 *
 * Hard rules:
 * - In-memory only (no DB write). Episodes do not persist across restarts.
 * - Every stored entry is a normalized `FailureFingerprint` (advisory: true).
 * - Ring buffer cap (default 64) — older entries are dropped FIFO.
 * - Per-company partitioning so /recent returns only the caller's company.
 * - Recording is best-effort and never throws into the request pipeline.
 */

import {
  type FailureFingerprint,
  normalizeFailureFingerprint,
} from "./gbrain-microplane.js";

export const GBRAIN_RECENT_FINGERPRINT_SCHEMA =
  "gloops.gbrain.recent-fingerprints.v1" as const;

export const DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE = 64;
export const MAX_GBRAIN_FAILURE_BUFFER_SIZE = 256;
export const GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT = 32;

export type RecordServerFailureInput = {
  companyId?: string | null;
  errorCode: string;
  message: string;
  tool?: string | null;
  stage?: string | null;
  recoveryHint?: string | null;
  /** Optional: method+route for stage inference when caller has no stage. */
  method?: string | null;
  url?: string | null;
};

export type RecentFingerprintsResponse = {
  schemaVersion: typeof GBRAIN_RECENT_FINGERPRINT_SCHEMA;
  advisory: true;
  companyId: string | null;
  count: number;
  bufferSize: number;
  fingerprints: FailureFingerprint[];
};

type FailureEntry = FailureFingerprint & {
  companyId: string | null;
  observedAt: string;
};

const buffers = new Map<string | null, FailureEntry[]>();
let configuredSize = DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE;

function clampBufferSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) {
    return DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE;
  }
  const intSize = Math.floor(size);
  if (intSize > MAX_GBRAIN_FAILURE_BUFFER_SIZE) {
    return MAX_GBRAIN_FAILURE_BUFFER_SIZE;
  }
  return intSize;
}

function getBuffer(companyId: string | null): FailureEntry[] {
  let buf = buffers.get(companyId);
  if (!buf) {
    buf = [];
    buffers.set(companyId, buf);
  }
  return buf;
}

function pushEntry(entry: FailureEntry): void {
  const buf = getBuffer(entry.companyId);
  buf.push(entry);
  const overflow = buf.length - configuredSize;
  if (overflow > 0) {
    buf.splice(0, overflow);
  }
}

/**
 * Configure the in-memory ring buffer size. Applies to subsequent records.
 * Intended for tests + startup wiring; not a hot path.
 */
export function configureGbrainFailureBufferSize(size: number): void {
  configuredSize = clampBufferSize(size);
  for (const buf of buffers.values()) {
    if (buf.length > configuredSize) {
      buf.splice(0, buf.length - configuredSize);
    }
  }
}

/**
 * Record a server-side failure. Best-effort, never throws. Returns true when
 * the entry was stored, false when input was unusable.
 */
export function recordServerFailure(
  input: RecordServerFailureInput,
): boolean {
  if (!input || typeof input !== "object") return false;
  const errorCode = typeof input.errorCode === "string" ? input.errorCode.trim() : "";
  const message = typeof input.message === "string" ? input.message : "";
  if (!errorCode || !message) return false;

  let stage = input.stage ?? null;
  if (!stage && input.method && input.url) {
    stage = `${input.method.toUpperCase()} ${input.url}`;
  }

  let fingerprint: FailureFingerprint;
  try {
    fingerprint = normalizeFailureFingerprint({
      errorCode,
      message,
      tool: input.tool ?? null,
      stage,
      recoveryHint: input.recoveryHint ?? null,
    });
  } catch {
    return false;
  }

  const companyId =
    typeof input.companyId === "string" && input.companyId.length > 0
      ? input.companyId
      : null;

  pushEntry({
    ...fingerprint,
    companyId,
    observedAt: new Date().toISOString(),
  });
  return true;
}

function sanitizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return 10;
  const intLimit = Math.floor(limit);
  if (intLimit <= 0) return 10;
  if (intLimit > GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT) {
    return GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT;
  }
  return intLimit;
}

/**
 * Get recent failure fingerprints for a company. Newest first.
 * `limit` is clamped to [1, GBRAIN_RECENT_FINGERPRINT_HARD_LIMIT].
 */
export function getRecentFingerprints(
  companyId: string | null,
  limit: number = 10,
): RecentFingerprintsResponse {
  const safeLimit = sanitizeLimit(limit);
  const buf = companyId ? getBuffer(companyId) : [];
  const sliced = buf.slice(-safeLimit).reverse();
  const stripped: FailureFingerprint[] = sliced.map(
    ({ companyId: _cid, observedAt: _at, ...fp }) => fp,
  );
  return {
    schemaVersion: GBRAIN_RECENT_FINGERPRINT_SCHEMA,
    advisory: true,
    companyId: companyId ?? null,
    count: stripped.length,
    bufferSize: configuredSize,
    fingerprints: stripped,
  };
}

/** Test/admin helper: drop all in-memory failure history. */
export function resetGbrainFailureRecorder(): void {
  buffers.clear();
  configuredSize = DEFAULT_GBRAIN_FAILURE_BUFFER_SIZE;
}

/** Test helper: total entries stored across all company partitions. */
export function getRecordedFailureEntryCount(): number {
  let total = 0;
  for (const buf of buffers.values()) total += buf.length;
  return total;
}
