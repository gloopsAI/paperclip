import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  heartbeatRuns,
  issues,
  projectWorkspaces,
  repositoryMutationReceipts,
} from "@paperclipai/db";
import type { HeartbeatRunMutationSettlement } from "./heartbeat-run-settlement.js";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const OID_PATTERN = /^[0-9a-f]{40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BRANCH_REF_PATTERN = /^refs\/heads\/paperclip\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/calibration$/;
const TERMINAL_STATES = new Set(["reconciled_success", "bounded_failure", "conflict"]);
const PREPARED_KEYS = new Set([
  "schemaVersion",
  "companyId",
  "agentId",
  "heartbeatRunId",
  "issueId",
  "projectId",
  "projectWorkspaceId",
  "repositoryId",
  "repositoryFullName",
  "defaultBranch",
  "branchRef",
  "mutationClass",
  "rootAuthorizationDigest",
  "leaseDigest",
  "nonce",
  "expectedOldOid",
  "expectedNewOid",
  "state",
  "preparedAt",
]);
const TERMINAL_KEYS = new Set([
  ...PREPARED_KEYS,
  "brokerReceiptDigest",
  "remoteOldOid",
  "remoteNewOid",
  "terminalAt",
]);
// Optional draft-PR evidence for the leased push+draft-PR composite. Absent
// field = push-only receipt; old receipts stay valid.
const TERMINAL_KEYS_WITH_DRAFT_PR = new Set([...TERMINAL_KEYS, "draftPullRequest"]);
const DRAFT_PR_CREATED_KEYS = new Set(["disposition", "prNumber", "prUrl"]);
const DRAFT_PR_NONE_KEYS = new Set(["disposition"]);

type TerminalState = "reconciled_success" | "bounded_failure" | "conflict";

export type RepositoryMutationDraftPullRequest =
  | { disposition: "created"; prNumber: number; prUrl: string }
  | { disposition: "none" };

export type RepositoryMutationPreparedReceipt = {
  schemaVersion: "gloops.repository-mutation-receipt.v1";
  companyId: string;
  agentId: string;
  heartbeatRunId: string;
  issueId: string;
  projectId: string;
  projectWorkspaceId: string;
  repositoryId: string;
  repositoryFullName: string;
  defaultBranch: string;
  branchRef: string;
  mutationClass: "create_one_branch_ref";
  rootAuthorizationDigest: string;
  leaseDigest: string;
  nonce: string;
  expectedOldOid: string;
  expectedNewOid: string;
  state: "prepared";
  preparedAt: string;
};

export type RepositoryMutationTerminalReceipt =
  & Omit<RepositoryMutationPreparedReceipt, "state">
  & {
    state: TerminalState;
    brokerReceiptDigest: string;
    remoteOldOid: string;
    remoteNewOid: string;
    terminalAt: string;
    draftPullRequest?: RepositoryMutationDraftPullRequest;
  };

export type AuthenticatedImplementationReviewBinding = {
  repositoryId: string;
  repositoryFullName: string;
  baseRef: string;
  exactBaseSha: string;
  exactHeadSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  projectWorkspaceId: string;
};

export class RepositoryMutationReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryMutationReceiptConflictError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function externalIssueClaimForMutationContext(value: unknown) {
  const candidate = record(record(value).externalIssueClaim);
  const expectedKeys = new Set([
    "schemaVersion", "claimId", "companyId", "issueId", "agentId", "entryPoint",
    "repositoryFullName", "baseSha", "branchName", "projectWorkspaceId",
    "workspaceIdentity", "claimedAt",
  ]);
  if (
    !hasExactKeys(candidate, expectedKeys)
    || candidate.schemaVersion !== "paperclip.external-issue-claim.v1"
    || !UUID_PATTERN.test(String(candidate.claimId))
    || !UUID_PATTERN.test(String(candidate.companyId))
    || !UUID_PATTERN.test(String(candidate.issueId))
    || !UUID_PATTERN.test(String(candidate.agentId))
    || !["buzz", "paperclip_agent", "interactive_codex"].includes(String(candidate.entryPoint))
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(candidate.repositoryFullName))
    || !OID_PATTERN.test(String(candidate.baseSha))
    || candidate.branchName !== `paperclip/${candidate.claimId}/calibration`
    || !UUID_PATTERN.test(String(candidate.projectWorkspaceId))
    || !nonEmptyString(candidate.workspaceIdentity)
    || !Number.isFinite(Date.parse(String(candidate.claimedAt)))
  ) {
    return null;
  }
  return candidate;
}

