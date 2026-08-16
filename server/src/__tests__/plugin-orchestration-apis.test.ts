import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  costEvents,
  createDb,
  executionWorkspaces,
  externalObjectMentions,
  externalObjects,
  heartbeatRuns,
  issueRelations,
  issues,
  pluginManagedResources,
  plugins,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { PAPERCLIP_EXECUTION_RECEIPT_KEY } from "@paperclipai/adapter-utils/execution-envelope";
import { buildHostServices } from "../services/plugin-host-services.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: async () => {},
        subscribe: () => {},
      };
    },
  } as any;
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

function executionTruthReceipt(workId: string) {
  const body = {
    schemaVersion: "gloops.execution-truth.operator-receipt.v2",
    work: { id: workId },
    budget: { exhausted: [] },
    route: { observedPathIds: ["ollama-cloud-cli"], prohibitedPathObserved: false },
    continuation: { required: true, valid: true },
    verification: {
      exactHeadAligned: true,
      exactHeadSha: "a".repeat(40),
      allChecksPassed: true,
      review: { status: "accepted", headSha: "a".repeat(40), unresolvedThreads: 0 },
    },
    authority: { humanRequired: false },
    status: "built",
  };
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
      : value;
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(stable(body))).digest("hex")}`;
  return { ...body, digest };
}

function terminalExecutionTruthReceipt(workId: string, headSha: string, mergeCommitSha: string) {
  const receipt = executionTruthReceipt(workId);
  const body = {
    ...receipt,
    status: "operational",
    verification: {
      ...(receipt.verification as Record<string, unknown>),
      review: {
        status: "accepted",
        headSha,
        mergeCommitSha,
        unresolvedThreads: 0,
        source: "github_merge",
      },
    },
  } as Record<string, unknown>;
  delete body.digest;
  const stable = (value: unknown): unknown => Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)]))
      : value;
  return {
    ...body,
    digest: `sha256:${createHash("sha256").update(JSON.stringify(stable(body))).digest("hex")}`,
  };
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plugin orchestration API tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("plugin orchestration APIs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-orchestration-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(externalObjectMentions);
    await db.delete(externalObjects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(pluginManagedResources);
    await db.delete(projects);
    await db.delete(plugins);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: issuePrefix(companyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: "true" },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function makeLocalRoot() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-plugin-host-folder-"));
    tempRoots.push(root);
    return root;
  }

  it("returns plugin-safe execution workspace metadata scoped to the company", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const otherCompanyId = randomUUID();
    const projectId = randomUUID();
    const workspaceId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other",
      issuePrefix: issuePrefix(otherCompanyId),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Workspaces",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      projectId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "Feature workspace",
      status: "active",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerRef: "/tmp/paperclip-feature",
      metadata: {
        providerMetadata: { sandboxId: "sandbox-1" },
        workspaceRealizationRequest: { hiddenInternal: true },
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.workspace", createEventBusStub());

    await expect(services.executionWorkspaces.get({ workspaceId, companyId })).resolves.toMatchObject({
      id: workspaceId,
      companyId,
      projectId,
      projectWorkspaceId: null,
      path: "/tmp/paperclip-feature",
      cwd: "/tmp/paperclip-feature",
      repoUrl: "https://example.com/paperclip.git",
      baseRef: "main",
      branchName: "feature/workspace",
      providerType: "git_worktree",
      providerMetadata: { sandboxId: "sandbox-1" },
    });
    await expect(services.executionWorkspaces.get({ workspaceId, companyId: otherCompanyId })).resolves.toBeNull();
  });

  it("creates plugin-origin issues with full orchestration fields and audit activity", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const originRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: originRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId: blockerIssueId },
    });
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Blocker",
      status: "todo",
      priority: "medium",
      identifier: `${issuePrefix(companyId)}-blocker`,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const issue = await services.issues.create({
      companyId,
      title: "Plugin child issue",
      status: "todo",
      assigneeAgentId: agentId,
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
      actorAgentId: agentId,
      actorRunId: originRunId,
    });

    const [stored] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stored?.originKind).toBe("plugin:paperclip.missions");
    expect(stored?.originId).toBe("mission-alpha");
    expect(stored?.billingCode).toBe("mission:alpha");
    expect(stored?.assigneeAgentId).toBe(agentId);
    expect(stored?.createdByAgentId).toBe(agentId);
    expect(stored?.originRunId).toBe(originRunId);

    const [relation] = await db
      .select()
      .from(issueRelations)
      .where(and(eq(issueRelations.issueId, blockerIssueId), eq(issueRelations.relatedIssueId, issue.id)));
    expect(relation?.type).toBe("blocks");

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id)));
    expect(activities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorType: "plugin",
          actorId: "plugin-record-id",
          action: "issue.created",
          agentId,
          details: expect.objectContaining({
            sourcePluginId: "plugin-record-id",
            sourcePluginKey: "paperclip.missions",
            initiatingActorType: "agent",
            initiatingActorId: agentId,
            initiatingRunId: originRunId,
          }),
        }),
      ]),
    );
  });

  it("returns one issue and records one create activity for concurrent and replayed idempotent creates", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const request = {
      companyId,
      title: "Idempotent child issue",
      status: "todo" as const,
      assigneeAgentId: agentId,
      originId: "mission-idempotent",
      actorAgentId: agentId,
      idempotencyKey: "mission:alpha:child:1",
    };

    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => services.issues.create(request)),
    );
    const replay = await services.issues.create(request);
    const issueIds = new Set([...concurrent, replay].map((issue) => issue.id));

    expect(issueIds).toEqual(new Set([concurrent[0]!.id]));
    const stored = await db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originId, "mission-idempotent"),
      ));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.originFingerprint).toMatch(/^plugin-issue-create:v1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(stored[0]?.originFingerprint).not.toContain(request.idempotencyKey);

    const activities = await db
      .select()
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "issue.created"),
        eq(activityLog.entityId, concurrent[0]!.id),
      ));
    expect(activities).toHaveLength(1);
  });

  it("rejects idempotency collisions while isolating keys by plugin and company", async () => {
    const first = await seedCompanyAndAgent();
    const second = await seedCompanyAndAgent();
    const missions = buildHostServices(db, "missions-plugin-id", "paperclip.missions", createEventBusStub());
    const missionsAfterReinstall = buildHostServices(
      db,
      "missions-plugin-reinstalled-id",
      "paperclip.missions",
      createEventBusStub(),
    );
    const planning = buildHostServices(db, "planning-plugin-id", "paperclip.planning", createEventBusStub());

    const original = await missions.issues.create({
      companyId: first.companyId,
      title: "Original request",
      idempotencyKey: "shared-key",
    });
    const replayAfterReinstall = await missionsAfterReinstall.issues.create({
      companyId: first.companyId,
      title: "Original request",
      idempotencyKey: "shared-key",
    });
    expect(replayAfterReinstall.id).toBe(original.id);
    await expect(missions.issues.create({
      companyId: first.companyId,
      title: "Changed request",
      idempotencyKey: "shared-key",
    })).rejects.toThrow("idempotencyKey was already used with different create parameters");

    const scopeBound = await missions.issues.create({
      companyId: first.companyId,
      title: "Scope-bound request",
      idempotencyKey: "scope-key",
    });
    await db
      .update(issues)
      .set({ originKind: "plugin:other.plugin" })
      .where(eq(issues.id, scopeBound.id));
    await expect(missions.issues.create({
      companyId: first.companyId,
      title: "Scope-bound request",
      idempotencyKey: "scope-key",
    })).rejects.toThrow("idempotency scope no longer belongs to this plugin");

    const otherPlugin = await planning.issues.create({
      companyId: first.companyId,
      title: "Original request",
      idempotencyKey: "shared-key",
    });
    const otherCompany = await missions.issues.create({
      companyId: second.companyId,
      title: "Original request",
      idempotencyKey: "shared-key",
    });

    expect(otherPlugin.id).not.toBe(original.id);
    expect(otherCompany.id).not.toBe(original.id);
    expect(otherPlugin.originKind).toBe("plugin:paperclip.planning");
    expect(otherCompany.companyId).toBe(second.companyId);
  });

  it("enforces plugin origin namespaces", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const featureIssue = await services.issues.create({
      companyId,
      title: "Feature issue",
      originKind: "plugin:paperclip.missions:feature",
      originId: "mission-alpha:feature-1",
    });
    expect(featureIssue.originKind).toBe("plugin:paperclip.missions:feature");

    await expect(
      services.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");

    await expect(
      services.issues.update({
        issueId: featureIssue.id,
        companyId,
        patch: { originKind: "plugin:other.plugin:feature" },
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.missions");
  });

  it("accepts terminal truth only from a capability-scoped plugin projection bound to the run", async () => {
    const previousEnv = { ...process.env };
    Object.assign(process.env, {
      PAPERCLIP_EXECUTION_ADMISSION_ENABLED: "true",
      PAPERCLIP_EXECUTION_MAX_RUNS_PER_TASK: "2",
      PAPERCLIP_EXECUTION_MAX_RETRIES_PER_TASK: "1",
      PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_TASK: "50000",
      PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_TASK: "16000",
      PAPERCLIP_EXECUTION_MAX_WALL_MS_PER_TASK: "3600000",
      PAPERCLIP_EXECUTION_MAX_INPUT_TOKENS_PER_INVOCATION: "30000",
      PAPERCLIP_EXECUTION_MAX_OUTPUT_TOKENS_PER_INVOCATION: "8000",
      PAPERCLIP_EXECUTION_MAX_TURNS_PER_INVOCATION: "8",
      PAPERCLIP_EXECUTION_MAX_TOOL_CALLS_PER_INVOCATION: "32",
    });
    try {
      const { companyId, agentId } = await seedCompanyAndAgent();
      const runId = randomUUID();
      const baseServices = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
      const issue = await baseServices.issues.create({
        companyId,
        title: "Governed terminal transition",
        status: "in_progress",
        assigneeAgentId: agentId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: issue.id },
      });
      await expect(baseServices.issues.update({
        issueId: issue.id,
        companyId,
        patch: {
          status: "done",
          executionTruthReceipt: executionTruthReceipt(issue.identifier),
          actorRunId: runId,
        },
      })).rejects.toThrow("execution-truth.project");

      const trustedServices = buildHostServices(
        db,
        "plugin-record-id",
        "paperclip.missions",
        createEventBusStub(),
        undefined,
        { manifest: { capabilities: ["issues.update", "execution-truth.project"] } as any },
      );
      const mismatchedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: mismatchedRunId,
        companyId,
        agentId,
        status: "succeeded",
        contextSnapshot: { issueId: randomUUID() },
      });
      await expect(trustedServices.issues.update({
        issueId: issue.id,
        companyId,
        patch: {
          status: "done",
          executionTruthReceipt: executionTruthReceipt(issue.identifier),
          actorAgentId: agentId,
          actorRunId: mismatchedRunId,
        },
      })).rejects.toThrow("not bound to this issue");
      await expect(trustedServices.issues.update({
        issueId: issue.id,
        companyId,
        patch: {
          status: "done",
          executionTruthReceipt: executionTruthReceipt(issue.identifier),
          actorRunId: runId,
        },
      })).rejects.toThrow("requires actorAgentId");
      const updated = await trustedServices.issues.update({
        issueId: issue.id,
        companyId,
        patch: {
          status: "done",
          executionTruthReceipt: executionTruthReceipt(issue.identifier),
          actorAgentId: agentId,
          actorRunId: runId,
        },
      });
      expect(updated.status).toBe("done");
      const [persistedRun] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(persistedRun?.contextSnapshot).toHaveProperty("paperclipExecutionTruthReceipt");
    } finally {
      process.env = previousEnv;
    }
  });

  it("creates plugin operation issues with the generic operation origin", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());

    const issue = await services.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "mission-alpha:operation-1",
    });

    expect(issue.originKind).toBe("plugin:paperclip.missions:operation");
    expect(issue.originId).toBe("mission-alpha:operation-1");
  });

  it("lets bootstrap-style actions initialize required local folders from an empty root", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclipai.plugin-llm-wiki",
      packageName: "@paperclipai/plugin-llm-wiki",
      version: "0.1.0",
      manifestJson: {
        id: "paperclipai.plugin-llm-wiki",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "LLM Wiki",
        description: "Local-file LLM Wiki plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "wiki-root",
            displayName: "Wiki root",
            access: "readWrite",
            requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
            requiredFiles: ["WIKI.md", "AGENTS.md"],
          },
        ],
      },
      status: "ready",
    });
    const root = await makeLocalRoot();
    const services = buildHostServices(
      db,
      pluginId,
      "paperclipai.plugin-llm-wiki",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclipai.plugin-llm-wiki",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "LLM Wiki",
          description: "Local-file LLM Wiki plugin",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "wiki-root",
              displayName: "Wiki root",
              access: "readWrite",
              requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
              requiredFiles: ["WIKI.md", "AGENTS.md"],
            },
          ],
        },
      },
    );

    const configured = await services.localFolders.configure({
      companyId,
      folderKey: "wiki-root",
      path: root,
      access: "readWrite",
      requiredDirectories: ["raw", "wiki", "wiki/concepts", ".paperclip"],
      requiredFiles: ["WIKI.md", "AGENTS.md"],
    });
    expect(configured.healthy).toBe(false);
    expect(configured.missingDirectories).toEqual([]);
    expect(configured.missingFiles).toEqual(["WIKI.md", "AGENTS.md"]);

    await fs.rm(path.join(root, "raw"), { recursive: true, force: true });
    await fs.rm(path.join(root, "wiki"), { recursive: true, force: true });
    await expect(services.localFolders.readText({ companyId, folderKey: "wiki-root", relativePath: "WIKI.md" }))
      .rejects.toThrow("Local folder is not healthy");
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "WIKI.md",
      contents: "# Wiki\n",
    });
    await services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "wiki-root",
      relativePath: "AGENTS.md",
      contents: "# Agents\n",
    });

    const finalStatus = await services.localFolders.status({ companyId, folderKey: "wiki-root" });
    expect(finalStatus.healthy).toBe(true);
    await expect(fs.stat(path.join(root, "raw"))).resolves.toMatchObject({});
    await expect(fs.stat(path.join(root, "wiki/concepts"))).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(root, "WIKI.md"), "utf8")).resolves.toBe("# Wiki\n");
  });

  it("rejects worker local-folder access for undeclared manifest keys", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.local-folders",
      packageName: "@paperclip/plugin-local-folders",
      version: "0.1.0",
      manifestJson: {
        id: "paperclip.local-folders",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Local Folders",
        description: "Local folder fixture",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["local.folders"],
        entrypoints: { worker: "./dist/worker.js" },
        localFolders: [
          {
            folderKey: "content-root",
            displayName: "Content root",
            access: "readWrite",
          },
        ],
      },
      status: "ready",
    });
    const services = buildHostServices(
      db,
      pluginId,
      "paperclip.local-folders",
      createEventBusStub(),
      undefined,
      {
        manifest: {
          id: "paperclip.local-folders",
          apiVersion: 1,
          version: "0.1.0",
          displayName: "Local Folders",
          description: "Local folder fixture",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["local.folders"],
          entrypoints: { worker: "./dist/worker.js" },
          localFolders: [
            {
              folderKey: "content-root",
              displayName: "Content root",
              access: "readWrite",
            },
          ],
        },
      },
    );
    await expect(services.localFolders.configure({
      companyId,
      folderKey: "ssh",
      path: "/tmp",
      access: "read",
    })).rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.status({ companyId, folderKey: "ssh" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.readText({ companyId, folderKey: "ssh", relativePath: "id_rsa" }))
      .rejects.toThrow("Local folder key is not declared");
    await expect(services.localFolders.writeTextAtomic({
      companyId,
      folderKey: "ssh",
      relativePath: "id_rsa",
      contents: "secret",
    })).rejects.toThrow("Local folder key is not declared");
  });

  it("resolves plugin-managed projects by stable key without overwriting user edits", async () => {
    const { companyId } = await seedCompanyAndAgent();
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.missions",
      packageName: "@paperclip/plugin-missions",
      version: "0.1.0",
      apiVersion: 1,
      categories: ["automation"],
      status: "ready",
      manifestJson: {
        id: "paperclip.missions",
        apiVersion: 1,
        version: "0.1.0",
        displayName: "Missions",
        description: "Mission orchestration",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: ["projects.managed"],
        entrypoints: { worker: "./dist/worker.js" },
        projects: [{
          projectKey: "operations",
          displayName: "Mission Operations",
          description: "Plugin operation inspection area",
          status: "in_progress",
          color: "#14b8a6",
          settings: { surface: "operations" },
        }],
      },
    });

    const services = buildHostServices(db, pluginId, "paperclip.missions", createEventBusStub());
    const missing = await services.projects.getManaged({ companyId, projectKey: "operations" });
    expect(missing.status).toBe("missing");
    expect(missing.projectId).toBeNull();
    await expect(
      db
        .select()
        .from(pluginManagedResources)
        .where(and(
          eq(pluginManagedResources.companyId, companyId),
          eq(pluginManagedResources.pluginId, pluginId),
          eq(pluginManagedResources.resourceKind, "project"),
          eq(pluginManagedResources.resourceKey, "operations"),
        )),
    ).resolves.toHaveLength(0);

    const created = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(created.status).toBe("created");
    expect(created.projectId).toEqual(expect.any(String));
    expect(created.project?.managedByPlugin).toMatchObject({
      pluginId,
      pluginKey: "paperclip.missions",
      pluginDisplayName: "Missions",
      resourceKind: "project",
      resourceKey: "operations",
    });

    await db
      .update(projects)
      .set({ name: "Renamed by operator", description: "User-owned text", updatedAt: new Date() })
      .where(eq(projects.id, created.projectId!));
    await db
      .update(plugins)
      .set({
        manifestJson: {
          id: "paperclip.missions",
          apiVersion: 1,
          version: "0.2.0",
          displayName: "Missions",
          description: "Mission orchestration",
          author: "Paperclip",
          categories: ["automation"],
          capabilities: ["projects.managed"],
          entrypoints: { worker: "./dist/worker.js" },
          projects: [{
            projectKey: "operations",
            displayName: "Upgraded Default Name",
            description: "Upgraded default description",
            status: "planned",
            color: "#f97316",
            settings: { surface: "operations", upgraded: true },
          }],
        },
        updatedAt: new Date(),
      })
      .where(eq(plugins.id, pluginId));

    const resolved = await services.projects.reconcileManaged({ companyId, projectKey: "operations" });

    expect(resolved.status).toBe("resolved");
    expect(resolved.projectId).toBe(created.projectId);
    expect(resolved.project?.name).toBe("Renamed by operator");
    expect(resolved.project?.description).toBe("User-owned text");
    expect(resolved.project?.managedByPlugin?.defaultsJson).toMatchObject({
      displayName: "Upgraded Default Name",
      settings: { upgraded: true },
    });
  });

  it("asserts checkout ownership for run-scoped plugin actions", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Checked out issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.assertCheckoutOwner({
        issueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
    });
  });

  it("refuses plugin wakeups for issues with unresolved blockers", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockerIssueId,
        companyId,
        title: "Unresolved blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked issue",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    await expect(
      services.issues.requestWakeup({
        issueId: blockedIssueId,
        companyId,
        reason: "mission_advance",
      }),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });

  it("returns persisted run context size, usage, metrics, and route without inventing missing evidence", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    const contextSnapshot = { issueId, objective: "bounded pilot" };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Observed run",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot,
      startedAt: new Date("2026-07-14T19:00:00.000Z"),
      finishedAt: new Date("2026-07-14T19:01:00.000Z"),
      lastOutputAt: new Date("2026-07-14T19:00:50.000Z"),
      usageJson: { inputTokens: 1_200, cachedInputTokens: 100, outputTokens: 300 },
      resultJson: {
        summary: 'PAPERCLIP_SWARM_V1:{"action":"review_ready"}',
        execution_metrics: { turns: 4, tool_calls: 9 },
        execution_route: {
          provider_id: "ollama",
          model_id: "ollama/qwen",
          transport: "api",
          path_id: "ollama-cloud",
          runner: "hermes_gateway",
          subscription_class: "ollama_max",
          routing_reason: "cheapest_capable",
          fallback_occurred: false,
          execution_profile: "quality-pilot",
        },
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });

    expect(summary.runs).toEqual([
      expect.objectContaining({
        id: runId,
        contextInputBytes: Buffer.byteLength(JSON.stringify(contextSnapshot), "utf8"),
        resultSummary: 'PAPERCLIP_SWARM_V1:{"action":"review_ready"}',
        usage: { inputTokens: 1_200, cachedInputTokens: 100, outputTokens: 300 },
        executionMetrics: { turns: 4, toolCalls: 9 },
        route: {
          providerId: "ollama",
          modelId: "ollama/qwen",
          transport: "api",
          pathId: "ollama-cloud",
          runner: "hermes_gateway",
          subscriptionClass: "ollama_max",
          routingReason: "cheapest_capable",
          fallbackOccurred: false,
          executionProfile: "quality-pilot",
        },
      }),
    ]);

    await db.update(heartbeatRuns).set({
      resultJson: {
        execution_metrics: { turns: 1, tool_calls: 0 },
        execution_route: {
          provider_id: "ollama",
          model_id: "ollama/qwen",
          transport: "api",
          path_id: "ollama-cloud",
        },
      },
    }).where(eq(heartbeatRuns.id, runId));
    const absent = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(absent.runs[0]?.route).toEqual({
      providerId: "ollama",
      modelId: "ollama/qwen",
      transport: "api",
      pathId: "ollama-cloud",
      runner: null,
      subscriptionClass: null,
      routingReason: null,
      fallbackOccurred: null,
      executionProfile: null,
    });

    await db.update(heartbeatRuns).set({
      resultJson: {
        execution_metrics: {},
        execution_route: { provider_id: "ollama", path_id: "ollama-cloud" },
      },
    }).where(eq(heartbeatRuns.id, runId));
    const missing = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(missing.runs[0]).toMatchObject({ resultSummary: null, executionMetrics: null, route: null });

    await db.update(heartbeatRuns).set({
      usageJson: {
        inputTokens: 1_200,
        cachedInputTokens: 100,
        outputTokens: 300,
        turns: 1,
        toolCalls: 0,
        executionRoute: {
          provider_id: "ollama",
          observed_provider_id: "ollama-cloud",
          model_id: "kimi-k2.7-code",
          transport: "api",
          transport_class: "openai_chat_completions",
          path_id: "ollama-cloud",
          runner: "hermes_gateway",
          subscription_class: "ollama-max",
          billing_class: "subscription_included",
          routing_reason: "capacity-manager-ollama-first",
          fallback_occurred: false,
          execution_profile: "paperclip-execution-only",
        },
      },
      resultJson: null,
    }).where(eq(heartbeatRuns.id, runId));
    const usageBacked = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(usageBacked.runs[0]).toMatchObject({
      executionMetrics: { turns: 1, toolCalls: 0 },
      route: {
        providerId: "ollama",
        modelId: "kimi-k2.7-code",
        transport: "api",
        pathId: "ollama-cloud",
        runner: "hermes_gateway",
        subscriptionClass: "ollama-max",
        routingReason: "capacity-manager-ollama-first",
        fallbackOccurred: false,
        executionProfile: "paperclip-execution-only",
      },
    });
  });

  it("redacts and bounds run summaries before projecting them to plugins", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Secret-safe run summary",
      status: "in_progress",
      priority: "medium",
    });
    const terminalMarker = 'PAPERCLIP_SWARM_V1:{"action":"operations_complete"}';
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot: { issueId },
      resultJson: {
        summary: `Authorization: Bearer ghp_${"s".repeat(40)} ${"x".repeat(700)} ${terminalMarker}`,
      },
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });

    expect(summary.runs[0]?.resultSummary).toHaveLength(500);
    expect(summary.runs[0]?.resultSummary).toContain("***REDACTED***");
    expect(summary.runs[0]?.resultSummary).not.toContain(`ghp_${"s".repeat(40)}`);
    expect(summary.runs[0]?.resultSummary).toContain("...[truncated]...");
    expect(summary.runs[0]?.resultSummary).toContain(terminalMarker);
  });

  it("exposes terminal change evidence only for the current done run and its linked server-observed merged pull request", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    const headSha = "a".repeat(40);
    const mergeCommitSha = "b".repeat(40);
    const receipt = terminalExecutionTruthReceipt("GLO-TERM", headSha, mergeCommitSha);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "GLO-TERM",
      title: "Merged terminal change",
      status: "done",
      priority: "medium",
      completedAt: new Date("2026-08-16T18:00:00.000Z"),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "succeeded",
      invocationSource: "assignment",
      contextSnapshot: { issueId, [PAPERCLIP_EXECUTION_RECEIPT_KEY]: receipt },
    });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId }).where(eq(issues.id, issueId));
    const [pull] = await db.insert(externalObjects).values({
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "gloopsAI/gloops-paperclip-plugin#pull/50",
      statusKey: "merged",
      statusLabel: "Merged",
      statusCategory: "succeeded",
      statusTone: "success",
      isTerminal: true,
      data: { provider: "github", merged: true, headSha, mergeCommitSha },
    }).returning();
    await db.insert(externalObjectMentions).values({
      companyId,
      sourceIssueId: issueId,
      sourceKind: "description",
      objectId: pull!.id,
      providerKey: "github",
      detectorKey: "github",
      objectType: "pull_request",
    });

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(summary.runs[0]?.verifiedTerminalChange).toEqual({
      status: "operational",
      receiptDigest: receipt.digest,
      exactHeadSha: headSha,
      pullRequest: {
        provider: "github",
        externalId: "gloopsAI/gloops-paperclip-plugin#pull/50",
        headSha,
        mergeCommitSha,
      },
    });

    await db.update(externalObjects).set({
      data: { provider: "github", merged: true, headSha, mergeCommitSha: "c".repeat(40) },
    }).where(eq(externalObjects.id, pull!.id));
    const mismatched = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(mismatched.runs[0]?.verifiedTerminalChange).toBeNull();

    await db.update(externalObjects).set({
      data: { provider: "github", merged: true, headSha, mergeCommitSha },
    }).where(eq(externalObjects.id, pull!.id));
    await db.update(issues).set({ status: "in_review", completedAt: null }).where(eq(issues.id, issueId));
    const nonterminal = await services.issues.getOrchestrationSummary({ companyId, issueId, includeSubtree: false });
    expect(nonterminal.runs[0]?.verifiedTerminalChange).toBeNull();
  });

  it("narrows orchestration cost summaries by subtree and billing code", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const unrelatedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Root mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: childIssueId,
        companyId,
        parentId: rootIssueId,
        title: "Child mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
      {
        id: unrelatedIssueId,
        companyId,
        title: "Different mission",
        status: "todo",
        priority: "medium",
        billingCode: "mission:alpha",
      },
    ]);
    await db.insert(costEvents).values([
      {
        companyId,
        agentId,
        issueId: rootIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 10,
        cachedInputTokens: 1,
        outputTokens: 2,
        costCents: 100,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 20,
        cachedInputTokens: 2,
        outputTokens: 4,
        costCents: 200,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: childIssueId,
        billingCode: "mission:beta",
        provider: "test",
        model: "unit",
        inputTokens: 30,
        cachedInputTokens: 3,
        outputTokens: 6,
        costCents: 300,
        occurredAt: new Date(),
      },
      {
        companyId,
        agentId,
        issueId: unrelatedIssueId,
        billingCode: "mission:alpha",
        provider: "test",
        model: "unit",
        inputTokens: 40,
        cachedInputTokens: 4,
        outputTokens: 8,
        costCents: 400,
        occurredAt: new Date(),
      },
    ]);

    const services = buildHostServices(db, "plugin-record-id", "paperclip.missions", createEventBusStub());
    const summary = await services.issues.getOrchestrationSummary({
      companyId,
      issueId: rootIssueId,
      includeSubtree: true,
    });

    expect(new Set(summary.subtreeIssueIds)).toEqual(new Set([rootIssueId, childIssueId]));
    expect(summary.costs).toMatchObject({
      billingCode: "mission:alpha",
      costCents: 300,
      inputTokens: 30,
      cachedInputTokens: 3,
      outputTokens: 6,
    });
  });
});
