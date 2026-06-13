import { config } from "../config.js";
import {
  JobState,
  TERMINAL_STATES,
  type IssueJob,
  type IssueSpec,
} from "../types.js";
import {
  getJobById,
  getJobByBranch,
  getOrCreateJob,
  incrementRetry,
  listActiveJobs,
  parseSpec,
  parsePlan,
  saveSpec,
  savePlan,
  setState,
  updateJob,
} from "../storage/state.js";
import { octokitForRepo, type RepoClient } from "../github/app.js";
import {
  comment,
  getDefaultBranch,
  getIssue,
  getPrMergeable,
  mergePr,
  openOrUpdatePr,
} from "../github/repo.js";
import { buildCiOutcome, hasCiForSha } from "../github/ci.js";
import {
  changedFilesVsBase,
  checkoutWorkBranch,
  commitAll,
  currentSha,
  ensureRepo,
  pushBranch,
} from "../utils/git.js";
import { parseIssue } from "./parse.js";
import { planSpec } from "./plan.js";
import { implementChanges } from "./implement.js";
import { analyzeFailure } from "./debug.js";
import { triggerDeployHook } from "./deploy.js";
import { reportProgress } from "./progress.js";
import { queue } from "../queue/queue.js";
import { jobLogger, logger } from "../utils/logger.js";

/** Best-effort live status comment update; never throws. */
async function report(client: RepoClient | null, jobId: number): Promise<void> {
  if (client) await reportProgress(client.octokit, jobId);
}

function branchName(issueNumber: number): string {
  return `${config.agent.branchPrefix}${issueNumber}`;
}

function prBody(spec: IssueSpec, steps: string[], summary: string, issueNumber: number): string {
  return [
    `Automated changes by **ai-dev** for #${issueNumber}.`,
    "",
    `**Summary:** ${summary || spec.summary}`,
    "",
    "**Plan:**",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    `Closes #${issueNumber}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public entry points (called by webhooks + poller)
// ---------------------------------------------------------------------------

export function submitIssue(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
}): void {
  const { job, created } = getOrCreateJob(params);
  if (job.state === JobState.MERGED || job.state === JobState.DEPLOYED) {
    logger.info({ jobId: job.id, state: job.state }, "issue already completed; ignoring");
    return;
  }
  if (job.state === JobState.FAILED) {
    // Allow a manual retry by re-triggering (e.g. removing and re-adding the label).
    logger.info({ jobId: job.id }, "retriggering previously failed issue");
    updateJob(job.id, { lastError: null, retryCount: 0 });
    setState(job.id, JobState.QUEUED);
    queue.enqueue(`issue#${params.issueNumber}`, () => runIssue(job.id));
    return;
  }
  if (!created) {
    // Already tracked (e.g. opened + labeled both fired, or still running). The
    // existing enqueued run handles it; don't double-run.
    logger.info({ jobId: job.id, state: job.state }, "issue already tracked; ignoring duplicate trigger");
    return;
  }
  queue.enqueue(`issue#${params.issueNumber}`, () => runIssue(job.id));
}

/** On boot, re-enqueue any jobs that were mid-flight before a restart. */
export function resumeActiveJobs(): void {
  const jobs = listActiveJobs();
  for (const job of jobs) {
    if (job.state === JobState.CI_RUNNING) {
      queue.enqueue(`resume-ci#${job.id}`, () => processCiOutcome(job.id));
    } else {
      queue.enqueue(`resume#${job.id}`, () => runIssue(job.id));
    }
  }
  if (jobs.length > 0) logger.info({ count: jobs.length }, "resumed active jobs after restart");
}

export function handleWorkflowConclusion(ev: {
  owner: string;
  repo: string;
  headBranch: string;
  headSha: string;
  conclusion: string;
  runId: number;
}): void {
  const job = getJobByBranch(ev.owner, ev.repo, ev.headBranch);
  if (!job) return;
  if (job.state !== JobState.CI_RUNNING) {
    logger.debug({ jobId: job.id, state: job.state }, "workflow event ignored (not awaiting CI)");
    return;
  }
  logger.info(
    { jobId: job.id, runId: ev.runId, conclusion: ev.conclusion },
    "workflow completed -> evaluate",
  );
  queue.enqueue(`ci#${job.id}`, () => processCiOutcome(job.id));
}

/** Ask the orchestrator to (re-)evaluate CI for a job. Used by the poller. */
export function requestCiEvaluation(jobId: number): void {
  queue.enqueue(`ci#${jobId}`, () => processCiOutcome(jobId));
}

