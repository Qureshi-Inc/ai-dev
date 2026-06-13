import type { InstallationOctokit } from "./app.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export async function getDefaultBranch(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner, repo });
  return data.default_branch;
}

export async function getIssue(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<{ title: string; body: string; labels: string[] }> {
  const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const labels = (data.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
  return { title: data.title, body: data.body ?? "", labels };
}

export async function findOpenPrForBranch(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<number | null> {
  const { data } = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branch}`,
    state: "open",
    per_page: 1,
  });
  return data[0]?.number ?? null;
}

/** Create the PR if none exists for the branch, otherwise return the existing PR number. */
export async function openOrUpdatePr(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  params: { branch: string; base: string; title: string; body: string; existingPr?: number | null },
): Promise<number> {
  const existing =
    params.existingPr ?? (await findOpenPrForBranch(octokit, owner, repo, params.branch));
  if (existing) {
    await octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: existing,
      title: params.title,
      body: params.body,
    });
    logger.info({ owner, repo, pr: existing }, "updated existing PR");
    return existing;
  }
  const { data } = await octokit.rest.pulls.create({
    owner,
    repo,
    head: params.branch,
    base: params.base,
    title: params.title,
    body: params.body,
  });
  logger.info({ owner, repo, pr: data.number }, "opened PR");
  return data.number;
}

export async function comment(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  issueOrPrNumber: number,
  body: string,
): Promise<void> {
  await octokit.rest.issues.createComment({ owner, repo, issue_number: issueOrPrNumber, body });
}

export interface MergeResult {
  merged: boolean;
  reason?: string;
}

/** Merge a PR using the configured method. Returns merged=false with a reason on failure. */
export async function mergePr(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<MergeResult> {
  try {
    const { data } = await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: config.agent.mergeMethod,
    });
    return { merged: data.merged };
  } catch (err) {
    const e = err as { status?: number; message?: string };
    logger.warn({ owner, repo, pr: prNumber, status: e.status, message: e.message }, "merge failed");
    return { merged: false, reason: e.message ?? "merge failed" };
  }
}
