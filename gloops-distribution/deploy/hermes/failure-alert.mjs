#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SLACK_CHANNEL_ID = "C0BGVS837EG";
const RECIPIENT_EMAIL = "zach.lendon@gmail.com";

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

async function requestJson(url, { token, body, method = "GET" } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok || parsed.ok === false) {
      throw new Error(`notification request failed: ${response.status} ${parsed.error || "unknown"}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const unit = String(process.argv[2] || "paperclip-gloops.service").slice(0, 160);
  const credentialsDir = process.env.CREDENTIALS_DIRECTORY;
  if (!credentialsDir) throw new Error("systemd credential directory is required");

  const communications = parseEnv(await readFile(join(credentialsDir, "communications.env"), "utf8"));
  const agentMail = parseEnv(await readFile(join(credentialsDir, "agentmail.env"), "utf8"));
  const slackToken = communications.SLACK_BOT_TOKEN;
  const agentMailApiKey = agentMail.AGENTMAIL_API_KEY;
  const inboxId = agentMail.AGENTMAIL_INBOX_ID;
  if (!slackToken || !agentMailApiKey || !inboxId) throw new Error("notification credentials are incomplete");

  const hour = new Date().toISOString().slice(0, 13);
  const eventId = createHash("sha256").update(`${unit}:${hour}`).digest("hex").slice(0, 20);
  const stateDir = process.env.PAPERCLIP_GLOOPS_ALERT_STATE_DIR || "/var/lib/gloops-exec-updates/paperclip-gloops-alerts";
  const slackStateFile = join(stateDir, `${eventId}.slack`);
  const agentMailStateFile = join(stateDir, `${eventId}.agentmail`);
  await mkdir(stateDir, { recursive: true });

  async function isDelivered(path) {
    try {
      await readFile(path, "utf8");
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async function markDelivered(path) {
    try {
      await writeFile(path, `${new Date().toISOString()}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }

  const subject = `[GLoops alert] ${unit} failed`;
  const body = [
    `${unit} entered a failed state on ubuntu-hermes-nyc1.`,
    "Paperclip is not authorized to self-reactivate; the service remains bounded by its operator activation marker and systemd state.",
    `Event: ${eventId}`,
    "Inspect: sudo systemctl status paperclip-gloops.service && sudo journalctl -u paperclip-gloops.service -n 200",
  ].join("\n");

  if (!(await isDelivered(slackStateFile))) {
    await requestJson("https://slack.com/api/chat.postMessage", {
      token: slackToken,
      method: "POST",
      body: { channel: SLACK_CHANNEL_ID, text: `*${subject}*\n${body}` },
    });
    await markDelivered(slackStateFile);
  }
  if (!(await isDelivered(agentMailStateFile))) {
    await requestJson(`https://api.agentmail.to/v0/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
      token: agentMailApiKey,
      method: "POST",
      body: { to: [RECIPIENT_EMAIL], subject, text: body },
    });
    await markDelivered(agentMailStateFile);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
