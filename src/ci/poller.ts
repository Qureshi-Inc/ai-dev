import { config } from "../config.js";
import { JobState } from "../types.js";
import { listActiveJobs } from "../storage/state.js";
import { requestCiEvaluation } from "../agent/orchestrator.js";
import { logger } from "../utils/logger.js";

let timer: NodeJS.Timeout | null = null;

/**
 * Fallback that catches missed `workflow_run.completed` webhooks. Each interval it
 * asks the orchestrator to re-evaluate every job awaiting CI; the orchestrator owns
 * all decisions (green -> merge, red -> fix, no-CI -> policy, timeout -> fail).
 */
export function startCiPoller(): void {
  if (config.ci.pollIntervalMs <= 0) {
    logger.info("ci poller disabled (CI_POLL_INTERVAL_MS=0)");
    return;
  }
  timer = setInterval(sweep, config.ci.pollIntervalMs);
  logger.info({ intervalMs: config.ci.pollIntervalMs }, "ci poller started");
}

export function stopCiPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function sweep(): void {
  const jobs = listActiveJobs().filter(
    (j) => j.state === JobState.CI_RUNNING && j.headSha && j.branch,
  );
  for (const job of jobs) {
    requestCiEvaluation(job.id);
  }
}
