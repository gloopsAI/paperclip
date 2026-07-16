import { describe, expect, it, vi } from "vitest";
import {
  isDatabaseConnectionUnavailableError,
  startAutonomousAppServices,
} from "../app.js";

describe("feedback export flush error classification", () => {
  it("recognizes wrapped database connection-refused errors", () => {
    const error = new Error("Failed query: select ...: connect ECONNREFUSED 127.0.0.1:54329");
    (error as { cause?: unknown }).cause = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:54329"),
      { code: "ECONNREFUSED" },
    );

    expect(isDatabaseConnectionUnavailableError(error)).toBe(true);
  });

  it("does not classify ordinary feedback upload failures as database outages", () => {
    expect(isDatabaseConnectionUnavailableError(new Error("upstream returned 500"))).toBe(false);
  });

  it("does not trust unrelated error messages that mention ECONNREFUSED", () => {
    expect(isDatabaseConnectionUnavailableError(
      new Error("feedback upload payload mentioned ECONNREFUSED in user content"),
    )).toBe(false);
  });
});

describe("operator-only app startup boundary", () => {
  function createStarts() {
    return {
      startJobCoordinator: vi.fn(),
      startJobScheduler: vi.fn(),
      startFeedbackExport: vi.fn(),
      initializeToolDispatcher: vi.fn(),
      startPluginRuntime: vi.fn(),
    };
  }

  it("suppresses every autonomous coordinator, timer, dispatcher, loader, and worker path", () => {
    const starts = createStarts();

    expect(startAutonomousAppServices({ operatorOnlyMode: true, ...starts })).toBe(false);

    for (const start of Object.values(starts)) {
      expect(start).not.toHaveBeenCalled();
    }
  });

  it("keeps normal startup behavior default-on", () => {
    const starts = createStarts();

    expect(startAutonomousAppServices(starts)).toBe(true);

    for (const start of Object.values(starts)) {
      expect(start).toHaveBeenCalledOnce();
    }
  });
});