function hasExactKeys(value: unknown, expected: Set<string>): boolean {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key)),
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const recordValue = value as Record<string, unknown>;
    return `{${Object.keys(recordValue).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptDigest(domain: string, value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function parseGitHubRepositoryFullName(repoUrl: string): string | null {
  const trimmed = repoUrl.trim();
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed);
  if (ssh) return ssh[1] ?? null;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol !== "https:"
      || url.hostname.toLowerCase() !== "github.com"
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path) ? path : null;
  } catch {
    return null;
  }
}

function validatePrepared(input: RepositoryMutationPreparedReceipt): void {
  if (
    !hasExactKeys(input, PREPARED_KEYS)
    || input.schemaVersion !== "gloops.repository-mutation-receipt.v1"
    || input.mutationClass !== "create_one_branch_ref"
    || input.state !== "prepared"
    || !SHA256_PATTERN.test(input.rootAuthorizationDigest)
    || !SHA256_PATTERN.test(input.leaseDigest)
    || !OID_PATTERN.test(input.expectedOldOid)
    || !OID_PATTERN.test(input.expectedNewOid)
    || !BRANCH_REF_PATTERN.test(input.branchRef)
    || input.branchRef !== `refs/heads/paperclip/${input.heartbeatRunId}/calibration`
    || !UUID_PATTERN.test(input.companyId)
    || !UUID_PATTERN.test(input.agentId)
    || !UUID_PATTERN.test(input.heartbeatRunId)
    || !UUID_PATTERN.test(input.issueId)
    || !UUID_PATTERN.test(input.projectId)
    || !UUID_PATTERN.test(input.projectWorkspaceId)
    || !/^[1-9][0-9]*$/.test(input.repositoryId)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repositoryFullName)
    || !nonEmptyString(input.defaultBranch)
    || !/^[0-9a-f]{64}$/.test(input.nonce)
    || !Number.isFinite(Date.parse(input.preparedAt))
  ) {
    throw new RepositoryMutationReceiptConflictError("Prepared repository mutation receipt is malformed");
  }
}

function validateDraftPullRequest(input: RepositoryMutationTerminalReceipt): void {
  const draftPullRequest = input.draftPullRequest;
  if (draftPullRequest === undefined) return;
  if (draftPullRequest?.disposition === "none") {
    if (hasExactKeys(draftPullRequest, DRAFT_PR_NONE_KEYS)) return;
  } else if (draftPullRequest?.disposition === "created") {
    if (
      hasExactKeys(draftPullRequest, DRAFT_PR_CREATED_KEYS)
      && input.state === "reconciled_success"
      && Number.isInteger(draftPullRequest.prNumber)
      && draftPullRequest.prNumber > 0
      && draftPullRequest.prUrl
        === `https://github.com/${input.repositoryFullName}/pull/${draftPullRequest.prNumber}`
    ) {
      return;
    }
  }
  throw new RepositoryMutationReceiptConflictError(
    "Terminal repository mutation draft pull request evidence is malformed",
  );
}

