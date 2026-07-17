import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { withCompanyQueuePumpLock } from "./company-queue-pump-lock.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("company queue-pump lock", () => {
  it("never overlaps a slow predecessor for the same company", async () => {
    vi.useFakeTimers();
    const companyId = randomUUID();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = withCompanyQueuePumpLock(companyId, async () => {
      events.push("first:start");
      await releaseFirst.promise;
      events.push("first:end");
    });
    const second = withCompanyQueuePumpLock(companyId, async () => {
      events.push("second:start");
      events.push("second:end");
    });

    try {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(events).toEqual(["first:start"]);

      releaseFirst.resolve();
      await Promise.all([first, second]);

      expect(events).toEqual([
        "first:start",
        "first:end",
        "second:start",
        "second:end",
      ]);
    } finally {
      releaseFirst.resolve();
      await Promise.allSettled([first, second]);
      vi.useRealTimers();
    }
  });

  it("releases serialization after a failed predecessor", async () => {
    const companyId = randomUUID();
    const events: string[] = [];

    await expect(withCompanyQueuePumpLock(companyId, async () => {
      events.push("first");
      throw new Error("expected failure");
    })).rejects.toThrow("expected failure");

    await withCompanyQueuePumpLock(companyId, async () => {
      events.push("second");
    });

    expect(events).toEqual(["first", "second"]);
  });
});
