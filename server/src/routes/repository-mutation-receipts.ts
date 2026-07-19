import { readFileSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import { HttpError } from "../errors.js";
import {
  repositoryMutationReceiptService,
  RepositoryMutationReceiptConflictError,
  type RepositoryMutationPreparedReceipt,
  type RepositoryMutationTerminalReceipt,
} from "../services/repository-mutation-receipts.js";

const DEFAULT_TOKEN_PATH = "/run/secrets/paperclip-github-broker-receipt-token";
const TOKEN_PATTERN = /^pcp_broker_[0-9a-f]{64}$/;

function brokerToken(req: Request, tokenPath: string): void {
  const supplied = req.header("x-paperclip-github-broker-token") ?? "";
  let expected: string;
  try {
    const metadata = statSync(tokenPath);
    if (metadata.uid !== 0 || (metadata.mode & 0o007) !== 0) {
      throw new Error("broker receipt token file permissions are unsafe");
    }
    expected = readFileSync(tokenPath, "utf8").trim();
  } catch {
    throw new HttpError(503, "Repository mutation broker receipt boundary is unavailable");
  }
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  if (
    !TOKEN_PATTERN.test(expected)
    || suppliedBytes.length !== expectedBytes.length
    || !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new HttpError(401, "Repository mutation broker authentication failed");
  }
}

export function repositoryMutationReceiptRoutes(
  db: Db,
  options: { tokenPath?: string } = {},
) {
  const router = Router();
  const service = repositoryMutationReceiptService(db);
  const tokenPath = options.tokenPath
    ?? process.env.PAPERCLIP_GITHUB_BROKER_RECEIPT_TOKEN_FILE
    ?? DEFAULT_TOKEN_PATH;

  router.get("/heartbeat-runs/:runId/repository-mutation-context", async (req, res) => {
    assertBoard(req);
    brokerToken(req, tokenPath);
    const context = await service.getContext(req.params.runId as string);
    if (!context) {
      res.status(404).json({ error: "Repository mutation context is unavailable" });
      return;
    }
    res.json(context);
  });

  router.post("/heartbeat-runs/:runId/repository-mutation-receipts/prepared", async (req, res) => {
    assertBoard(req);
    brokerToken(req, tokenPath);
    const input = req.body as RepositoryMutationPreparedReceipt;
    if (input?.heartbeatRunId !== req.params.runId) {
      res.status(409).json({ error: "Repository mutation run identity conflicts with the route" });
      return;
    }
    try {
      res.status(201).json(await service.recordPrepared(input));
    } catch (error) {
      if (error instanceof RepositoryMutationReceiptConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  router.post("/heartbeat-runs/:runId/repository-mutation-receipts/terminal", async (req, res) => {
    assertBoard(req);
    brokerToken(req, tokenPath);
    const input = req.body as RepositoryMutationTerminalReceipt;
    if (input?.heartbeatRunId !== req.params.runId) {
      res.status(409).json({ error: "Repository mutation run identity conflicts with the route" });
      return;
    }
    try {
      res.json(await service.recordTerminal(input));
    } catch (error) {
      if (error instanceof RepositoryMutationReceiptConflictError) {
        res.status(409).json({ error: error.message });
        return;
      }
      throw error;
    }
  });

  return router;
}
