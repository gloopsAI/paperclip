const queuePumpLocksByCompany = new Map<string, Promise<void>>();

export async function withCompanyQueuePumpLock<T>(companyId: string, fn: () => Promise<T>) {
  const previous = queuePumpLocksByCompany.get(companyId);
  const waitForPrevious = previous ?? Promise.resolve();
  const run = waitForPrevious.then(fn);
  const marker = run.then(
    () => undefined,
    () => undefined,
  );
  queuePumpLocksByCompany.set(companyId, marker);
  try {
    return await run;
  } finally {
    if (queuePumpLocksByCompany.get(companyId) === marker) {
      queuePumpLocksByCompany.delete(companyId);
    }
  }
}
