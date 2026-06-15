import type { InstallationOctokit } from "../github/app.js";
import { config } from "../config.js";
import { getJobById, updateJob } from "../storage/state.js";
import { JobState, type IssueJob } from "../types.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Rich status panel rendered as a single, live-updating GitHub comment, plus
// an at-a-glance status label on the issue.
// ---------------------------------------------------------------------------

const STEP_LABELS = [
  "Parse issue",
  "Generate plan",
  "Implement changes",
  "Open pull request",
  "CI checks",
  "Merge",
];

/** Status labels managed on the issue (namespaced so they never clobber the trigger label). */
const STATUS_LABELS = [
  "ai-dev:working",
  "ai-dev:ci",
  "ai-dev:fixing",
  "ai-dev:needs-review",
  "ai-dev:merged",
  "ai-dev:deployed",
  "ai-dev:failed",
] as const;

function labelForState(state: JobState): string | null {
  switch (state) {
    case JobState.QUEUED:
    case JobState.PARSING:
    case JobState.PLANNING:
    case JobState.IMPLEMENTING:
      return "ai-dev:working";
    case JobState.CI_RUNNING:
      return "ai-dev:ci";
    case JobState.FIXING:
      return "ai-dev:fixing";
    case JobState.PR_OPEN:
      return "ai-dev:needs-review";
    case JobState.MERGED:
      return "ai-dev:merged";
    case JobState.DEPLOYED:
      return "ai-dev:deployed";
    case JobState.FAILED:
      return "ai-dev:failed";
    default:
      return null;
  }
}

function completedSteps(job: IssueJob): number {
  if (job.state === JobState.MERGED || job.state === JobState.DEPLOYED) return 6;
  let done = 0;
  if (job.spec) done = 1;
  if (job.plan) done = 2;
  if (job.headSha) done = 3;
  if (job.prNumber) done = 4;
  return done;
}

function statusLine(job: IssueJob, detail?: string): string {
  switch (job.state) {
    case JobState.QUEUED:
      return "Queued.";
    case JobState.PARSING:
      return "Reading the issue and extracting requirements…";
    case JobState.PLANNING:
      return "Planning the implementation…";
    case JobState.IMPLEMENTING:
      return detail ? `Implementing — ${detail}` : "Writing the code…";
    case JobState.CI_RUNNING:
      return "Pushed. Waiting for CI to complete…";
    case JobState.FIXING:
      return `CI failed — debugging (attempt ${job.retryCount + 1}/${config.agent.maxRetries})…`;
    case JobState.PR_OPEN:
      return job.epic
        ? "All steps done and CI is green — ready for your review."
        : "CI is green — awaiting manual merge.";
    case JobState.MERGED:
      return "Merged. 🎉";
    case JobState.DEPLOYED:
      return "Merged and deploy webhook fired. 🚀";
    case JobState.FAILED:
      return "Stopped — see details below.";
    default:
      return "";
  }
}

/**
 * Explicit one-line CI status for the live panel. Surfaces whether CI exists for
 * the current head SHA; mirrors the orchestrator's no-CI merge policy in wording.
 * Returns null until something has been pushed / CI presence is determinable.
 */
function ciStatusLine(job: IssueJob): string | null {
  if (!job.headSha) return null;
  if (job.ciPresent === false) {
    return "ℹ️ No CI configured for this PR — merging without CI checks.";
  }
  if (job.ciPresent === true) {
    switch (job.state) {
      case JobState.CI_RUNNING:
        return "⏳ CI running…";
      case JobState.FIXING:
        return `❌ CI failed (attempt ${job.retryCount + 1}/${config.agent.maxRetries})`;
      case JobState.PR_OPEN:
      case JobState.MERGED:
      case JobState.DEPLOYED:
        return "✅ CI passed";
      default:
        return null;
    }
  }
  return null; // presence not yet determined
}

