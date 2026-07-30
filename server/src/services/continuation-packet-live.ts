/**
 * C4 — Compact continuation packets on the live resume path.
 *
 * Full MTE control plane remains offline (ADR 0027 / mteEnabled=false).
 * This module enables a *minimal* live path: for allowlisted agent classes
 * (default: Dispatch, Wren), every issue-bound wake rebuilds the bound
 * execution context from the issue continuation summary so resumes do not
 * replay full transcript context.
 *
 * Feature flag (default ON):
 *   PAPERCLIP_CONTINUATION_PACKET_LIVE=true|false
 * Agent allowlist:
 *   PAPERCLIP_CONTINUATION_PACKET_LIVE_AGENTS=Dispatch,Wren
 */

export const CONTINUATION_PACKET_LIVE_DEFAULT = true;
export const CONTINUATION_PACKET_LIVE_DEFAULT_AGENTS = ["Dispatch", "Wren"] as const;

function readEnvFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "default") return defaultValue;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return defaultValue;
}

export function isContinuationPacketLiveEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return readEnvFlag(env.PAPERCLIP_CONTINUATION_PACKET_LIVE, CONTINUATION_PACKET_LIVE_DEFAULT);
}

export function continuationPacketLiveAgents(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.PAPERCLIP_CONTINUATION_PACKET_LIVE_AGENTS?.trim();
  if (!raw) return [...CONTINUATION_PACKET_LIVE_DEFAULT_AGENTS];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when this agent should use compact continuation packets on resume
 * (rebuild bound packet + force fresh session; no full transcript replay).
 */
export function agentUsesContinuationPacketLive(
  agentName: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isContinuationPacketLiveEnabled(env)) return false;
  const name = typeof agentName === "string" ? agentName.trim() : "";
  if (!name) return false;
  const allow = continuationPacketLiveAgents(env);
  return allow.some((a) => a.toLowerCase() === name.toLowerCase());
}
