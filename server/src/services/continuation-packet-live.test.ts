import { describe, expect, it } from "vitest";
import {
  agentUsesContinuationPacketLive,
  continuationPacketLiveAgents,
  isContinuationPacketLiveEnabled,
} from "./continuation-packet-live.js";

describe("continuation-packet-live (C4)", () => {
  it("defaults to enabled for Dispatch and Wren", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isContinuationPacketLiveEnabled(env)).toBe(true);
    expect(continuationPacketLiveAgents(env)).toEqual(["Dispatch", "Wren"]);
    expect(agentUsesContinuationPacketLive("Dispatch", env)).toBe(true);
    expect(agentUsesContinuationPacketLive("Wren", env)).toBe(true);
    expect(agentUsesContinuationPacketLive("Argus", env)).toBe(false);
    expect(agentUsesContinuationPacketLive("Northstar", env)).toBe(false);
  });

  it("can disable via env flag", () => {
    const env = { PAPERCLIP_CONTINUATION_PACKET_LIVE: "false" } as NodeJS.ProcessEnv;
    expect(isContinuationPacketLiveEnabled(env)).toBe(false);
    expect(agentUsesContinuationPacketLive("Wren", env)).toBe(false);
  });

  it("respects custom agent allowlist", () => {
    const env = {
      PAPERCLIP_CONTINUATION_PACKET_LIVE: "true",
      PAPERCLIP_CONTINUATION_PACKET_LIVE_AGENTS: "Wren,Argus",
    } as NodeJS.ProcessEnv;
    expect(agentUsesContinuationPacketLive("Wren", env)).toBe(true);
    expect(agentUsesContinuationPacketLive("Argus", env)).toBe(true);
    expect(agentUsesContinuationPacketLive("Dispatch", env)).toBe(false);
  });
});
