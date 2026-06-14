import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { run } from "./exec.js";

export function repoDir(owner: string, repo: string): string {
  return join(config.agent.workdir, `${owner}__${repo}`);
}

function authUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

function publicUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Clone (first time) or fetch (subsequently) the repo into the workdir.
 * The auth token is never persisted to .git/config: clone scrubs the remote,
 * fetch/push pass the authenticated URL transiently.
 */
export async function ensureRepo(owner: string, repo: string, token: string): Promise<string> {
  const dir = repoDir(owner, repo);
  mkdirSync(config.agent.workdir, { recursive: true });

  if (!existsSync(join(dir, ".git"))) {
    await run("git", ["clone", "--no-tags", authUrl(owner, repo, token), dir]);
    await run("git", ["-C", dir, "remote", "set-url", "origin", publicUrl(owner, repo)]);
  } else {
    await run("git", [
      "-C",
      dir,
      "fetch",
      "--prune",
      authUrl(owner, repo, token),
      "+refs/heads/*:refs/remotes/origin/*",
    ]);
  }

  await run("git", ["-C", dir, "config", "user.name", config.agent.gitAuthorName]);
  await run("git", ["-C", dir, "config", "user.email", config.agent.gitAuthorEmail]);
  return dir;
}

/**
 * Check out the work branch. If a remote branch already exists (resuming a job),
 * continue from it; otherwise branch from the base.
 */
export async function checkoutWorkBranch(dir: string, branch: string, base: string): Promise<void> {
  const hasRemoteBranch = await run("git", ["-C", dir, "rev-parse", "--verify", `origin/${branch}`], {
    allowFailure: true,
  });
  const startPoint = hasRemoteBranch.exitCode === 0 ? `origin/${branch}` : `origin/${base}`;
  await run("git", ["-C", dir, "checkout", "-B", branch, startPoint]);
}

/** Stage everything and commit. Returns the new HEAD SHA, or null if nothing changed. */
export async function commitAll(dir: string, message: string): Promise<string | null> {
  await run("git", ["-C", dir, "add", "-A"]);
  const status = await run("git", ["-C", dir, "status", "--porcelain"]);
  if (!status.stdout.trim()) return null;
  await run("git", ["-C", dir, "commit", "-m", message]);
  return currentSha(dir);
}

export async function currentSha(dir: string): Promise<string> {
  const res = await run("git", ["-C", dir, "rev-parse", "HEAD"]);
  return res.stdout.trim();
}

/**
 * Discard all uncommitted changes (tracked edits + untracked files) to return the
 * working tree to a clean HEAD. Used to drop a partially-applied step before a
 * retry or skip so it can't leak into a later step's commit.
 */
export async function discardChanges(dir: string): Promise<void> {
  await run("git", ["-C", dir, "reset", "--hard", "HEAD"]);
  await run("git", ["-C", dir, "clean", "-fd"]);
}

export async function pushBranch(
  dir: string,
  branch: string,
  owner: string,
  repo: string,
  token: string,
): Promise<void> {
  // Plain --force (not --force-with-lease): we push to an explicit authenticated
  // URL which has no remote-tracking ref to lease against, and the agent owns these
  // feature/issue-* branches exclusively. We always rebuild from origin/<branch>
  // before committing, so this is effectively a fast-forward.
  await run("git", [
    "-C",
    dir,
    "push",
    "--force",
    authUrl(owner, repo, token),
    `${branch}:${branch}`,
  ]);
}

/** All tracked files (repo-relative POSIX paths). */
export async function listTrackedFiles(dir: string): Promise<string[]> {
  const res = await run("git", ["-C", dir, "ls-files"]);
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Files changed on the work branch relative to base (committed changes). */
export async function changedFilesVsBase(dir: string, base: string): Promise<string[]> {
  const res = await run(
    "git",
    ["-C", dir, "diff", "--name-only", `origin/${base}...HEAD`],
    { allowFailure: true },
  );
  return res.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** A compact newline-delimited file listing used as model context. */
export async function fileTree(dir: string, limit = 600): Promise<string> {
  const files = await listTrackedFiles(dir);
  if (files.length <= limit) return files.join("\n");
  return `${files.slice(0, limit).join("\n")}\n...[${files.length - limit} more files]`;
}