function validateTerminal(input: RepositoryMutationTerminalReceipt): void {
  const {
    brokerReceiptDigest,
    remoteOldOid,
    remoteNewOid,
    terminalAt,
    draftPullRequest,
    ...preparedFields
  } = input;
  validatePrepared({ ...preparedFields, state: "prepared" });
  validateDraftPullRequest(input);
  const digestProjection = {
    ...preparedProjection(input),
    state: input.state,
    remoteOldOid,
    remoteNewOid,
    terminalAt,
    ...(draftPullRequest === undefined ? {} : { draftPullRequest }),
  };
  if (
    !hasExactKeys(
      input,
      "draftPullRequest" in input ? TERMINAL_KEYS_WITH_DRAFT_PR : TERMINAL_KEYS,
    )
    || !TERMINAL_STATES.has(input.state)
    || !SHA256_PATTERN.test(brokerReceiptDigest)
    || !OID_PATTERN.test(remoteOldOid)
    || !OID_PATTERN.test(remoteNewOid)
    || !Number.isFinite(Date.parse(terminalAt))
    || remoteOldOid !== input.expectedOldOid
    || (input.state === "reconciled_success" && remoteNewOid !== input.expectedNewOid)
    || (input.state === "bounded_failure" && remoteNewOid !== input.expectedOldOid)
    || (
      input.state === "conflict"
      && (remoteNewOid === input.expectedOldOid || remoteNewOid === input.expectedNewOid)
    )
    || brokerReceiptDigest
      !== receiptDigest("gloops.github-push-terminal-receipt.v1", digestProjection)
  ) {
    throw new RepositoryMutationReceiptConflictError("Terminal repository mutation receipt is malformed");
  }
}

function preparedProjection(input: RepositoryMutationPreparedReceipt | RepositoryMutationTerminalReceipt) {
  const {
    schemaVersion,
    companyId,
    agentId,
    heartbeatRunId,
    issueId,
    projectId,
    projectWorkspaceId,
    repositoryId,
    repositoryFullName,
    defaultBranch,
    branchRef,
    mutationClass,
    rootAuthorizationDigest,
    leaseDigest,
    nonce,
    expectedOldOid,
    expectedNewOid,
    preparedAt,
  } = input;
  return {
    schemaVersion,
    companyId,
    agentId,
    heartbeatRunId,
    issueId,
    projectId,
    projectWorkspaceId,
    repositoryId,
    repositoryFullName,
    defaultBranch,
    branchRef,
    mutationClass,
    rootAuthorizationDigest,
    leaseDigest,
    nonce,
    expectedOldOid,
    expectedNewOid,
    preparedAt,
  };
}

