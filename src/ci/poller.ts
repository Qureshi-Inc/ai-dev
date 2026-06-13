import { config } from "../config.js";
import { JobState } from "../types.js";
import { listActiveJobs, setState, updateJob } from "../storage/state.js";
import { octokitForRepo } from "../github/app.js";
import { findLatestRunForSha } from "../github/ci.js";
import { handleWorkflowConclusion } from "../agent/orchestrator.js";
import { logger } from "../utils/logger.js";

let timer: NodeJS.Timeout | null = null;

/** Fallback that catches missed `workflow_run.completed` webhooks and enforces a wait timeout. */
export function startCiPoller(): void {
  if (config.ci.pollIntervalMs <= 0) {
    logger.info("ci poller disabled (CI_POLL_INTERVAL_MS=0)");
    return;
  }
  timer = setInterval(() => {
    void sweep();
  }, config.ci.pollIntervalMs);
  logger.info({ intervalMs: config.ci.pollIntervalMs }, "ci poller started");
}

export function stopCiPoller(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function sweep(): Promise<void> {
  const jobs = listActiveJobs().filter(
    (j) => j.state === JobState.CI_RUNNING && j.headSha && j.branch,
  );
  for (const job of jobs) {
    try {
      const ageMs = Date.now() - new Date(job.updatedAt).getTime();
      const { octokit } = await octokitForRepo(job.owner, job.repo);
      const run = await findLatestRunForSha(octokit, job.owner, job.repo, job.headSha!);

      if (run && run.status === "completed") {
        logger.info({ jobId: job.id, runId: run.id }, "ci poller observed completed run");
        handleWorkflowConclusion({
          owner: job.owner,
          repo: job.repo,
          headBranch: job.branch!,
          headSha: job.headSha!,
          conclusion: run.conclusion ?? "unknown",
          runId: run.id,
        });
      } else if (ageMs > config.ci.waitTimeoutMs) {
        logger.warn({ jobId: job.id, ageMs }, "ci wait timeout exceeded; marking job failed");
        updateJob(job.id, { lastError: "CI wait timeout exceeded" });
        setState(job.id, JobState.FAILED);
      }
    } catch (err) {
      logger.warn({ jobId: job.id, err: (err as Error).message }, "ci poll error");
    }
  }
}
