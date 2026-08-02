import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issuePlanDecompositions,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.ts";
import { WORKSPACE_PREPARATION_FAILURE_CODE } from "../services/workspace-runtime.ts";

const execFileAsync = promisify(execFile);

// heartbeat.ts's ConfigurationIncompleteFailure.code is a private module
// constant (not exported), so mirror its value here. Other heartbeat tests
// (e.g. heartbeat-process-recovery.test.ts, heartbeat-project-env.test.ts)
// follow the same convention of asserting against the literal error code.
const CONFIGURATION_INCOMPLETE_FAILURE_CODE = "configuration_incomplete";

// WG-PLAT-015: an issue's configured/preferred project workspace can have its
// cwd cleared (e.g. the checkout disappeared), which routes the next run
// through managed-clone recovery. If that recovery clone fails (for example,
// no credential path for a private repo), workspace selection must fail
// typed against the intended repo -- it must never silently continue to a
// sibling project workspace or the agent's shared fallback cwd, which could
// hold a completely unrelated repository.
const adapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    summary: "should not run",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({
    type: "process",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  findActiveServerAdapter: () => ({
    type: "process",
    execute: adapterExecute,
    supportsLocalAgentJwt: false,
  }),
  listAdapterModelProfiles: async () => [],
  runningProcesses: new Map(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres preferred-workspace-clone-failure tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

type Db = ReturnType<typeof createDb>;
type Heartbeat = ReturnType<typeof heartbeatService>;

async function runGit(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createGitRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await runGit(repoRoot, ["init"]);
  await runGit(repoRoot, ["config", "user.email", "paperclip-test@example.com"]);
  await runGit(repoRoot, ["config", "user.name", "Paperclip Test"]);
  await fs.writeFile(path.join(repoRoot, "README.md"), "unrelated sibling repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

async function withPaperclipHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = home;
  try {
    return await run();
  } finally {
    if (previousHome === undefined) {
      delete process.env.PAPERCLIP_HOME;
    } else {
      process.env.PAPERCLIP_HOME = previousHome;
    }
  }
}

async function waitForRunToFinish(heartbeat: Heartbeat, runId: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && run.status !== "queued" && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

async function waitForHeartbeatIdle(db: Db, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    if (!runs.some((run) => run.status === "queued" || run.status === "running")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function deleteHeartbeatRowsAfterActivityLogDrains(db: Db) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    try {
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function seedRunTarget(
  db: Db,
  input: {
    siblingRepoRoot: string;
    // The preferred workspace's repoUrl (managed-clone source). Optional so
    // the missing-cwd variant can rely on an explicit cwd instead.
    preferredRepoUrl?: string | null;
    // An explicit checkout path for the preferred workspace. When set, managed
    // clone is skipped and selection depends on this path existing on disk.
    preferredWorkspaceCwd?: string | null;
    // When true, the preferred workspace row is inserted under a SEPARATE
    // project in the same company (the issues.project_workspace_id FK still
    // resolves), so when selection queries the issue's project it finds no
    // matching row -- only the unrelated sibling. This is the realistic
    // "missing row for this project" case the FK otherwise makes unreachable.
    preferredWorkspaceInSeparateProject?: boolean;
    // When false, no sibling workspace row is created, so the issue's project
    // has ZERO candidate workspace rows (exercises the zero-row guard path
    // that would otherwise fall through to a generic managed workspace).
    createSiblingWorkspace?: boolean;
  },
) {
  const preferredWorkspaceInSeparateProject = input.preferredWorkspaceInSeparateProject === true;
  const createSiblingWorkspace = input.createSiblingWorkspace !== false;
  const companyId = randomUUID();
  const projectId = randomUUID();
  const preferredWorkspaceId = randomUUID();
  const siblingWorkspaceId = randomUUID();
  const issueId = randomUUID();
  const agentId = randomUUID();

  await db.insert(companies).values({
    id: companyId,
    name: "Acme",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    status: "active",
    defaultResponsibleUserId: "responsible-user",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Preferred Workspace Clone Failure Guard",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  // Sibling project workspace: an unrelated, already-checked-out repo on the
  // same project. Before the fix this is exactly what selection could fall
  // through to once the preferred workspace's managed clone failed. Omitted for
  // the zero-candidate-rows variant.
  if (createSiblingWorkspace) {
    await db.insert(projectWorkspaces).values({
      id: siblingWorkspaceId,
      companyId,
      projectId,
      name: "Unrelated sibling",
      cwd: input.siblingRepoRoot,
      isPrimary: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  // Preferred project workspace: by default cwd is cleared (simulating a
  // disappeared checkout) and repoUrl points at a private/unreachable repo so
  // managed-clone recovery fails deterministically. The missing-cwd variant
  // instead supplies an explicit cwd that does not exist on disk. The
  // missing-row variant parks this row under a DIFFERENT project so it is
  // absent from the issue-project's candidate set.
  let preferredWorkspaceProjectId = projectId;
  if (preferredWorkspaceInSeparateProject) {
    const otherProjectId = randomUUID();
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Unrelated other project (preferred workspace lives here)",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    preferredWorkspaceProjectId = otherProjectId;
  }
  await db.insert(projectWorkspaces).values({
    id: preferredWorkspaceId,
    companyId,
    projectId: preferredWorkspaceProjectId,
    name: "Preferred gloops-ui",
    cwd: input.preferredWorkspaceCwd ?? null,
    repoUrl: input.preferredRepoUrl ?? null,
    isPrimary: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "CodexCoder",
    role: "engineer",
    status: "idle",
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {
      heartbeat: {
        wakeOnDemand: true,
        maxConcurrentRuns: 1,
      },
    },
    permissions: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(issues).values({
    id: issueId,
    companyId,
    projectId,
    projectWorkspaceId: preferredWorkspaceId,
    title: "Work against the preferred repo only",
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: agentId,
    // A non-null assigneeUserId keeps issueNeedsImmediateRecovery false, so the
    // dispatcher never auto-creates a recovery run for this (permanently
    // failing) repo -- WorkspacePreparationFailure runs are intentionally
    // retryable/not blocked by shouldBlockImmediately, and an unbounded retry
    // loop here would race the afterEach cleanup below.
    assigneeUserId: "wg-plat-015-test-recovery-suppressed",
    identifier: `PAP-${issueId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { companyId, projectId, preferredWorkspaceId, siblingWorkspaceId, issueId, agentId };
}

async function wakeIssue(heartbeat: Heartbeat, agentId: string, issueId: string) {
  return heartbeat.wakeup(agentId, {
    source: "automation",
    triggerDetail: "system",
    reason: "issue_commented",
    payload: { issueId },
    contextSnapshot: {
      issueId,
      taskId: issueId,
      wakeReason: "issue_commented",
      skipIssueComment: true,
    },
  });
}

describeEmbeddedPostgres("preferred project workspace clone failure (WG-PLAT-015)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-preferred-clone-failure-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await waitForHeartbeatIdle(db);
    adapterExecute.mockClear();
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await db.delete(issuePlanDecompositions);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    await db.delete(environmentLeases);
    await db.delete(workspaceOperations);
    await deleteHeartbeatRowsAfterActivityLogDrains(db);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(environments);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  it("fails typed against the preferred repo and never selects the sibling workspace", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preferred-clone-home-"));
    tempRoots.push(home);
    const siblingRepoRoot = await createGitRepo("paperclip-preferred-clone-sibling-");
    tempRoots.push(siblingRepoRoot);
    // Deterministic, network-free clone failure: a local path that does not exist.
    const preferredRepoUrl = path.join(home, "does-not-exist", "gloops-ui.git");

    const { agentId, issueId, preferredWorkspaceId } = await seedRunTarget(db, {
      preferredRepoUrl,
      siblingRepoRoot,
    });

    const heartbeat = heartbeatService(db);
    const { finishedRun, fallbackCwd } = await withPaperclipHome(home, async () => {
      const run = await wakeIssue(heartbeat, agentId, issueId);
      expect(run).not.toBeNull();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      return { finishedRun, fallbackCwd: resolveDefaultAgentWorkspaceDir(agentId) };
    });

    // 1. Fails typed, not with an opaque/mismatched downstream error.
    expect(finishedRun).toMatchObject({ status: "failed" });
    expect(finishedRun?.errorCode).toBe(WORKSPACE_PREPARATION_FAILURE_CODE);
    expect(finishedRun?.error ?? "").toContain(preferredWorkspaceId);
    expect(finishedRun?.error ?? "").toMatch(/refusing to fall back to a different repository/i);

    // 2. The typed failure identifies the intended (preferred) repo/workspace.
    const resultJson = (finishedRun?.resultJson ?? {}) as Record<string, unknown>;
    const workspacePreparation = resultJson.workspacePreparation as Record<string, unknown> | undefined;
    expect(workspacePreparation).toMatchObject({
      reason: "preferred_workspace_clone_failed",
      workspaceId: preferredWorkspaceId,
      repoUrl: preferredRepoUrl,
    });
    expect(typeof workspacePreparation?.cause).toBe("string");
    expect((workspacePreparation?.cause as string).length).toBeGreaterThan(0);

    // 3. No cross-repo fallthrough: the adapter never ran, so no work was ever
    // dispatched against the sibling repo (or anywhere else).
    expect(adapterExecute).not.toHaveBeenCalled();

    // 4. No execution workspace was realized for this run at all.
    const executionWorkspaceRows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(executionWorkspaceRows).toHaveLength(0);

    // 5. The sibling repo was never touched.
    const { stdout: siblingLog } = await execFileAsync("git", ["log", "--oneline"], {
      cwd: siblingRepoRoot,
    });
    expect(siblingLog.trim().split("\n")).toHaveLength(1);

    // 6. The agent's shared fallback workspace was never created/used either.
    await expect(fs.stat(fallbackCwd)).rejects.toThrow();
  }, 20_000);

  it("fails typed as configuration-incomplete when the preferred repo clone fails on missing credentials", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preferred-clone-cred-home-"));
    tempRoots.push(home);
    const siblingRepoRoot = await createGitRepo("paperclip-preferred-clone-cred-sibling-");
    tempRoots.push(siblingRepoRoot);

    // Deterministic, network-free credential-missing clone failure: a
    // loopback-only HTTP server that answers every request with 401
    // Unauthorized. `git clone` against it needs credentials, and because
    // the child process has no tty to prompt on, git fails fast with
    // "...terminal prompts disabled", which the classifier matches as
    // preferred_workspace_clone_credential_missing. No real network access
    // or credentials are involved -- the server only ever binds to 127.0.0.1.
    const unauthorizedServer = http.createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Unauthorized");
    });
    await new Promise<void>((resolve) => unauthorizedServer.listen(0, "127.0.0.1", resolve));
    const unauthorizedServerAddress = unauthorizedServer.address();
    if (!unauthorizedServerAddress || typeof unauthorizedServerAddress === "string") {
      throw new Error("expected the loopback unauthorized-clone test server to bind a TCP port");
    }
    const preferredRepoUrl = `http://127.0.0.1:${unauthorizedServerAddress.port}/gloops-ui-private.git`;

    const { agentId, issueId, preferredWorkspaceId } = await seedRunTarget(db, {
      preferredRepoUrl,
      siblingRepoRoot,
    });

    try {
      const heartbeat = heartbeatService(db);
      const { finishedRun, fallbackCwd } = await withPaperclipHome(home, async () => {
        const run = await wakeIssue(heartbeat, agentId, issueId);
        expect(run).not.toBeNull();
        const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
        return { finishedRun, fallbackCwd: resolveDefaultAgentWorkspaceDir(agentId) };
      });

      // 1. Fails typed as configuration-incomplete, not the generic
      // workspace-preparation-failed error, so the dispatcher's
      // shouldBlockImmediately check routes it to a human owner instead of
      // looping immediate-recovery retries forever.
      expect(finishedRun).toMatchObject({ status: "failed" });
      expect(finishedRun?.errorCode).toBe(CONFIGURATION_INCOMPLETE_FAILURE_CODE);
      expect(finishedRun?.error ?? "").toContain(preferredWorkspaceId);
      expect(finishedRun?.error ?? "").toMatch(/refusing to fall back to a different repository/i);

      // 2. The typed failure identifies the intended (preferred) repo/workspace
      // and the credential-missing classification.
      const resultJson = (finishedRun?.resultJson ?? {}) as Record<string, unknown>;
      const configurationIncomplete = resultJson.configurationIncomplete as Record<string, unknown> | undefined;
      expect(configurationIncomplete).toMatchObject({
        reason: "preferred_workspace_clone_credential_missing",
        workspaceId: preferredWorkspaceId,
        repoUrl: preferredRepoUrl,
      });
      expect(typeof configurationIncomplete?.cause).toBe("string");
      expect((configurationIncomplete?.cause as string).length).toBeGreaterThan(0);

      // 3. No cross-repo fallthrough: the adapter never ran, so no work was ever
      // dispatched against the sibling repo (or anywhere else).
      expect(adapterExecute).not.toHaveBeenCalled();

      // 4. No execution workspace was realized for this run at all.
      const executionWorkspaceRows = await db
        .select()
        .from(executionWorkspaces)
        .where(eq(executionWorkspaces.sourceIssueId, issueId));
      expect(executionWorkspaceRows).toHaveLength(0);

      // 5. The sibling repo was never touched.
      const { stdout: siblingLog } = await execFileAsync("git", ["log", "--oneline"], {
        cwd: siblingRepoRoot,
      });
      expect(siblingLog.trim().split("\n")).toHaveLength(1);

      // 6. The agent's shared fallback workspace was never created/used either.
      await expect(fs.stat(fallbackCwd)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => unauthorizedServer.close(() => resolve()));
    }
  }, 20_000);

  it("fails typed against the intended workspace when its project-workspace row is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preferred-missing-row-home-"));
    tempRoots.push(home);
    const siblingRepoRoot = await createGitRepo("paperclip-preferred-missing-row-sibling-");
    tempRoots.push(siblingRepoRoot);

    // The issue names a preferred project workspace that lives under a
    // different project, so no matching row exists in THIS project's candidate
    // set -- only the unrelated sibling row is present. Selection must NOT
    // iterate to the sibling (a different repo); it must fail typed against the
    // intended-but-absent workspace.
    const { agentId, issueId, preferredWorkspaceId } = await seedRunTarget(db, {
      siblingRepoRoot,
      preferredWorkspaceInSeparateProject: true,
    });

    const heartbeat = heartbeatService(db);
    const { finishedRun, fallbackCwd } = await withPaperclipHome(home, async () => {
      const run = await wakeIssue(heartbeat, agentId, issueId);
      expect(run).not.toBeNull();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      return { finishedRun, fallbackCwd: resolveDefaultAgentWorkspaceDir(agentId) };
    });

    // 1. Fails typed against the intended (missing) workspace.
    expect(finishedRun).toMatchObject({ status: "failed" });
    expect(finishedRun?.errorCode).toBe(WORKSPACE_PREPARATION_FAILURE_CODE);
    expect(finishedRun?.error ?? "").toContain(preferredWorkspaceId);
    expect(finishedRun?.error ?? "").toMatch(/refusing to fall back to a different repository/i);

    // 2. The typed failure names the intended workspace and the missing-row reason.
    const resultJson = (finishedRun?.resultJson ?? {}) as Record<string, unknown>;
    const workspacePreparation = resultJson.workspacePreparation as Record<string, unknown> | undefined;
    expect(workspacePreparation).toMatchObject({
      reason: "preferred_workspace_row_missing",
      workspaceId: preferredWorkspaceId,
    });

    // 3. No cross-repo fallthrough: the sibling row was never selected/run.
    expect(adapterExecute).not.toHaveBeenCalled();

    // 4. No execution workspace was realized for this run at all.
    const executionWorkspaceRows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(executionWorkspaceRows).toHaveLength(0);

    // 5. The sibling repo was never touched.
    const { stdout: siblingLog } = await execFileAsync("git", ["log", "--oneline"], {
      cwd: siblingRepoRoot,
    });
    expect(siblingLog.trim().split("\n")).toHaveLength(1);

    // 6. The agent's shared fallback workspace was never created/used either.
    await expect(fs.stat(fallbackCwd)).rejects.toThrow();
  }, 20_000);

  it("fails typed (no fallback workspace, adapter never runs) when the project has zero candidate workspace rows", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preferred-zero-rows-home-"));
    tempRoots.push(home);

    // The issue names a preferred project workspace that lives under a DIFFERENT
    // project, and the issue's own project has NO workspace rows at all. Without
    // the zero-row guard, selection would skip the nonempty-rows branch and the
    // later `if (workspaceProjectId)` path would create a generic managed
    // workspace (repoUrl: null) for an unrelated repo.
    const { agentId, issueId, projectId, preferredWorkspaceId } = await seedRunTarget(db, {
      siblingRepoRoot: path.join(home, "unused-no-sibling"),
      preferredWorkspaceInSeparateProject: true,
      createSiblingWorkspace: false,
    });

    // Precondition: the issue's project truly has zero candidate workspace rows.
    const projectRows = await db
      .select()
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.projectId, projectId));
    expect(projectRows).toHaveLength(0);

    const heartbeat = heartbeatService(db);
    const { finishedRun, fallbackCwd } = await withPaperclipHome(home, async () => {
      const run = await wakeIssue(heartbeat, agentId, issueId);
      expect(run).not.toBeNull();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      return { finishedRun, fallbackCwd: resolveDefaultAgentWorkspaceDir(agentId) };
    });

    // 1. Fails typed against the intended (absent) workspace.
    expect(finishedRun).toMatchObject({ status: "failed" });
    expect(finishedRun?.errorCode).toBe(WORKSPACE_PREPARATION_FAILURE_CODE);
    expect(finishedRun?.error ?? "").toContain(preferredWorkspaceId);
    expect(finishedRun?.error ?? "").toMatch(/refusing to fall back to a different repository/i);

    // 2. The typed failure names the intended workspace and the missing-row reason.
    const resultJson = (finishedRun?.resultJson ?? {}) as Record<string, unknown>;
    const workspacePreparation = resultJson.workspacePreparation as Record<string, unknown> | undefined;
    expect(workspacePreparation).toMatchObject({
      reason: "preferred_workspace_row_missing",
      workspaceId: preferredWorkspaceId,
    });

    // 3. No cross-repo fallthrough: no generic managed workspace was created, so
    // the adapter never ran.
    expect(adapterExecute).not.toHaveBeenCalled();

    // 4. No execution workspace was realized for this run at all.
    const executionWorkspaceRows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(executionWorkspaceRows).toHaveLength(0);

    // 5. The agent's shared fallback workspace was never created/used either.
    await expect(fs.stat(fallbackCwd)).rejects.toThrow();
  }, 20_000);

  it("fails typed against the preferred repo when its explicit checkout path is missing", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preferred-missing-cwd-home-"));
    tempRoots.push(home);
    const siblingRepoRoot = await createGitRepo("paperclip-preferred-missing-cwd-sibling-");
    tempRoots.push(siblingRepoRoot);

    // The preferred workspace row exists with an EXPLICIT checkout path that
    // does not exist on disk (the checkout disappeared). Because the cwd is
    // explicit, no repoUrl-based managed clone is attempted, so this stays
    // network-free -- the repoUrl is only carried in the typed failure.
    const preferredCwd = path.join(home, "preferred-checkout", "gloops-ui");
    const preferredRepoUrl = "https://example.invalid/acme/gloops-ui.git";

    const { agentId, issueId, preferredWorkspaceId } = await seedRunTarget(db, {
      siblingRepoRoot,
      preferredRepoUrl,
      preferredWorkspaceCwd: preferredCwd,
    });

    const heartbeat = heartbeatService(db);
    const { finishedRun, fallbackCwd } = await withPaperclipHome(home, async () => {
      const run = await wakeIssue(heartbeat, agentId, issueId);
      expect(run).not.toBeNull();
      const finishedRun = await waitForRunToFinish(heartbeat, run!.id);
      return { finishedRun, fallbackCwd: resolveDefaultAgentWorkspaceDir(agentId) };
    });

    // 1. Fails typed against the intended (preferred) workspace/repo.
    expect(finishedRun).toMatchObject({ status: "failed" });
    expect(finishedRun?.errorCode).toBe(WORKSPACE_PREPARATION_FAILURE_CODE);
    expect(finishedRun?.error ?? "").toContain(preferredWorkspaceId);
    expect(finishedRun?.error ?? "").toMatch(/refusing to fall back to a different repository/i);

    // 2. The typed failure names the intended repo/workspace and the missing-cwd reason.
    const resultJson = (finishedRun?.resultJson ?? {}) as Record<string, unknown>;
    const workspacePreparation = resultJson.workspacePreparation as Record<string, unknown> | undefined;
    expect(workspacePreparation).toMatchObject({
      reason: "preferred_workspace_cwd_missing",
      workspaceId: preferredWorkspaceId,
      repoUrl: preferredRepoUrl,
    });

    // 3. No cross-repo fallthrough: the sibling row was never selected/run.
    expect(adapterExecute).not.toHaveBeenCalled();

    // 4. No execution workspace was realized for this run at all.
    const executionWorkspaceRows = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.sourceIssueId, issueId));
    expect(executionWorkspaceRows).toHaveLength(0);

    // 5. The sibling repo was never touched.
    const { stdout: siblingLog } = await execFileAsync("git", ["log", "--oneline"], {
      cwd: siblingRepoRoot,
    });
    expect(siblingLog.trim().split("\n")).toHaveLength(1);

    // 6. The agent's shared fallback workspace was never created/used either.
    await expect(fs.stat(fallbackCwd)).rejects.toThrow();
  }, 20_000);
});