// ---------------------------------------------------------------------------
// Step 1: parse -> plan -> implement -> push -> PR -> CI_RUNNING
// ---------------------------------------------------------------------------

async function runIssue(jobId: number): Promise<void> {
  const job = getJobById(jobId);
  // Idempotency: never re-run a job that has already reached CI or finished
  // (guards against duplicate webhook triggers landing two runs in the queue).
  if (!job || TERMINAL_STATES.has(job.state) || job.state === JobState.CI_RUNNING) {
    if (job) logger.info({ jobId, state: job.state }, "runIssue skipped (already advanced)");
    return;
  }
  const log = jobLogger({ jobId, owner: job.owner, repo: job.repo, issue: job.issueNumber });

  let client: RepoClient | null = null;
  try {
    client = await octokitForRepo(job.owner, job.repo);
    const { octokit, token } = client;
    const base = await getDefaultBranch(octokit, job.owner, job.repo);
    const branch = branchName(job.issueNumber);
    updateJob(jobId, { branch });

    // Parse
    setState(jobId, JobState.PARSING);
    await report(client, jobId);
    const issue = await getIssue(octokit, job.owner, job.repo, job.issueNumber);
    const pro = issue.labels.includes(config.agent.proLabel);
    updateJob(jobId, { pro });
    if (pro) log.info({ proLabel: config.agent.proLabel }, "pro run: using MODEL_PRO for all tasks");
    const spec = await parseIssue(jobId, issue.title, issue.body, pro);
    saveSpec(jobId, spec);
    log.info({ requirements: spec.requirements.length }, "issue parsed -> spec");

    // Plan
    setState(jobId, JobState.PLANNING);
    await report(client, jobId);
    const steps = await planSpec(jobId, spec, pro);
    savePlan(jobId, steps);
    log.info({ steps: steps.length }, "plan generated");

    // Implement (initial attempt = 0)
    setState(jobId, JobState.IMPLEMENTING);
    await report(client, jobId);
    const dir = await ensureRepo(job.owner, job.repo, token);
    await checkoutWorkBranch(dir, branch, base);
    const { result } = await implementChanges({ jobId, dir, spec, steps, attempt: 0, pro });

    const sha = await commitAll(dir, result.commitMessage);
    if (!sha) {
      // The fresh implementation matched what's already on the branch. If a PR
      // already exists, resume the CI/fix loop against its head (this is how a
      // re-triggered issue with a red PR enters the debug->fix loop) instead of
      // dead-ending. Only fail if there's genuinely nothing pushed yet.
      if (job.prNumber) {
        const headSha = job.headSha ?? (await currentSha(dir));
        updateJob(jobId, { headSha });
        setState(jobId, JobState.CI_RUNNING);
        await report(client, jobId);
        log.info({ prNumber: job.prNumber, headSha }, "no new changes; resuming CI/fix loop on existing PR");
        queue.enqueue(`ci#${jobId}`, () => processCiOutcome(jobId));
        return;
      }
      await comment(
        octokit,
        job.owner,
        job.repo,
        job.issueNumber,
        "ai-dev: the model produced no file changes for this issue. Marking as failed.",
      );
      updateJob(jobId, { lastError: "no changes generated" });
      setState(jobId, JobState.FAILED);
      await report(client, jobId);
      return;
    }
    updateJob(jobId, { headSha: sha });

    // Push + PR
    await pushBranch(dir, branch, job.owner, job.repo, token);
    const prNumber = await openOrUpdatePr(octokit, job.owner, job.repo, {
      branch,
      base,
      title: `ai-dev: ${spec.title}`,
      body: prBody(spec, steps, result.summary, job.issueNumber),
    });
    updateJob(jobId, { prNumber });

    setState(jobId, JobState.CI_RUNNING);
    await report(client, jobId);
    log.info({ prNumber, sha }, "PR open; awaiting CI");
  } catch (err) {
    await failJob(client, jobId, err, "runIssue failed");
  }
}

// ---------------------------------------------------------------------------
// Step 2: evaluate CI; merge on green, or debug+fix+retry on red
// ---------------------------------------------------------------------------

