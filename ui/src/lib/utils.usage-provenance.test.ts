import { describe, expect, it } from "vitest";
import {
  formatTokensWithProvenance,
  readUsageTokenProvenance,
} from "./utils";

describe("usage token provenance display", () => {
  it("reads usageProvenance from run usageJson", () => {
    expect(readUsageTokenProvenance({ usageProvenance: "estimated" })).toBe("estimated");
    expect(readUsageTokenProvenance({ provenance: "measured" })).toBe("measured");
    expect(readUsageTokenProvenance({ usageProvenance: "nope" })).toBeNull();
  });

  it("does not present unknown zero usage as an exact measured zero", () => {
    expect(formatTokensWithProvenance(0, "unknown")).toBe("unavailable");
  });

  it("marks estimated token-equivalents without claiming measured truth", () => {
    expect(formatTokensWithProvenance(1200, "estimated")).toBe("~1.2k");
    expect(formatTokensWithProvenance(42, "measured")).toBe("42");
  });
});
