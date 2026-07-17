import { logger } from "../middleware/logger.js";

const COMPANY_QUEUE_PUMP_LOCK_STALE_MS = 30_000;
const queuePumpLocksByCompany = new Map<string, { promise: Promise<void>; startedAtMs: number }>();

async function waitForCompanyQueuePumpLock(
  companyId: string,
  lock: { promise: Promise<void>; startedAtMs: number },
) {
  const elapsedMs = Date.now() - lock.startedAtMs;
  const remainingMs = COMPANY_QUEUE_PUMP_LOCK_STALE_MS - elapsedMs;
  if (remainingMs <= 0) {
    logger.warn(
      { companyId, staleMs: elapsedMs },
      "company queue-pump lock stale; continuing queued-run drain",
    );
    return;
  }

  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    lock.promise,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, remainingMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (timedOut) {
    logger.warn(
      { companyId, staleMs: COMPANY_QUEUE_PUMP_LOCK_STALE_MS },
      "company queue-pump lock timed out; continuing queued-run drain",
    );
  }
}

export async function withCompanyQueuePumpLock<T>(companyId: string, fn: () => Promise<T>) {
  const previous = queuePumpLocksByCompany.get(companyId);
  const waitForPrevious = previous
    ? waitForCompanyQueuePumpLock(companyId, previous)
    : Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  queuePumpLocksByCompany.set(companyId, { promise: marker, startedAtMs: Date.now() });
  try {
    return await run;
  } finally {
    if (queuePumpLocksByCompany.get(companyId)?.promise === marker) {
      queuePumpLocksByCompany.delete(companyId);
    }
  }
}
