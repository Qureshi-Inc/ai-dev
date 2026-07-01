// ---------------------------------------------------------------------------
// Worktree Manager — isolated git worktrees for each task run
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { run } from "../utils/exec.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseSha: string;
}

export class WorktreeManager {
  private log = logger.child({ component: "WorktreeManager" });

  constructor(
    private repoDir: string,
    private worktreeBaseDir: string,
  ) {
    mkdirSync(this.worktreeBaseDir, { recursive: true });
  }

  /**
   * Create a fresh worktree from the latest base branch.
   * Always deletes any stale local branch first to ensure a clean start.
   */
  async create(
    taskRunId: number,
    taskId: number,
    baseBranch: string,
    token: string,
    owner?: string,
    repo?: string,
  ): Promise<WorktreeInfo> {
    const branch = this.branchName(taskId, taskRunId);
    const wtPath = join(this.worktreeBaseDir, `run-${taskRunId}`);

    // Resolve actual repo directory (workdir contains owner__repo subdirs)
    const actualRepoDir = (owner && repo)
      ? join(this.repoDir, `${owner}__${repo}`)
      : this.repoDir;

    this.log.info({ taskRunId, branch, wtPath }, "creating worktree");

    // Ensure repo is cloned
    const { ensureRepo } = await import("../utils/git.js");
    if (owner && repo) {
      await ensureRepo(owner, repo, token);
    }

    // Fetch latest from remote
    const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    await run("git", ["-C", actualRepoDir, "fetch", "--prune",
      remoteUrl,
      "+refs/heads/*:refs/remotes/origin/*",
    ], { allowFailure: true });

    // Prune stale worktree references
    await run("git", ["-C", actualRepoDir, "worktree", "prune"], { allowFailure: true });

    // Remove existing worktree directory if present
    if (existsSync(wtPath)) {
      await run("git", ["-C", actualRepoDir, "worktree", "remove", "--force", wtPath], {
        allowFailure: true,
      });
      if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
    }

    // Delete stale local branch
    await run("git", ["-C", actualRepoDir, "branch", "-D", branch], { allowFailure: true });

    // Create fresh worktree from base
    await run("git", ["-C", actualRepoDir, "worktree", "add", "-B", branch, wtPath, `origin/${baseBranch}`]);

    // Configure git author in worktree
    await run("git", ["-C", wtPath, "config", "user.name", config.agent.gitAuthorName]);
    await run("git", ["-C", wtPath, "config", "user.email", config.agent.gitAuthorEmail]);

    // Capture starting SHA
    const shaResult = await run("git", ["-C", wtPath, "rev-parse", "HEAD"]);
    const baseSha = shaResult.stdout.trim();

    this.log.info({ taskRunId, baseSha, branch }, "worktree created");

    return { path: wtPath, branch, baseSha };
  }

  /**
   * Get diff stats for the worktree relative to its starting point.
   */
  async getDiffStats(info: WorktreeInfo): Promise<{
    changedFiles: string[];
    additions: number;
    deletions: number;
    diffBytes: number;
  }> {
    const nameOnly = await run(
      "git",
      ["-C", info.path, "diff", "--name-only", `${info.baseSha}...HEAD`],
      { allowFailure: true },
    );
    const changedFiles = nameOnly.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const stat = await run(
      "git",
      ["-C", info.path, "diff", "--stat", `${info.baseSha}...HEAD`],
      { allowFailure: true },
    );
    const summary = stat.stdout.split("\n").pop() ?? "";
    const addMatch = summary.match(/(\d+) insertion/);
    const delMatch = summary.match(/(\d+) deletion/);
    const additions = addMatch ? parseInt(addMatch[1], 10) : 0;
    const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;

    const diff = await run(
      "git",
      ["-C", info.path, "diff", `${info.baseSha}...HEAD`],
      { allowFailure: true },
    );
    const diffBytes = Buffer.byteLength(diff.stdout, "utf8");

    return { changedFiles, additions, deletions, diffBytes };
  }

