import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { readExecutionWorkspaceConfig } from "../services/execution-workspaces.js";

const execFileAsync = promisify(execFile);
const tempRepos: string[] = [];

const mockExecutionWorkspaceService = vi.hoisted(() => ({
  list: vi.fn(),
  listOverview: vi.fn(),
  listSummaries: vi.fn(),
  getById: vi.fn(),
  getCloseReadiness: vi.fn(),
  reconcileExecutionWorkspaceBranch: vi.fn(),
  update: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({
  listForExecutionWorkspace: vi.fn(),
  createRecorder: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  decide: vi.fn(),
}));
const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  executionWorkspaceService: () => mockExecutionWorkspaceService,
  heartbeatService: () => mockHeartbeatService,
  logActivity: mockLogActivity,
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  userId: "local-board",
  companyIds: ["company-1"],
  source: "session",
  isInstanceAdmin: false,
}, db: any = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", executionWorkspaceRoutes(db));
  app.use(errorHandler);
  return app;
}

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", ["-C", cwd, ...args], { cwd });
}

async function readGit(cwd: string, args: string[]) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return result.stdout.trim();
}

async function createTempRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-workspace-route-local-only-"));
  tempRepos.push(repoRoot);
  await execFileAsync("git", ["init", "-b", "main", repoRoot]);
  await runGit(repoRoot, ["config", "user.email", "test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "route test\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "Initial commit"]);
  return repoRoot;
}

function localOnlyRuntimeConfig() {
  const metadata = {
    config: {
      remoteRefreshPolicy: "local_only",
      workspaceRuntime: {
        services: [{ name: "web", command: "node -e \"process.exit(0)\"" }],
      },
    },
  };
  return { metadata, config: readExecutionWorkspaceConfig(metadata) };
}

function createProjectWorkspaceDb(repoRoot: string) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{
          id: "project-workspace-1",
          cwd: repoRoot,
          repoUrl: null,
          repoRef: "main",
          defaultRef: "main",
          metadata: null,
        }]),
      }),
    }),
  };
}

