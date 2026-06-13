import express, { type Request, type Response } from "express";
import { config, assertGithubConfigured } from "./config.js";
import { logger } from "./utils/logger.js";
import "./storage/db.js"; // initialise schema on boot
import { listActiveJobs } from "./storage/state.js";
import { getGithubApp } from "./github/app.js";
import { registerWebhooks } from "./github/webhooks.js";
import { resumeActiveJobs } from "./agent/orchestrator.js";
import { startCiPoller } from "./ci/poller.js";
import { pingLmStudio } from "./llm/client.js";
import { queue } from "./queue/queue.js";

async function main(): Promise<void> {
  assertGithubConfigured();

  registerWebhooks();
  const app = getGithubApp();

  const server = express();

  server.get("/healthz", (_req: Request, res: Response) => {
    res.json({ ok: true, queueDepth: queue.size(), activeJobs: listActiveJobs().length });
  });

  server.get("/status", (_req: Request, res: Response) => {
    const jobs = listActiveJobs().map((j) => ({
      id: j.id,
      repo: `${j.owner}/${j.repo}`,
      issue: j.issueNumber,
      state: j.state,
      retries: j.retryCount,
      pr: j.prNumber,
      branch: j.branch,
      updatedAt: j.updatedAt,
      lastError: j.lastError,
    }));
    res.json({ queueDepth: queue.size(), jobs });
  });

  // GitHub webhook endpoint. Raw body is required for signature verification.
  server.post(
    "/api/github/webhooks",
    express.raw({ type: "*/*", limit: "25mb" }),
    async (req: Request, res: Response) => {
      const id = req.header("x-github-delivery") ?? "";
      const name = req.header("x-github-event") ?? "";
      const signature = req.header("x-hub-signature-256") ?? "";
      const payload = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body ?? "");
      try {
        await app.webhooks.verifyAndReceive({
          id,
          // The event name is validated by the webhooks library.
          name: name as Parameters<typeof app.webhooks.verifyAndReceive>[0]["name"],
          signature,
          payload,
        });
        res.status(202).json({ ok: true });
      } catch (err) {
        logger.warn({ err: (err as Error).message, event: name }, "webhook verify/receive failed");
        res.status(400).json({ ok: false });
      }
    },
  );

  server.listen(config.port, () => {
    logger.info({ port: config.port }, "ai-dev orchestrator listening");
  });

  // Best-effort LM Studio reachability check (non-fatal; JIT loads on first use).
  pingLmStudio()
    .then((models) => logger.info({ models }, "lm studio reachable"))
    .catch((err) => logger.warn({ err: (err as Error).message }, "lm studio not reachable yet"));

  resumeActiveJobs();
  startCiPoller();
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "fatal startup error");
  process.exit(1);
});