  /**
   * Commit all changes in the worktree. Returns the commit SHA, or null if no changes.
   */
  async commit(info: WorktreeInfo, message: string): Promise<string | null> {
    await run("git", ["-C", info.path, "add", "-A"]);
    const status = await run("git", ["-C", info.path, "status", "--porcelain"]);
    if (!status.stdout.trim()) return null;

    await run("git", ["-C", info.path, "commit", "-m", message]);
    const sha = await run("git", ["-C", info.path, "rev-parse", "HEAD"]);
    return sha.stdout.trim();
  }

  /**
   * Push branch to remote.
   */
  async push(info: WorktreeInfo, owner: string, repo: string, token: string): Promise<void> {
    const authUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    await run("git", ["-C", info.path, "push", "--force", authUrl, `${info.branch}:${info.branch}`]);
    this.log.info({ branch: info.branch }, "branch pushed");
  }

  /**
   * Clean up worktree. If preserveOnFailure is true, the worktree directory is kept.
   */
  async cleanup(info: WorktreeInfo, preserveOnFailure: boolean): Promise<void> {
    if (preserveOnFailure) {
      this.log.info({ path: info.path }, "preserving worktree (failure mode)");
      return;
    }

    if (!existsSync(info.path)) return;

    await run("git", ["-C", this.repoDir, "worktree", "remove", "--force", info.path], {
      allowFailure: true,
    });
    if (existsSync(info.path)) {
      rmSync(info.path, { recursive: true, force: true });
    }

    // Also delete the local branch
    await run("git", ["-C", this.repoDir, "branch", "-D", info.branch], { allowFailure: true });

    this.log.info({ path: info.path }, "worktree cleaned up");
  }

  /**
   * Detect and prune stale/orphaned worktrees. Returns count pruned.
   */
  async pruneStale(): Promise<number> {
    // First, let git prune references to missing worktrees
    await run("git", ["-C", this.repoDir, "worktree", "prune"], { allowFailure: true });

    // Then check our worktree base dir for orphaned directories
    let pruned = 0;
    if (!existsSync(this.worktreeBaseDir)) return 0;

    const entries = readdirSync(this.worktreeBaseDir);
    for (const entry of entries) {
      const fullPath = join(this.worktreeBaseDir, entry);
      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;

        // Check if the worktree's .git file points to a valid repo
        const gitCheck = await run("git", ["-C", fullPath, "status"], { allowFailure: true });
        if (gitCheck.exitCode !== 0) {
          this.log.info({ path: fullPath }, "pruning stale worktree");
          rmSync(fullPath, { recursive: true, force: true });
          pruned++;
        }
      } catch {
        // If stat fails, the entry was already removed
      }
    }

    if (pruned > 0) {
      this.log.info({ pruned }, "stale worktrees pruned");
    }

    return pruned;
  }

  private branchName(taskId: number, runId: number): string {
    return `agent/${taskId}-${runId}`;
  }

  /**
   * Build an authenticated remote URL from the repo's origin URL + token.
   */
  private async getAuthenticatedRemoteUrl(token: string): Promise<string> {
    const result = await run("git", ["-C", this.repoDir, "remote", "get-url", "origin"], {
      allowFailure: true,
    });
    const originUrl = result.stdout.trim();

    // Parse owner/repo from the origin URL
    // Handles: https://github.com/owner/repo.git or git@github.com:owner/repo.git
    const httpsMatch = originUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    const sshMatch = originUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
    const match = httpsMatch ?? sshMatch;

    if (match) {
      const [, owner, repo] = match;
      return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    }

    // Fallback: try to extract from repoDir name (owner__repo pattern)
    const dirName = basename(this.repoDir);
    const parts = dirName.split("__");
    if (parts.length === 2) {
      return `https://x-access-token:${token}@github.com/${parts[0]}/${parts[1]}.git`;
    }

    // Last resort: inject token into existing URL
    return originUrl.replace("https://", `https://x-access-token:${token}@`);
  }
}
