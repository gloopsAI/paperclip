import { describe, expect, it } from "vitest";
import { digestPluginConfig } from "../src/plugin-config-digest.js";

describe("digestPluginConfig", () => {
  it("is deterministic across object key order and represents absent config as an empty object", () => {
    expect(digestPluginConfig({ enabled: true, nested: { b: 2, a: 1 } }))
      .toBe(digestPluginConfig({ nested: { a: 1, b: 2 }, enabled: true }));
    expect(digestPluginConfig({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
