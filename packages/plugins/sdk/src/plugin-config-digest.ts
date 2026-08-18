import { createHash } from "node:crypto";

function canonicalPluginConfigJson(value: unknown): string {
  if (value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalPluginConfigJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalPluginConfigJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Digest the exact JSON-compatible plugin configuration observed through
 * `ctx.config.get()`. The host uses this same function while holding the
 * installation-row lock during a guarded issue create.
 */
export function digestPluginConfig(config: unknown): string {
  return `sha256:${createHash("sha256")
    .update(canonicalPluginConfigJson(config))
    .digest("hex")}`;
}
