import type { InstallationOctokit } from "./app.js";
import type { CiOutcome } from "../types.js";
import { extractRelevantLogs } from "../ci/logs.js";
import { logger } from "../utils/logger.js";

interface WorkflowRunLite {
  id: number;
  status: string | null;
  conclusion: string | null;
  headSha: string;
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "startup_failure",
  "action_required",
]);

/** All workflow runs for a given head SHA (newest first). */
async function listRunsForSha(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<WorkflowRunLite[]> {
  const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: headSha,
    per_page: 50,
  });
  const runs = (data.workflow_runs ?? []).map((r) => ({
    id: r.id,
    status: r.status,
    conclusion: r.conclusion,
    headSha: r.head_sha,
  }));
  runs.sort((a, b) => b.id - a.id);
  return runs;
}

/**
 * Whether ANY CI signal exists for a commit: a workflow run OR a check-run.
 * Used to distinguish "CI is slow" from "this repo has no CI for this commit".
 */
export async function hasCiForSha(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<boolean> {
  const runs = await octokit.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: headSha,
    per_page: 1,
  });
  if ((runs.data.total_count ?? runs.data.workflow_runs?.length ?? 0) > 0) return true;
  const checks = await octokit.rest.checks.listForRef({ owner, repo, ref: headSha, per_page: 1 });
  return (checks.data.total_count ?? 0) > 0;
}

/** Most recent workflow run for a given head SHA, or null if none exists yet. */
export async function findLatestRunForSha(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<WorkflowRunLite | null> {
  const runs = await listRunsForSha(octokit, owner, repo, headSha);
  return runs[0] ?? null;
}

function decodeBody(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return String(data ?? "");
}

/** Concatenate logs from failed jobs of a run into a single excerpt for the debug model. */
export async function collectFailureLogs(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  runId: number,
): Promise<string> {
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
    per_page: 50,
  });
  const failed = (data.jobs ?? []).filter((j) => j.conclusion === "failure");
  const targets = failed.length > 0 ? failed : (data.jobs ?? []);

  const chunks: string[] = [];
  for (const job of targets.slice(0, 5)) {
    try {
      const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
      });
      const text = decodeBody(res.data);
      chunks.push(`===== JOB: ${job.name} (${job.conclusion}) =====\n${extractRelevantLogs(text)}`);
    } catch (err) {
      logger.warn({ owner, repo, jobId: job.id, err: (err as Error).message }, "failed to fetch job logs");
    }
  }
  return chunks.join("\n\n") || "(no job logs available)";
}

/**
 * Aggregate a CI outcome across ALL workflow runs for the head SHA:
 * - null while any run is still in progress (or none exist yet) -> keep waiting
 * - "failure" if any run failed (logs taken from a failing run)
 * - "success" only when every run completed and none failed
 */
export async function buildCiOutcome(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  headSha: string,
): Promise<CiOutcome | null> {
  const runs = await listRunsForSha(octokit, owner, repo, headSha);
  if (runs.length === 0) return null;
  if (runs.some((r) => r.status !== "completed")) return null;

  const failing = runs.find((r) => FAILING_CONCLUSIONS.has(r.conclusion ?? ""));
  if (failing) {
    const logsExcerpt = await collectFailureLogs(octokit, owner, repo, failing.id);
    return {
      conclusion: (failing.conclusion ?? "failure") as CiOutcome["conclusion"],
      runId: failing.id,
      headSha,
      logsExcerpt,
    };
  }
  return { conclusion: "success", runId: runs[0].id, headSha, logsExcerpt: "" };
}