export function repositoryMutationReceiptService(db: Db) {
  return {
    getAuthenticatedImplementationReviewBinding: async (input: {
      heartbeatRunId: string;
      companyId: string;
      issueId: string;
      projectWorkspaceId: string;
      exactBaseSha: string;
      exactHeadSha: string;
    }): Promise<AuthenticatedImplementationReviewBinding | null> => {
      if (!OID_PATTERN.test(input.exactBaseSha) || !OID_PATTERN.test(input.exactHeadSha)) {
        return null;
      }
      const row = await db
        .select()
        .from(repositoryMutationReceipts)
        .where(and(
          eq(repositoryMutationReceipts.heartbeatRunId, input.heartbeatRunId),
          eq(repositoryMutationReceipts.companyId, input.companyId),
          eq(repositoryMutationReceipts.issueId, input.issueId),
          eq(repositoryMutationReceipts.projectWorkspaceId, input.projectWorkspaceId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!row || row.state !== "reconciled_success") return null;

      const receipt = row.receipt as RepositoryMutationTerminalReceipt;
      try {
        validateTerminal(receipt);
      } catch {
        return null;
      }
      const draftPullRequest = receipt.draftPullRequest;
      if (
        draftPullRequest?.disposition !== "created"
        || receipt.expectedOldOid !== input.exactBaseSha.toLowerCase()
        || receipt.remoteOldOid !== input.exactBaseSha.toLowerCase()
        || receipt.expectedNewOid !== input.exactHeadSha.toLowerCase()
        || receipt.remoteNewOid !== input.exactHeadSha.toLowerCase()
        || receipt.projectWorkspaceId !== input.projectWorkspaceId
      ) {
        return null;
      }
      return {
        repositoryId: receipt.repositoryId,
        repositoryFullName: receipt.repositoryFullName,
        baseRef: receipt.defaultBranch,
        exactBaseSha: receipt.remoteOldOid,
        exactHeadSha: receipt.remoteNewOid,
        pullRequestNumber: draftPullRequest.prNumber,
        pullRequestUrl: draftPullRequest.prUrl,
        projectWorkspaceId: receipt.projectWorkspaceId,
      };
    },

    getContext: async (heartbeatRunId: string) => {
      const run = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      const issueId = nonEmptyString(record(run?.contextSnapshot).issueId);
      if (!run || !issueId) return null;

      const issue = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (
        !issue
        || !issue.projectId
        || issue.assigneeAgentId !== run.agentId
        || (issue.executionRunId !== run.id && issue.checkoutRunId !== run.id)
      ) {
        return null;
      }

      const workspace = issue.projectWorkspaceId
        ? await db
          .select()
          .from(projectWorkspaces)
          .where(and(
            eq(projectWorkspaces.id, issue.projectWorkspaceId),
            eq(projectWorkspaces.projectId, issue.projectId),
            eq(projectWorkspaces.companyId, run.companyId),
          ))
          .then((rows) => rows[0] ?? null)
        : await db
          .select()
          .from(projectWorkspaces)
          .where(and(
            eq(projectWorkspaces.projectId, issue.projectId),
            eq(projectWorkspaces.companyId, run.companyId),
            eq(projectWorkspaces.isPrimary, true),
          ))
          .then((rows) => rows[0] ?? null);
      const repositoryFullName = workspace?.repoUrl
        ? parseGitHubRepositoryFullName(workspace.repoUrl)
        : null;
      if (!workspace || !repositoryFullName) return null;

      const externalIssueClaim = externalIssueClaimForMutationContext(run.contextSnapshot);
      if (run.invocationSource === "external_claim" && !externalIssueClaim) return null;
      if (run.invocationSource !== "external_claim" && externalIssueClaim) return null;
      // The external claim is deliberately the issue's single atomic writer:
      // both ownership columns must still point at the same real run. Managed
      // heartbeat runs retain their existing either-column compatibility.
      if (externalIssueClaim && (
        issue.executionRunId !== run.id
        || issue.checkoutRunId !== run.id
      )) return null;
      if (externalIssueClaim && (
        externalIssueClaim.claimId !== run.id
        || externalIssueClaim.companyId !== run.companyId
        || externalIssueClaim.issueId !== issue.id
        || externalIssueClaim.agentId !== run.agentId
        || externalIssueClaim.projectWorkspaceId !== workspace.id
        || externalIssueClaim.repositoryFullName !== repositoryFullName
        || externalIssueClaim.baseSha !== workspace.repoRef
      )) return null;

      return {
        schemaVersion: "gloops.repository-mutation-context.v1",
        heartbeatRunId: run.id,
        runInvocationSource: run.invocationSource,
        runStatus: run.status,
        companyId: run.companyId,
        agentId: run.agentId,
        issueId: issue.id,
        issueStatus: issue.status,
        projectId: issue.projectId,
        projectWorkspaceId: workspace.id,
        repositoryFullName,
        configuredDefaultBranch: workspace.defaultRef,
        configuredRepositoryRef: workspace.repoRef,
        externalIssueClaim,
      };
    },

    recordPrepared: async (input: RepositoryMutationPreparedReceipt) => {
      validatePrepared(input);
      return db.transaction(async (tx) => {
        // This is the same row lock used by atomic terminal settlement. It
        // makes "no repository authority" and "prepared authority" mutually
        // exclusive decisions for a run.
        await tx.execute(
          sql`select id from heartbeat_runs where id = ${input.heartbeatRunId} for update`,
        );
        const service = repositoryMutationReceiptService(tx as unknown as Db);
        const context = await service.getContext(input.heartbeatRunId);
        if (
          !context
          || context.companyId !== input.companyId
          || context.agentId !== input.agentId
          || context.issueId !== input.issueId
          || context.projectId !== input.projectId
          || context.projectWorkspaceId !== input.projectWorkspaceId
          || context.repositoryFullName !== input.repositoryFullName
          || context.configuredDefaultBranch !== input.defaultBranch
          || context.issueStatus !== "in_progress"
          || !["queued", "running"].includes(context.runStatus)
        ) {
          throw new RepositoryMutationReceiptConflictError(
            "Prepared repository mutation receipt conflicts with current Paperclip work facts",
          );
        }
        const existing = await tx
          .select()
          .from(repositoryMutationReceipts)
          .where(eq(repositoryMutationReceipts.heartbeatRunId, input.heartbeatRunId))
          .then((rows) => rows[0] ?? null);
        if (existing) {
          if (
            existing.state === "prepared"
            && isDeepStrictEqual(preparedProjection(existing.receipt as RepositoryMutationPreparedReceipt), preparedProjection(input))
          ) {
            return existing;
          }
          throw new RepositoryMutationReceiptConflictError(
            "Repository mutation allocation already exists with conflicting facts",
          );
        }
        return tx
          .insert(repositoryMutationReceipts)
          .values({
            ...preparedProjection(input),
            state: "prepared",
            receipt: input,
            preparedAt: new Date(input.preparedAt),
          })
          .returning()
          .then((rows) => rows[0]!);
      });
    },

    recordTerminal: async (input: RepositoryMutationTerminalReceipt) => {
      validateTerminal(input);
      return db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(repositoryMutationReceipts)
          .where(eq(repositoryMutationReceipts.heartbeatRunId, input.heartbeatRunId))
          .then((rows) => rows[0] ?? null);
        if (!existing || !isDeepStrictEqual(
          preparedProjection(existing.receipt as RepositoryMutationPreparedReceipt),
          preparedProjection(input),
        )) {
          throw new RepositoryMutationReceiptConflictError(
            "Terminal repository mutation receipt does not match its prepared allocation",
          );
        }
        if (existing.state !== "prepared") {
          if (
            existing.state === input.state
            && isDeepStrictEqual(existing.receipt, input)
          ) {
            return existing;
          }
          throw new RepositoryMutationReceiptConflictError(
            "Repository mutation receipt terminal replay conflicts with committed evidence",
          );
        }
        return tx
          .update(repositoryMutationReceipts)
          .set({
            state: input.state,
            brokerReceiptDigest: input.brokerReceiptDigest,
            remoteOldOid: input.remoteOldOid,
            remoteNewOid: input.remoteNewOid,
            receipt: input,
            terminalAt: new Date(input.terminalAt),
            updatedAt: new Date(),
          })
          .where(and(
            eq(repositoryMutationReceipts.id, existing.id),
            eq(repositoryMutationReceipts.state, "prepared"),
          ))
          .returning()
          .then((rows) => {
            if (rows.length !== 1) {
              throw new RepositoryMutationReceiptConflictError(
                "Repository mutation receipt changed during terminal reconciliation",
              );
            }
            return rows[0]!;
          });
      });
    },

    getForSettlement: async (heartbeatRunId: string): Promise<HeartbeatRunMutationSettlement> => {
      const receipt = await db
        .select()
        .from(repositoryMutationReceipts)
        .where(eq(repositoryMutationReceipts.heartbeatRunId, heartbeatRunId))
        .then((rows) => rows[0] ?? null);
      if (!receipt) return { disposition: "not_authorized" };
      if (
        receipt.state === "prepared"
        || !receipt.brokerReceiptDigest
        || !receipt.remoteOldOid
        || !receipt.remoteNewOid
      ) {
        throw new RepositoryMutationReceiptConflictError(
          "Repository mutation was authorized but has not reached terminal broker reconciliation",
        );
      }
      if (!TERMINAL_STATES.has(receipt.state)) {
        throw new RepositoryMutationReceiptConflictError("Repository mutation receipt state is invalid");
      }
      return {
        disposition: receipt.state as TerminalState,
        brokerReceiptDigest: receipt.brokerReceiptDigest,
        remoteOldOid: receipt.remoteOldOid,
        remoteNewOid: receipt.remoteNewOid,
      };
    },
  };
}