async function processCiOutcome(jobId: number): Promise<void> {
  const job = getJobById(jobId);
  if (!job || job.state !== JobState.CI_RUNNING || !job.headSha) return;
  const log = jobLogger({ jobId, owner: job.owner, repo: job.repo, issue: job.issueNumber });

  let client: RepoClient | null = null;
  try {
    client = await octokitForRepo(job.owner, job.repo);
    const { octokit, token } = client;

    const outcome = await buildCiOutcome(octokit, job.owner, job.repo, job.headSha);
    if (!outcome) {
      const ageMs = Date.now() - new Date(job.updatedAt).getTime();

      // After a grace period, decide whether CI will ever report for this commit.
      if (ageMs > config.ci.graceMs) {
        const ci = await hasCiForSha(octokit, job.owner, job.repo, job.headSha);
        if (!ci) {
          // No workflow runs and no check-runs for this commit -> the repo has no CI
          // that runs on it. Apply the no-CI policy.
          if (config.ci.mergeWithoutCi && config.agent.autoMerge && job.prNumber) {
            const m = await getPrMergeable(octokit, job.owner, job.repo, job.prNumber);
            const netDeletions = m.deletions - m.additions;
            const limit = config.agent.autoMergeMaxNetDeletions;
            if (m.mergeable && limit > 0 && netDeletions > limit) {
              // Destructive change with no CI to vet it -> require a human.
              log.warn(
                { prNumber: job.prNumber, additions: m.additions, deletions: m.deletions },
                "no CI + large net deletion -> not auto-merging; flagging for review",
              );
              await comment(
                octokit,
                job.owner,
                job.repo,
                job.prNumber,
                `ai-dev: this PR has no CI and is a large net deletion (+${m.additions} / -${m.deletions}). Not auto-merging — please review and merge manually if intended.`,
              );
              setState(jobId, JobState.PR_OPEN);
              await report(client, jobId);
              return;
            }
            if (m.mergeable) {
              log.info({ prNumber: job.prNumber, state: m.state }, "no CI for commit; PR mergeable -> auto-merging");
              await onCiGreen(client, job);
              return;
            }
            await comment(
              octokit,
              job.owner,
              job.repo,
              job.prNumber,
              `ai-dev: no CI runs for this commit and GitHub reports the PR not mergeable (state: ${m.state}). Stopping.`,
            );
            updateJob(jobId, { lastError: `no CI; PR not mergeable: ${m.state}` });
            setState(jobId, JobState.FAILED);
            await report(client, jobId);
            return;
          }
          // Policy off (or auto-merge disabled): don't sit until timeout — surface it.
          await comment(
            octokit,
            job.owner,
            job.repo,
            job.prNumber ?? job.issueNumber,
            "ai-dev: no CI is configured to run on this commit. Add a CI workflow or merge manually.",
          );
          setState(jobId, job.prNumber ? JobState.PR_OPEN : JobState.FAILED);
          await report(client, jobId);
          return;
        }
        // CI exists but hasn't completed yet -> fall through to the wait/timeout check.
      }

      if (ageMs > config.ci.waitTimeoutMs) {
        log.warn({ ageMs }, "CI wait timeout exceeded");
        await comment(
          octokit,
          job.owner,
          job.repo,
          job.prNumber ?? job.issueNumber,
          "ai-dev: timed out waiting for CI to complete. Stopping.",
        );
        updateJob(jobId, { lastError: "CI wait timeout exceeded" });
        setState(jobId, JobState.FAILED);
        await report(client, jobId);
        return;
      }

      log.info("CI still in progress; will re-check on next event");
      return;
    }
    log.info({ conclusion: outcome.conclusion, runId: outcome.runId }, "CI outcome");

    if (outcome.conclusion === "success") {
      await onCiGreen(client, job);
      return;
    }

    // CI failed -> debug + fix + retry (guardrail: MAX_RETRIES)
    if (job.retryCount >= config.agent.maxRetries) {
      await comment(
        octokit,
        job.owner,
        job.repo,
        job.prNumber ?? job.issueNumber,
        `ai-dev: CI still failing after ${job.retryCount} fix attempts (max ${config.agent.maxRetries}). Stopping.`,
      );
      updateJob(jobId, { lastError: "max retries reached with failing CI" });
      setState(jobId, JobState.FAILED);
      await report(client, jobId);
      return;
    }

    await fixAndRetry(client, job, outcome.logsExcerpt);
  } catch (err) {
    await failJob(client, jobId, err, "processCiOutcome failed");
  }
}

