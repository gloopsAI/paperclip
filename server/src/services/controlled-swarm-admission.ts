const COMPANY_ACTIVE_RUNS_MAX = 50;

export interface ControlledSwarmAdmissionPolicy {
  companyMaxActiveRuns: number | null;
  issueCreatedAtGte: Date | null;
}

function parseOptionalPositiveInteger(
  name: string,
  raw: string | undefined,
  maximum: number,
) {
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function parseOptionalTimestamp(name: string, raw: string | undefined) {
  if (raw === undefined || raw.trim() === "") return null;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime()) || value.toISOString() !== raw.trim()) {
    throw new Error(`${name} must be an exact ISO-8601 UTC timestamp`);
  }
  return value;
}

export function parseControlledSwarmAdmissionPolicy(
  env: Record<string, string | undefined> = process.env,
): ControlledSwarmAdmissionPolicy {
  return {
    companyMaxActiveRuns: parseOptionalPositiveInteger(
      "PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS",
      env.PAPERCLIP_COMPANY_MAX_ACTIVE_RUNS,
      COMPANY_ACTIVE_RUNS_MAX,
    ),
    issueCreatedAtGte: parseOptionalTimestamp(
      "PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE",
      env.PAPERCLIP_EXECUTION_ISSUE_CREATED_AT_GTE,
    ),
  };
}