function modeBadges(job: IssueJob): string {
  const tags: string[] = [];
  if (job.epic) tags.push("`epic`");
  if (job.pro) tags.push("`pro`");
  return tags.length ? ` ${tags.join(" · ")}` : "";
}

function elapsed(job: IssueJob): string {
  const ms = Date.now() - new Date(job.createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function buildBody(job: IssueJob, detail?: string): string {
  const failed = job.state === JobState.FAILED;
  const finished = job.state === JobState.MERGED || job.state === JobState.DEPLOYED;
  const done = completedSteps(job);

  const checklist = STEP_LABELS.map((label, i) => {
    if (finished || i < done) return `- ✅ ${label}`;
    if (i === done) return failed ? `- ❌ ${label}` : `- 🔄 **${label}**`;
    return `- ⬜ ${label}`;
  });

  const repoUrl = `https://github.com/${job.owner}/${job.repo}`;
  const facts: string[] = [];
  if (job.branch) facts.push(`**Branch:** [\`${job.branch}\`](${repoUrl}/tree/${job.branch})`);
  if (job.prNumber) facts.push(`**PR:** [#${job.prNumber}](${repoUrl}/pull/${job.prNumber})`);
  if (job.headSha) {
    facts.push(`**Commit:** [\`${job.headSha.slice(0, 7)}\`](${repoUrl}/commit/${job.headSha})`);
  }
  if (job.retryCount > 0) facts.push(`**Fix attempts:** ${job.retryCount}/${config.agent.maxRetries}`);
  facts.push(`**Elapsed:** ${elapsed(job)}`);

  const ci = ciStatusLine(job);

  const lines = [
    `## 🤖 ai-dev${modeBadges(job)}`,
    "",
    `**Status:** ${statusLine(job, detail)}`,
    ...(ci ? ["", ci] : []),
    "",
    ...checklist,
    "",
    facts.join(" · "),
  ];

  if (failed && job.lastError) {
    lines.push(
      "",
      "<details><summary>Error details</summary>",
      "",
      "```",
      job.lastError,
      "```",
      "",
      "</details>",
    );
  }

  lines.push("", `<sub>ai-dev · updated ${new Date().toISOString()}</sub>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

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

/** Keep a single at-a-glance status label on the issue (replacing prior ai-dev:* ones). */
async function syncStatusLabel(octokit: InstallationOctokit, job: IssueJob): Promise<void> {
  const target = labelForState(job.state);
  if (!target) return;
  try {
    const { data } = await octokit.rest.issues.listLabelsOnIssue({
      owner: job.owner,
      repo: job.repo,
      issue_number: job.issueNumber,
    });
    const present = data.map((l) => l.name);
    for (const l of STATUS_LABELS) {
      if (l !== target && present.includes(l)) {
        await octokit.rest.issues
          .removeLabel({ owner: job.owner, repo: job.repo, issue_number: job.issueNumber, name: l })
          .catch(() => undefined);
      }
    }
    if (!present.includes(target)) {
      await octokit.rest.issues.addLabels({
        owner: job.owner,
        repo: job.repo,
        issue_number: job.issueNumber,
        labels: [target],
      });
    }
  } catch (err) {
    logger.debug({ jobId: job.id, err: (err as Error).message }, "status label sync failed (non-fatal)");
  }
}

/**
 * Update the live status panel on the issue AND the PR, plus the issue status label.
 * `detail` is an optional current-activity note (e.g. "step 3/6 — add API client").
 * Best-effort: never throws.
 */
export async function reportProgress(
  octokit: InstallationOctokit,
  jobId: number,
  detail?: string,
): Promise<void> {
  const job = getJobById(jobId);
  if (!job) return;
  const body = buildBody(job, detail);

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

    await syncStatusLabel(octokit, getJobById(jobId) ?? job);
  } catch (err) {
    logger.warn({ jobId, err: (err as Error).message }, "progress update failed (non-fatal)");
  }
}