describe.sequential("execution workspace routes", () => {
  afterEach(async () => {
    await Promise.all(tempRepos.splice(0).map((repoRoot) => fs.rm(repoRoot, { recursive: true, force: true })));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "company_scope:read",
      reason: "allow_test",
      explanation: "Allowed by test mock.",
    });
    mockExecutionWorkspaceService.list.mockResolvedValue([]);
    mockExecutionWorkspaceService.listOverview.mockResolvedValue({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    mockExecutionWorkspaceService.listSummaries.mockResolvedValue([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    mockExecutionWorkspaceService.getById.mockResolvedValue(null);
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue(null);
    mockHeartbeatService.wakeup.mockResolvedValue(null);
    mockWorkspaceOperationService.createRecorder.mockReturnValue({
      recordOperation: vi.fn(async (input: { run: () => Promise<unknown> }) => await input.run()),
    });
  });

  it("keeps an existing persisted worktree unchanged when route start cannot resolve its local-only object", async () => {
    const repoRoot = await createTempRepo();
    const expectedBranch = "review-route-expected";
    const actualBranch = "review-route-actual";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", expectedBranch);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", expectedBranch]);
    await runGit(repoRoot, ["worktree", "add", "-b", actualBranch, worktreePath, "HEAD"]);
    const missingHead = "d".repeat(40);
    const persisted = localOnlyRuntimeConfig();
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-route-existing",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: null,
      sourceIssueId: "issue-review-route-existing",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Existing exact-head review",
      cwd: worktreePath,
      providerRef: worktreePath,
      repoUrl: null,
      baseRef: missingHead,
      branchName: expectedBranch,
      metadata: persisted.metadata,
      config: persisted.config,
      runtimeServices: [],
    });
    const worktreeStateBefore = await readGit(repoRoot, ["worktree", "list", "--porcelain"]);
    const branchRefsBefore = await readGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ]);
    const branchBefore = await readGit(worktreePath, ["symbolic-ref", "--short", "HEAD"]);
    const headBefore = await readGit(worktreePath, ["rev-parse", "HEAD"]);

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-route-existing/runtime-services/start")
      .send({});

    expect(res.status).toBe(500);
    expect(await readGit(repoRoot, ["worktree", "list", "--porcelain"]))
      .toBe(worktreeStateBefore);
    expect(await readGit(repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/heads",
    ])).toBe(branchRefsBefore);
    expect(await readGit(worktreePath, ["symbolic-ref", "--short", "HEAD"]))
      .toBe(branchBefore);
    expect(await readGit(worktreePath, ["rev-parse", "HEAD"])).toBe(headBefore);
  });

  it("keeps missing persisted worktree state unchanged when route restart cannot resolve its local-only object", async () => {
    const repoRoot = await createTempRepo();
    const branchName = "review-route-missing";
    const worktreePath = path.join(repoRoot, ".paperclip", "worktrees", branchName);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await runGit(repoRoot, ["branch", branchName]);
    await runGit(repoRoot, ["worktree", "add", worktreePath, branchName]);
    await fs.rm(worktreePath, { recursive: true, force: true });
    const missingHead = "c".repeat(40);
    const persisted = localOnlyRuntimeConfig();
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-route-missing",
      companyId: "company-1",
      projectId: null,
      projectWorkspaceId: "project-workspace-1",
      sourceIssueId: "issue-review-route-missing",
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Missing exact-head review",
      cwd: worktreePath,
      providerRef: worktreePath,
      repoUrl: null,
      baseRef: missingHead,
      branchName,
      metadata: persisted.metadata,
      config: persisted.config,
      runtimeServices: [],
    });
    const worktreeStateBefore = await readGit(repoRoot, ["worktree", "list", "--porcelain"]);
    const branchHeadBefore = await readGit(repoRoot, ["rev-parse", branchName]);

    const res = await request(createApp(undefined, createProjectWorkspaceDb(repoRoot)))
      .post("/api/execution-workspaces/workspace-route-missing/runtime-services/restart")
      .send({});

    expect(res.status).toBe(500);
    expect(await readGit(repoRoot, ["worktree", "list", "--porcelain"]))
      .toBe(worktreeStateBefore);
    expect(await readGit(repoRoot, ["rev-parse", branchName])).toBe(branchHeadBefore);
    await expect(fs.access(worktreePath)).rejects.toThrow();
  });

  it("uses summary mode for lightweight workspace lookups", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/execution-workspaces?summary=true&reuseEligible=true");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "workspace-1",
        name: "Alpha",
        mode: "isolated_workspace",
        projectWorkspaceId: null,
      },
    ]);
    expect(mockExecutionWorkspaceService.listSummaries).toHaveBeenCalledWith("company-1", {
      projectId: undefined,
      projectWorkspaceId: undefined,
      issueId: undefined,
      status: undefined,
      reuseEligible: true,
    });
    expect(mockExecutionWorkspaceService.list).not.toHaveBeenCalled();
  });

  it("delegates bounded workspace overview queries", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?status=active,idle&limit=25&offset=10");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [],
      total: 0,
      limit: 50,
      offset: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(mockExecutionWorkspaceService.listOverview).toHaveBeenCalledWith("company-1", {
      status: ["active", "idle"],
      limit: 25,
      offset: 10,
    });
  });

  it("rejects invalid workspace overview pagination", async () => {
    const res = await request(createApp())
      .get("/api/companies/company-1/workspace-overview?limit=1000");

    expect(res.status).toBe(422);
    expect(mockExecutionWorkspaceService.listOverview).not.toHaveBeenCalled();
  });

  it.each([
    ["forward", { mode: "forward" }],
    ["override", { mode: "override", reason: "operator break-glass" }],
    ["quarantine_restore", { mode: "quarantine_restore", reason: "rescue dirty branch" }],
  ])("rejects agent actors for %s branch reconciliation", async (_mode, body) => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_jwt",
      runId: "run-1",
    }))
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send(body);

    expect(res.status).toBe(403);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("logs branch reconciliation activity after the service operation succeeds", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/current",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:test",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        cleanliness: "clean",
        statusEntryCount: 0,
        plainLanguageReason: "forward",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "forward" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "forward",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "forward",
        fromBranch: "feature/recorded",
        toBranch: "feature/current",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "ancestor",
        fingerprint: "workspace_incoherence:v1:sha256:test",
        sourceIssueId: "issue-1",
        auditCommentId: "comment-1",
        recoveryActionId: "recovery-1",
      }),
    }));
  });

  it("accepts quarantine_restore, logs the rescue ref, and wakes the restored source issue", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: {
        branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
        commitSha: "3333333",
        fileCount: 2,
        sourceAuditCommentId: "comment-0",
        claimantAuditCommentId: null,
      },
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "todo",
        assigneeAgentId: "agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch).toHaveBeenCalledWith("workspace-1", {
      mode: "quarantine_restore",
      reason: null,
      actor: {
        actorType: "user",
        actorId: "local-board",
        agentId: null,
        runId: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "execution_workspace.branch_reconciled",
      entityType: "execution_workspace",
      entityId: "workspace-1",
      details: expect.objectContaining({
        mode: "quarantine_restore",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        recoveryActionId: "recovery-1",
        rescueRef: expect.objectContaining({
          branchName: "paperclip/rescue/PAP-123/20260709T120000Z",
          commitSha: "3333333",
        }),
        sourceIssueStatus: "todo",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      source: "automation",
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        taskId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
        recoveryActionId: "recovery-1",
        executionWorkspaceId: "workspace-1",
        rescueRef: "paperclip/rescue/PAP-123/20260709T120000Z",
      }),
    }));
  });

  it("wakes a restored in_review agent participant after quarantine_restore", async () => {
    mockExecutionWorkspaceService.getById.mockResolvedValue({
      id: "workspace-1",
      companyId: "company-1",
      sourceIssueId: "issue-1",
    });
    mockExecutionWorkspaceService.reconcileExecutionWorkspaceBranch.mockResolvedValue({
      workspace: {
        id: "workspace-1",
        companyId: "company-1",
        sourceIssueId: "issue-1",
        branchName: "feature/recorded",
      },
      inspection: {
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        worktreePath: "/tmp/worktree",
        repoRoot: "/tmp/repo",
        fromBranch: "feature/recorded",
        toBranch: "feature/live",
        fromSha: "1111111",
        toSha: "2222222",
        ancestryVerdict: "diverged",
        cleanliness: "dirty",
        statusEntryCount: 2,
        plainLanguageReason: "dirty live branch",
      },
      recoveryAction: {
        id: "recovery-1",
      },
      auditCommentId: "comment-1",
      rescueRef: null,
      restoredSourceIssue: {
        id: "issue-1",
        companyId: "company-1",
        status: "in_review",
        assigneeAgentId: "reviewer-agent-1",
      },
      sourceIssueStatusChanged: true,
    });

    const res = await request(createApp())
      .post("/api/execution-workspaces/workspace-1/reconcile-branch")
      .send({ mode: "quarantine_restore" });

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({
        sourceIssueStatus: "in_review",
      }),
    }));
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith("reviewer-agent-1", expect.objectContaining({
      reason: "issue_recovery_action_restored",
      payload: expect.objectContaining({
        issueId: "issue-1",
        mutation: "execution_workspace_quarantine_restore",
      }),
      contextSnapshot: expect.objectContaining({
        issueId: "issue-1",
        wakeReason: "issue_recovery_action_restored",
        source: "execution_workspace.quarantine_restore",
      }),
    }));
  });
});
