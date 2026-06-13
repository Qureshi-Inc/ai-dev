import type { InstallationOctokit } from "../github/app.js";
import { config } from "../config.js";
import { getJobById, updateJob } from "../storage/state.js";
import { JobState, type IssueJob } from "../types.js";
import { logger } from "../utils/logger.js";

const STEP_LABELS = [
  "Parse issue",
  "Generate plan",
  "Implement changes",
  "Open pull request",
  "CI checks",
  "Merge",
];

/** Number of completed steps, inferred from persisted job fields + state. */
function completedSteps(job: IssueJob): number {
  if (job.state === JobState.MERGED || job.state === JobState.DEPLOYED) return 6;
  let done = 0;
  if (job.spec) done = 1;
  if (job.plan) done = 2;
  if (job.headSha) done = 3;
  if (job.prNumber) done = 4;
  return done;
}

function currentLabel(job: IssueJob, index: number): string {
  if (job.state === JobState.FIXING) {
    return `Debugging & fixing (attempt ${job.retryCount + 1}/${config.agent.maxRetries})`;
  }
  if (index === 4 && job.state === JobState.CI_RUNNING) return "CI checks";
  return STEP_LABELS[index];
}

function buildBody(job: IssueJob): string {
  const failed = job.state === JobState.FAILED;
  const finished = job.state === JobState.MERGED || job.state === JobState.DEPLOYED;
  const done = completedSteps(job);

  const lines = STEP_LABELS.map((label, i) => {
    if (finished || i < done) return `- ✅ ${label}`;
    if (i === done) return failed ? `- ❌ ${label}` : `- 🔄 ${currentLabel(job, i)}`;
    return `- ⬜ ${label}`;
  });

  const extra: string[] = [];
  if (job.prNumber) {
    extra.push(`PR: https://github.com/${job.owner}/${job.repo}/pull/${job.prNumber}`);
  }
  if (job.state === JobState.MERGED) extra.push("🎉 Merged.");
  if (job.state === JobState.DEPLOYED) extra.push("🎉 Merged · 🚀 deploy webhook fired.");
  if (failed && job.lastError) extra.push(`⚠️ ${job.lastError}`);

  return [
    "### 🤖 ai-dev — automated run",
    "",
    ...lines,
    "",
    ...extra,
    "",
    `_updated ${new Date().toISOString()}_`,
  ].join("\n");
}

/**
 * Create or update a single status comment on the given issue/PR number.
 * Returns the (possibly new) comment id, or null on failure. A PR is an issue
 * in GitHub's API, so the same calls work for both.
 */
async function upsertComment(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number | null,
  body: string,
): Promise<number | null> {
  try {
    if (commentId) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
      return commentId;
    }
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  } catch {
    // If the stored comment was deleted, try creating a fresh one once.
    if (commentId) {
      try {
        const { data } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body,
        });
        return data.id;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/**
 * Update the live status comment on the issue AND (once it exists) the PR.
 * Best-effort: never throws, so progress reporting can't break the job.
 */
export async function reportProgress(octokit: InstallationOctokit, jobId: number): Promise<void> {
  const job = getJobById(jobId);
  if (!job) return;
  const body = buildBody(job);

  try {
    const issueCommentId = await upsertComment(
      octokit,
      job.owner,
      job.repo,
      job.issueNumber,
      job.progressCommentId,
      body,
    );
    if (issueCommentId && issueCommentId !== job.progressCommentId) {
      updateJob(jobId, { progressCommentId: issueCommentId });
    }

    if (job.prNumber && job.prNumber !== job.issueNumber) {
      const prCommentId = await upsertComment(
        octokit,
        job.owner,
        job.repo,
        job.prNumber,
        job.progressPrCommentId,
        body,
      );
      if (prCommentId && prCommentId !== job.progressPrCommentId) {
        updateJob(jobId, { progressPrCommentId: prCommentId });
      }
    }
  } catch (err) {
    logger.warn({ jobId, err: (err as Error).message }, "progress update failed (non-fatal)");
  }
}
