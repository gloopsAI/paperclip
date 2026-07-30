import type { Request, Response, NextFunction } from "express";
import type { Db } from "@paperclipai/db";
import { ZodError } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";
import { COMPANY_IMPORT_API_PATH } from "../routes/company-import-paths.js";
import { logger } from "./logger.js";
import {
  recordResponsibleUserDenialOnActiveRun,
} from "../services/responsible-user-denial-run-outcomes.js";
import { recordServerFailure } from "../services/gbrain-failure-recorder.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

function getPaperclipDb(req: Request): Db | null {
  const locals = req.app?.locals as { paperclipDb?: Db; db?: Db } | undefined;
  return locals?.paperclipDb ?? locals?.db ?? null;
}

function recordResponsibleUserDenialFromHttpError(
  req: Request,
  details: Record<string, unknown> | null,
) {
  if (req.actor?.type !== "agent") return;
  const db = getPaperclipDb(req);
  if (!db) return;

  void recordResponsibleUserDenialOnActiveRun(db, {
    runId: req.actor.runId ?? null,
    agentId: req.actor.agentId ?? null,
    companyId: req.actor.companyId ?? null,
    code: details?.code,
  }).catch((recordErr) => {
    logger.warn(
      {
        err: recordErr,
        runId: req.actor?.runId ?? null,
        agentId: req.actor?.type === "agent" ? req.actor.agentId ?? null : null,
      },
      "failed to record responsible-user denial on heartbeat run",
    );
  });
}

/**
 * Best-effort OK-09 microplane integration: surface 5xx (and stable 4xx
 * HttpError codes) as normalized FailureFingerprints so the implementer
 * and reviewer can request them via the recent-fingerprints surface.
 * Never throws into the request pipeline.
 */
function recordGbrainFailureFromError(
  req: Request,
  status: number,
  err: Error,
  code: string | null,
): void {
  try {
    const url = req.originalUrl || req.url || null;
    const method = req.method || null;
    const companyId =
      typeof req.params?.companyId === "string" && req.params.companyId.length > 0
        ? req.params.companyId
        : null;
    recordServerFailure({
      companyId,
      errorCode: code ?? err.name ?? "unknown_error",
      message: err.message || "unknown error",
      tool: "http",
      method,
      url,
      recoveryHint: status >= 500 ? "check server logs for stack" : null,
    });
  } catch {
    // Swallow — gbrain integration is advisory and must never affect responses.
  }
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof HttpError) {
    const details = err.details && typeof err.details === "object" && !Array.isArray(err.details)
      ? err.details as Record<string, unknown>
      : null;
    recordResponsibleUserDenialFromHttpError(req, details);
    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    // OK-09 microplane integration: surface server errors as advisory
    // FailureFingerprints so they can be requested via /recent. 5xx is
    // always recorded; 4xx is recorded only when the HttpError carries a
    // stable code (e.g. account_locked, auth_unauthorized).
    const stableCode =
      typeof details?.code === "string" ? details.code : null;
    if (err.status >= 500 || stableCode) {
      recordGbrainFailureFromError(req, err.status, err, stableCode);
    }
    res.status(err.status).json({
      error: err.message,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(typeof details?.remediation === "string" ? { remediation: details.remediation } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.errors });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });
  recordGbrainFailureFromError(req, 500, rootError, null);

  res.status(500).json({
    error: "Internal server error",
    ...(shouldExposeTrustedCloudTenantImportError(req) ? { message: rootError.message } : {}),
  });
}

function shouldExposeTrustedCloudTenantImportError(req: Request) {
  return req.actor?.source === "cloud_tenant"
    && req.method === "POST"
    && req.originalUrl.split("?")[0] === COMPANY_IMPORT_API_PATH;
}