async function onCiGreen(client: RepoClient, job: IssueJob): Promise<void> {
  const { octokit } = client;
  const log = jobLogger({ jobId: job.id, owner: job.owner, repo: job.repo });

  if (!config.agent.autoMerge) {
    await comment(
      octokit,
      job.owner,
      job.repo,
      job.prNumber ?? job.issueNumber,
      "ai-dev: CI is green. Auto-merge is disabled; please merge manually.",
    );
    setState(job.id, JobState.PR_OPEN);
    await report(client, job.id);
    log.info("CI green; auto-merge disabled");
    return;
  }

  if (!job.prNumber) {
    updateJob(job.id, { lastError: "no PR number to merge" });
    setState(job.id, JobState.FAILED);
    await report(client, job.id);
    return;
  }

  const merge = await mergePr(octokit, job.owner, job.repo, job.prNumber);
  if (!merge.merged) {
    await comment(
      octokit,
      job.owner,
      job.repo,
      job.prNumber,
      `ai-dev: CI green but merge failed: ${merge.reason ?? "unknown"}.`,
    );
    updateJob(job.id, { lastError: `merge failed: ${merge.reason ?? "unknown"}` });
    setState(job.id, JobState.FAILED);
    await report(client, job.id);
    return;
  }

  setState(job.id, JobState.MERGED);
  await comment(octokit, job.owner, job.repo, job.prNumber, "ai-dev: CI green; PR merged. 🎉");
  await report(client, job.id);
  log.info({ prNumber: job.prNumber }, "PR merged");

  const deployed = await triggerDeployHook({
    owner: job.owner,
    repo: job.repo,
    prNumber: job.prNumber,
  });
  if (deployed) {
    setState(job.id, JobState.DEPLOYED);
    await report(client, job.id);
    await comment(octokit, job.owner, job.repo, job.prNumber, "ai-dev: deploy webhook triggered.");
  }
}

async function fixAndRetry(client: RepoClient, job: IssueJob, logsExcerpt: string): Promise<void> {
  const { octokit, token } = client;
  const log = jobLogger({ jobId: job.id, owner: job.owner, repo: job.repo });
  const spec = parseSpec(job);
  const steps = parsePlan(job);
  if (!spec) {
    updateJob(job.id, { lastError: "missing spec during fix" });
    setState(job.id, JobState.FAILED);
    await report(client, job.id);
    return;
  }

  setState(job.id, JobState.FIXING);
  await report(client, job.id);
  const base = await getDefaultBranch(octokit, job.owner, job.repo);
  const branch = job.branch ?? branchName(job.issueNumber);
  const dir = await ensureRepo(job.owner, job.repo, token);
  await checkoutWorkBranch(dir, branch, base);

  const changed = await changedFilesVsBase(dir, base);
  const analysis = await analyzeFailure({
    jobId: job.id,
    dir,
    spec,
    logsExcerpt,
    changedFiles: changed,
    pro: job.pro,
  });
  await comment(
    octokit,
    job.owner,
    job.repo,
    job.prNumber ?? job.issueNumber,
    `ai-dev (attempt ${job.retryCount + 1}/${config.agent.maxRetries}) root cause:\n\n${analysis.rootCause}`,
  );

  setState(job.id, JobState.IMPLEMENTING);
  const { result } = await implementChanges({
    jobId: job.id,
    dir,
    spec,
    steps,
    fixInstructions: analysis.fixInstructions,
    extraContextFiles: [...new Set([...analysis.suspectedFiles, ...changed])],
    // This fix is attempt (retryCount + 1); coding escalates to MODEL_PRO per the router.
    attempt: job.retryCount + 1,
    pro: job.pro,
  });

  const sha = await commitAll(dir, result.commitMessage || "ai-dev: apply CI fix");
  if (!sha) {
    await comment(
      octokit,
      job.owner,
      job.repo,
      job.prNumber ?? job.issueNumber,
      "ai-dev: fix step produced no changes; cannot make progress. Stopping.",
    );
    updateJob(job.id, { lastError: "fix produced no changes" });
    setState(job.id, JobState.FAILED);
    await report(client, job.id);
    return;
  }

  const retryCount = incrementRetry(job.id);
  updateJob(job.id, { headSha: sha });
  await pushBranch(dir, branch, job.owner, job.repo, token);
  setState(job.id, JobState.CI_RUNNING);
  await report(client, job.id);
  log.info({ retryCount, sha }, "fix pushed; awaiting CI");
}

async function failJob(
  client: RepoClient | null,
  jobId: number,
  err: unknown,
  context: string,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ jobId, err: message }, context);
  const job = getJobById(jobId);
  updateJob(jobId, { lastError: `${context}: ${message}`.slice(0, 1000) });
  setState(jobId, JobState.FAILED);
  await report(client, jobId);

  if (client && job) {
    try {
      await comment(
        client.octokit,
        job.owner,
        job.repo,
        job.prNumber ?? job.issueNumber,
        `ai-dev: aborting due to an internal error.\n\n\`${message}\``,
      );
    } catch {
      /* best-effort */
    }
  }
}
