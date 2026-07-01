import express, { type Request, type Response } from "express";
import { config, assertGithubConfigured } from "./config.js";
import { logger } from "./utils/logger.js";
import "./storage/db.js"; // initialise schema on boot
import "./storage/projectDb.js"; // initialise project mode tables
import "./storage/taskRunDb.js"; // initialize task run tables
import { listActiveJobs } from "./storage/state.js";
import { listActiveProjects } from "./storage/projectState.js";
import { getGithubApp } from "./github/app.js";
import { registerWebhooks } from "./github/webhooks.js";
import { resumeActiveJobs } from "./agent/orchestrator.js";
import { resumeActiveProjects, getWorkflowEngine } from "./agent/projectOrchestrator.js";
import { startCiPoller } from "./ci/poller.js";
import { pingLmStudio } from "./llm/client.js";
import { queue } from "./queue/queue.js";
import { ClaudeCodeTaskExecutor } from "./agent/claudeCodeExecutor.js";
import { registerTaskExecutor } from "./agent/projectOrchestrator.js";
import { handleSSEStream, startSSEHeartbeat } from "./sse.js";
import { createDashboardApiRouter } from "./dashboardApi.js";
import { startOmlxMonitor } from "./omlx/monitor.js";

async function main(): Promise<void> {
  assertGithubConfigured();

  registerWebhooks();
  const app = getGithubApp();

  const server = express();

  server.get("/healthz", (_req: Request, res: Response) => {
    res.json({
      ok: true,
      queueDepth: queue.size(),
      activeJobs: listActiveJobs().length,
      activeProjects: config.project.enabled ? listActiveProjects().length : 0,
    });
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

  // SSE endpoint
  server.get("/events/stream", handleSSEStream);

  // Dashboard: self-contained HTML served directly from the backend.
  const { renderDashboard, handleDashboardProjects, handleDashboardModelCalls, handleDashboardJobs } = await import("./dashboard.js");
  server.get("/dashboard", renderDashboard);
  // Data endpoints for the inline dashboard's auto-refresh JS.
  server.get("/api/dashboard/projects", handleDashboardProjects);
  server.get("/api/dashboard/model-calls", handleDashboardModelCalls);
  server.get("/api/dashboard/jobs", handleDashboardJobs);

  // Extended dashboard API (overview, project detail, commands, events, health, omlx)
  server.use("/api/dashboard", express.json(), createDashboardApiRouter());

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

  // Register Claude Code executor for Project Mode tasks
  if (config.project.enabled) {
    registerTaskExecutor(new ClaudeCodeTaskExecutor());
    logger.info("project mode: Claude Code task executor registered");
  }

  resumeActiveJobs();
  resumeActiveProjects();

  // Recover stale task runs from previous crashes
  if (config.project.enabled) {
    const engine = getWorkflowEngine();
    engine.recoverStaleRuns().catch(err => logger.warn({ err: (err as Error).message }, "stale run recovery failed"));
  }

  startCiPoller();

  // Start SSE heartbeat and oMLX monitoring
  startSSEHeartbeat();
  startOmlxMonitor();
}

main().catch((err) => {
  logger.fatal({ err: (err as Error).message }, "fatal startup error");
  process.exit(1);
});
