import { db } from "./db.js";
import { JobState, type IssueJob, type IssueSpec } from "../types.js";

interface JobRow {
  id: number;
  owner: string;
  repo: string;
  issue_number: number;
  title: string;
  branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  state: string;
  retry_count: number;
  last_error: string | null;
  spec: string | null;
  plan: string | null;
  progress_comment_id: number | null;
  progress_pr_comment_id: number | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: JobRow): IssueJob {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    branch: row.branch,
    prNumber: row.pr_number,
    headSha: row.head_sha,
    state: row.state as JobState,
    retryCount: row.retry_count,
    lastError: row.last_error,
    spec: row.spec,
    plan: row.plan,
    progressCommentId: row.progress_comment_id,
    progressPrCommentId: row.progress_pr_comment_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Create a job for an issue, or return the existing one. The UNIQUE(owner,repo,issue_number)
 * constraint enforces the "one active branch per issue" guardrail at the storage layer.
 */
export function getOrCreateJob(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
}): { job: IssueJob; created: boolean } {
  const existing = getJobByIssue(params.owner, params.repo, params.issueNumber);
  if (existing) return { job: existing, created: false };

  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO issue_jobs (owner, repo, issue_number, title, state, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(params.owner, params.repo, params.issueNumber, params.title, JobState.QUEUED, ts, ts);

  const job = getJobById(Number(info.lastInsertRowid));
  if (!job) throw new Error("failed to create issue job");
  return { job, created: true };
}

export function getJobById(id: number): IssueJob | null {
  const row = db.prepare(`SELECT * FROM issue_jobs WHERE id = ?`).get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getJobByIssue(owner: string, repo: string, issueNumber: number): IssueJob | null {
  const row = db
    .prepare(`SELECT * FROM issue_jobs WHERE owner = ? AND repo = ? AND issue_number = ?`)
    .get(owner, repo, issueNumber) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getJobByPr(owner: string, repo: string, prNumber: number): IssueJob | null {
  const row = db
    .prepare(`SELECT * FROM issue_jobs WHERE owner = ? AND repo = ? AND pr_number = ?`)
    .get(owner, repo, prNumber) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getJobByBranch(owner: string, repo: string, branch: string): IssueJob | null {
  const row = db
    .prepare(`SELECT * FROM issue_jobs WHERE owner = ? AND repo = ? AND branch = ?`)
    .get(owner, repo, branch) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

type JobPatch = Partial<{
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  state: JobState;
  retryCount: number;
  lastError: string | null;
  title: string;
  progressCommentId: number | null;
  progressPrCommentId: number | null;
}>;

const COLUMN_MAP: Record<keyof JobPatch, string> = {
  branch: "branch",
  prNumber: "pr_number",
  headSha: "head_sha",
  state: "state",
  retryCount: "retry_count",
  lastError: "last_error",
  title: "title",
  progressCommentId: "progress_comment_id",
  progressPrCommentId: "progress_pr_comment_id",
};

export function updateJob(id: number, patch: JobPatch): IssueJob {
  const keys = Object.keys(patch) as (keyof JobPatch)[];
  if (keys.length > 0) {
    const sets = keys.map((k) => `${COLUMN_MAP[k]} = ?`);
    const values = keys.map((k) => patch[k] as unknown);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    db.prepare(`UPDATE issue_jobs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  const job = getJobById(id);
  if (!job) throw new Error(`job ${id} not found after update`);
  return job;
}

export function setState(id: number, state: JobState): IssueJob {
  return updateJob(id, { state });
}

/** Atomically bump the retry counter and return the new value. */
export function incrementRetry(id: number): number {
  db.prepare(`UPDATE issue_jobs SET retry_count = retry_count + 1, updated_at = ? WHERE id = ?`).run(
    now(),
    id,
  );
  return getJobById(id)?.retryCount ?? 0;
}

export function saveSpec(id: number, spec: IssueSpec): void {
  db.prepare(`UPDATE issue_jobs SET spec = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(spec),
    now(),
    id,
  );
}

export function savePlan(id: number, steps: string[]): void {
  db.prepare(`UPDATE issue_jobs SET plan = ?, updated_at = ? WHERE id = ?`).run(
    JSON.stringify(steps),
    now(),
    id,
  );
}

export function parseSpec(job: IssueJob): IssueSpec | null {
  if (!job.spec) return null;
  try {
    return JSON.parse(job.spec) as IssueSpec;
  } catch {
    return null;
  }
}

export function parsePlan(job: IssueJob): string[] {
  if (!job.plan) return [];
  try {
    return JSON.parse(job.plan) as string[];
  } catch {
    return [];
  }
}

export function listActiveJobs(): IssueJob[] {
  const rows = db
    .prepare(
      `SELECT * FROM issue_jobs WHERE state NOT IN (?, ?, ?) ORDER BY updated_at ASC`,
    )
    .all(JobState.MERGED, JobState.DEPLOYED, JobState.FAILED) as JobRow[];
  return rows.map(rowToJob);
}
