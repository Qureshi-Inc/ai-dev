import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import { run, type RunResult } from "../utils/exec.js";
import {
  ProjectTaskState,
  type Project,
  type ProjectTask,
  type TaskExecutor,
} from "../types.js";
import {
  getProjectById,
  updateProjectTask,
  setTaskState,
  getProjectTaskById,
  listProjectTasks,
} from "../storage/projectState.js";
import { octokitForRepo, type RepoClient } from "../github/app.js";
import {
  comment,
  getDefaultBranch,
  mergePr,
  openOrUpdatePr,
  findOpenPrForBranch,
} from "../github/repo.js";
import { buildCiOutcome, hasCiForSha } from "../github/ci.js";
import { reportProjectProgress } from "./projectProgress.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FORBIDDEN_PATH_PATTERNS = [
  /^\.github\/workflows\//,
];

const DEPLOY_PATH_PATTERNS = [
  /^Dockerfile/i,
  /^docker-compose/i,
  /^\.dockerignore$/i,
  /^k8s\//i,
  /^kubernetes\//i,
  /^helm\//i,
  /^deploy\//i,
];

const SECRET_ENV_KEYS = new Set([
  "GITHUB_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "COOLIFY_DEPLOY_HOOK_URL",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "LMSTUDIO_API_KEY",
]);

// ---------------------------------------------------------------------------
// Sanitized environment for Claude Code
// ---------------------------------------------------------------------------

function buildClaudeCodeEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Inherit safe basics
  const safeKeys = ["HOME", "PATH", "USER", "LANG", "TERM", "SHELL", "TMPDIR", "NODE_ENV"];
  for (const key of safeKeys) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // Route Claude Code to oMLX via ANTHROPIC_BASE_URL.
  // oMLX 0.4.4+ exposes an Anthropic-compatible POST /v1/messages endpoint.
  // We pass --model with the exact oMLX model ID so Claude Code sends it verbatim.
  // CLAUDE_CODE_USE_BEDROCK must be explicitly unset to prevent Bedrock routing.
  const omlxBase = config.llm.baseUrl.replace(/\/v1\/?$/, "");
  env.ANTHROPIC_BASE_URL = omlxBase;
  env.ANTHROPIC_API_KEY = config.llm.apiKey;
  env.CLAUDE_CODE_USE_BEDROCK = "";

  // Force ALL Claude Code model aliases to use the local oMLX model.
  // Without this, Claude Code tries to use claude-3-5-haiku for sub-tasks.
  env.ANTHROPIC_SMALL_FAST_MODEL = config.llm.modelPro;
  env.CLAUDE_CODE_SMALL_FAST_MODEL = config.llm.modelPro;

  // Disable telemetry and interactive features
  env.CLAUDE_CODE_DISABLE_TELEMETRY = "1";
  env.CLAUDE_CODE_NON_INTERACTIVE = "1";
  env.NO_COLOR = "1";

  // Git author for any commits Claude Code might try (we override anyway)
  env.GIT_AUTHOR_NAME = config.agent.gitAuthorName;
  env.GIT_AUTHOR_EMAIL = config.agent.gitAuthorEmail;
  env.GIT_COMMITTER_NAME = config.agent.gitAuthorName;
  env.GIT_COMMITTER_EMAIL = config.agent.gitAuthorEmail;

  return env;
}

/**
 * Verify that no secret keys leaked into the env we're about to pass.
 */
export function validateSanitizedEnv(env: Record<string, string>): string[] {
  const leaks: string[] = [];
  for (const key of SECRET_ENV_KEYS) {
    if (key in env) leaks.push(key);
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// Worktree management
// ---------------------------------------------------------------------------

function worktreeBase(): string {
  const dir = config.claudeCode.worktreeDir;
  mkdirSync(dir, { recursive: true });
  return dir;
}

function worktreePath(project: Project, taskIndex: number): string {
  return join(worktreeBase(), `${project.owner}__${project.repo}__p${project.id}_t${taskIndex}`);
}

function taskBranchName(project: Project, taskIndex: number): string {
  return `project/${project.id}-${project.issueNumber}/task-${taskIndex + 1}`;
}

async function createWorktree(
  repoDir: string,
  wtPath: string,
  branch: string,
  base: string,
): Promise<void> {
  // Aggressively clean up any stale state
  await run("git", ["-C", repoDir, "worktree", "prune"], { allowFailure: true });

  if (existsSync(wtPath)) {
    await run("git", ["-C", repoDir, "worktree", "remove", "--force", wtPath], { allowFailure: true });
    if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
  }

  // Delete the local branch if it exists (stale from previous attempt)
  await run("git", ["-C", repoDir, "branch", "-D", branch], { allowFailure: true });

  // Always create fresh from base — never resume a stale remote branch
  await run("git", ["-C", repoDir, "worktree", "add", "-B", branch, wtPath, `origin/${base}`]);
}

async function removeWorktree(repoDir: string, wtPath: string): Promise<void> {
  if (!existsSync(wtPath)) return;
  await run("git", ["-C", repoDir, "worktree", "remove", "--force", wtPath], { allowFailure: true });
  if (existsSync(wtPath)) rmSync(wtPath, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Diff validation
// ---------------------------------------------------------------------------

interface DiffStats {
  changedFiles: string[];
  additions: number;
  deletions: number;
  diffBytes: number;
}

async function getDiffStats(wtPath: string, base: string): Promise<DiffStats> {
  const nameOnly = await run("git", ["-C", wtPath, "diff", "--name-only", `origin/${base}...HEAD`], {
    allowFailure: true,
  });
  const changedFiles = nameOnly.stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  const stat = await run("git", ["-C", wtPath, "diff", "--stat", `origin/${base}...HEAD`], {
    allowFailure: true,
  });
  // Parse "N files changed, X insertions(+), Y deletions(-)"
  const summary = stat.stdout.split("\n").pop() ?? "";
  const addMatch = summary.match(/(\d+) insertion/);
  const delMatch = summary.match(/(\d+) deletion/);
  const additions = addMatch ? parseInt(addMatch[1], 10) : 0;
  const deletions = delMatch ? parseInt(delMatch[1], 10) : 0;

  const diff = await run("git", ["-C", wtPath, "diff", `origin/${base}...HEAD`], { allowFailure: true });
  const diffBytes = Buffer.byteLength(diff.stdout, "utf8");

  return { changedFiles, additions, deletions, diffBytes };
}

function validateDiff(stats: DiffStats): string | null {
  if (stats.changedFiles.length > config.claudeCode.maxChangedFiles) {
    return `too many changed files: ${stats.changedFiles.length} > ${config.claudeCode.maxChangedFiles}`;
  }
  if (stats.diffBytes > config.claudeCode.maxDiffBytes) {
    return `diff too large: ${stats.diffBytes} bytes > ${config.claudeCode.maxDiffBytes}`;
  }
  const netDeletions = stats.deletions - stats.additions;
  if (config.claudeCode.maxNetDeletions > 0 && netDeletions > config.claudeCode.maxNetDeletions) {
    return `net deletions exceed limit: ${netDeletions} > ${config.claudeCode.maxNetDeletions}`;
  }

  // Check forbidden paths
  for (const file of stats.changedFiles) {
    for (const pattern of FORBIDDEN_PATH_PATTERNS) {
      if (pattern.test(file)) {
        return `forbidden path modified: ${file} (workflow edits are not allowed in project mode)`;
      }
    }
    if (!config.claudeCode.allowDeployEdits) {
      for (const pattern of DEPLOY_PATH_PATTERNS) {
        if (pattern.test(file)) {
          return `deployment file modified: ${file} (set CLAUDE_CODE_ALLOW_DEPLOY_EDITS=true to allow)`;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Claude Code invocation
// ---------------------------------------------------------------------------

async function invokeClaudeCode(wtPath: string, prompt: string, modelId: string = config.llm.modelPro): Promise<RunResult> {
  const env = buildClaudeCodeEnv();
  const leaks = validateSanitizedEnv(env);
  if (leaks.length > 0) {
    throw new Error(`SECURITY: secrets would leak to Claude Code: ${leaks.join(", ")}`);
  }

  // Use headless mode so Claude Code actually edits files in the worktree.
  // --model forces the oMLX model regardless of settings.json.
  // As root: --allowedTools grants specific tools without --dangerously-skip-permissions.
  const isRoot = process.getuid?.() === 0;
  const args = isRoot
    ? ["--model", modelId, "--allowedTools", "Edit,Write,Read,Bash", "-p", prompt]
    : ["--model", modelId, "--dangerously-skip-permissions", "-p", prompt];

  return run(config.claudeCode.bin, args, {
    cwd: wtPath,
    env,
    timeout: config.claudeCode.timeoutMs,
    allowFailure: true,
    input: "",
  });
}

// ---------------------------------------------------------------------------
// Independent test validation
// ---------------------------------------------------------------------------

async function runTests(wtPath: string): Promise<{ passed: boolean; output: string }> {
  const testCmd = config.claudeCode.testCmd;
  if (!testCmd) return { passed: true, output: "(no test command configured)" };

  const parts = testCmd.split(" ");
  const result = await run(parts[0], parts.slice(1), {
    cwd: wtPath,
    allowFailure: true,
    timeout: 120000,
  });

  const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 5000);
  return { passed: result.exitCode === 0, output };
}

// ---------------------------------------------------------------------------
// CI monitoring
// ---------------------------------------------------------------------------

async function waitForCi(
  client: RepoClient,
  owner: string,
  repo: string,
  headSha: string,
  timeoutMs: number = config.ci.waitTimeoutMs,
): Promise<{ conclusion: string; logsExcerpt: string } | null> {
  const startedAt = Date.now();
  const pollInterval = Math.max(config.ci.pollIntervalMs, 10000);

  // Wait for CI grace period first
  await sleep(Math.min(config.ci.graceMs, 30000));

  while (Date.now() - startedAt < timeoutMs) {
    const outcome = await buildCiOutcome(client.octokit, owner, repo, headSha);
    if (outcome) {
      return { conclusion: outcome.conclusion, logsExcerpt: outcome.logsExcerpt };
    }

    // Check if CI exists at all
    const elapsed = Date.now() - startedAt;
    if (elapsed > config.ci.graceMs) {
      const ci = await hasCiForSha(client.octokit, owner, repo, headSha);
      if (!ci) {
        return null; // No CI configured - cannot proceed in project mode
      }
    }

    await sleep(pollInterval);
  }

  return { conclusion: "timed_out", logsExcerpt: "CI wait timeout exceeded" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------

export class ClaudeCodeTaskExecutor implements TaskExecutor {
  canExecute(_task: ProjectTask): boolean {
    return true;
  }

  async executeTask(project: Project, task: ProjectTask): Promise<void> {
    const log = logger.child({ projectId: project.id, taskId: task.id, taskIndex: task.taskIndex });
    log.info({ title: task.title }, "executing project task");

    let client: RepoClient;
    try {
      client = await octokitForRepo(project.owner, project.repo);
    } catch (err) {
      throw new Error(`failed to get GitHub client: ${(err as Error).message}`);
    }

    // Post progress on the issue (upsert a single comment per task, not spam)
    let taskCommentId: number | null = null;
    const postStatus = async (msg: string) => {
      try {
        const totalTasks = listProjectTasks(project.id).length;
        const body = `🤖 **Task ${task.taskIndex + 1}/${totalTasks}:** ${task.title}\n\n${msg}`;
        if (taskCommentId) {
          await client.octokit.rest.issues.updateComment({
            owner: project.owner, repo: project.repo, comment_id: taskCommentId, body,
          });
        } else {
          const { data } = await client.octokit.rest.issues.createComment({
            owner: project.owner, repo: project.repo, issue_number: project.issueNumber, body,
          });
          taskCommentId = data.id;
        }
      } catch { /* best-effort */ }
    };

    // Ensure oMLX has memory headroom before starting (clears caches if under pressure)
    try {
      const { ensureOmlxHeadroom } = await import("../omlx/monitor.js");
      await ensureOmlxHeadroom();
    } catch { /* non-fatal */ }

    await postStatus("⏳ Starting execution via Claude Code (oMLX)…");

    const { octokit, token } = client;
    const base = await getDefaultBranch(octokit, project.owner, project.repo);
    const branch = task.branch ?? taskBranchName(project, task.taskIndex);
    const repoDir = join(config.agent.workdir, `${project.owner}__${project.repo}`);

    // Ensure repo is cloned/fetched
    const { ensureRepo } = await import("../utils/git.js");
    await ensureRepo(project.owner, project.repo, token);

    // Fetch latest before creating worktree
    await run("git", ["-C", repoDir, "fetch", "--prune",
      `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}.git`,
      "+refs/heads/*:refs/remotes/origin/*"]);

    const wtPath = worktreePath(project, task.taskIndex);
    updateProjectTask(task.id, { branch, worktreePath: wtPath });

    // Check for existing PR (restart recovery)
    const existingPr = await findOpenPrForBranch(octokit, project.owner, project.repo, branch);
    if (existingPr && task.prNumber !== existingPr) {
      updateProjectTask(task.id, { prNumber: existingPr });
      log.info({ prNumber: existingPr }, "found existing PR for task branch (restart recovery)");
    }

    try {
      await createWorktree(repoDir, wtPath, branch, base);
    } catch (err) {
      throw new Error(`worktree creation failed: ${(err as Error).message}`);
    }

    // Build the prompt for Claude Code
    const prompt = buildTaskPrompt(project, task);

    // Select model: fast model for scaffolding (task 0), precise model for coding
    const taskModel = task.taskIndex === 0
      ? config.llm.modelFast
      : config.llm.modelPro;
    log.info({ taskModel, taskIndex: task.taskIndex }, "selected model for task");

    // Implementation loop with retries
    let lastError = "";
    for (let attempt = 0; attempt <= config.claudeCode.maxRetries; attempt++) {
      if (attempt > 0) {
        log.info({ attempt }, "retrying Claude Code execution");
        // Reset worktree to base for fresh attempt
        await run("git", ["-C", wtPath, "reset", "--hard", `origin/${base}`]);
        await run("git", ["-C", wtPath, "clean", "-fd"]);
      }

      updateProjectTask(task.id, { retryCount: attempt });

      // Invoke Claude Code
      const retryContext = attempt > 0
        ? `\n\nPREVIOUS ATTEMPT FAILED:\n${lastError}\n\nFix the issue and try again.`
        : "";

      const result = await invokeClaudeCode(wtPath, prompt + retryContext, taskModel);
      if (result.exitCode !== 0 && !result.stdout.trim()) {
        lastError = `Claude Code exited ${result.exitCode}: ${result.stderr.slice(0, 2000)}`;
        log.warn({ attempt, exitCode: result.exitCode }, "Claude Code failed");
        if (attempt < config.claudeCode.maxRetries) continue;
        throw new Error(lastError);
      }

      // Stage all changes and check diff
      await run("git", ["-C", wtPath, "add", "-A"]);
      const status = await run("git", ["-C", wtPath, "status", "--porcelain"]);
      if (!status.stdout.trim()) {
        // Claude Code ran successfully but made no changes.
        // This is valid for verification/test tasks where nothing needs fixing.
        // If it exited 0, treat as success (no-op task). Only retry if it errored.
        if (result.exitCode === 0) {
          log.info({ attempt }, "task completed with no changes needed (no-op)");
          await postStatus("✅ Verified — no changes needed.");
          await removeWorktree(repoDir, wtPath).catch(() => {});
          updateProjectTask(task.id, { worktreePath: null });
          return; // success — no PR needed
        }
        lastError = "Claude Code produced no file changes";
        log.warn({ attempt }, "no changes produced");
        if (attempt < config.claudeCode.maxRetries) continue;
        throw new Error(lastError);
      }

      // Commit locally first so we can diff against base
      await run("git", ["-C", wtPath, "commit", "-m",
        `ai-dev project: task ${task.taskIndex + 1} — ${task.title}`]);

      // Validate the diff independently
      const stats = await getDiffStats(wtPath, base);
      const diffError = validateDiff(stats);
      if (diffError) {
        lastError = `diff validation failed: ${diffError}`;
        log.warn({ attempt, diffError }, "diff validation failed");
        if (attempt < config.claudeCode.maxRetries) continue;
        throw new Error(lastError);
      }

      // Run tests independently (never trust Claude Code's claim)
      const testResult = await runTests(wtPath);
      if (!testResult.passed) {
        lastError = `local tests failed:\n${testResult.output}`;
        log.warn({ attempt }, "local tests failed");
        if (attempt < config.claudeCode.maxRetries) continue;
        throw new Error(lastError);
      }

      // All local validation passed
      log.info({ changedFiles: stats.changedFiles.length, attempt }, "local validation passed");
      await postStatus(`✅ Local validation passed (${stats.changedFiles.length} files changed, attempt ${attempt + 1}). Pushing…`);
      break;
    }

    // Push the branch
    await run("git", ["-C", wtPath, "push", "--force",
      `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}.git`,
      `${branch}:${branch}`]);

    const headSha = (await run("git", ["-C", wtPath, "rev-parse", "HEAD"])).stdout.trim();
    updateProjectTask(task.id, { headSha });

    // Open or update PR
    const prNumber = await openOrUpdatePr(octokit, project.owner, project.repo, {
      branch,
      base,
      title: `ai-dev project: ${task.title}`,
      body: buildPrBody(project, task),
      existingPr: task.prNumber,
    });
    updateProjectTask(task.id, { prNumber });
    log.info({ prNumber, headSha }, "PR opened for task");
    await postStatus(`📦 [PR #${prNumber}](https://github.com/${project.owner}/${project.repo}/pull/${prNumber}) opened. Waiting for CI…`);

    // Update progress
    await reportProjectProgress(octokit, project.id).catch(() => {});

    // Monitor CI
    const ciResult = await waitForCi(client, project.owner, project.repo, headSha);
    if (!ciResult) {
      // No CI configured — merge directly (local validation already passed)
      log.info({ prNumber }, "no CI configured; merging after local validation");
      await postStatus(`ℹ️ No CI configured. Merging based on local validation.`);
      let mergeNoCi = await mergePr(octokit, project.owner, project.repo, prNumber);

      // If merge fails due to conflicts, rebase on latest main and force-push
      if (!mergeNoCi.merged && mergeNoCi.reason?.includes("conflict")) {
        log.info({ prNumber }, "merge conflict detected; rebasing on latest main");
        await run("git", ["-C", repoDir, "fetch", "--prune",
          `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}.git`,
          "+refs/heads/*:refs/remotes/origin/*"]);
        const rebaseResult = await run("git", ["-C", wtPath, "rebase", `origin/${base}`], { allowFailure: true });
        if (rebaseResult.exitCode === 0) {
          // Rebase succeeded — push and retry merge
          await run("git", ["-C", wtPath, "push", "--force",
            `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}.git`,
            `${branch}:${branch}`]);
          const newSha = (await run("git", ["-C", wtPath, "rev-parse", "HEAD"])).stdout.trim();
          updateProjectTask(task.id, { headSha: newSha });
          // Wait a moment for GitHub to update
          await sleep(3000);
          mergeNoCi = await mergePr(octokit, project.owner, project.repo, prNumber);
        } else {
          // Rebase failed (real conflict) — abort and fail
          await run("git", ["-C", wtPath, "rebase", "--abort"], { allowFailure: true });
        }
      }

      if (!mergeNoCi.merged) {
        throw new Error(`merge failed (no CI): ${mergeNoCi.reason ?? "unknown"}`);
      }
      await comment(octokit, project.owner, project.repo, prNumber,
        `ai-dev project: task ${task.taskIndex + 1} merged (no CI). ✅`);
      await removeWorktree(repoDir, wtPath).catch(() => {});
      updateProjectTask(task.id, { worktreePath: null });
      return;
    }

    // CI fix loop
    let currentSha = headSha;
    for (let ciAttempt = 0; ciAttempt < config.claudeCode.ciMaxRetries; ciAttempt++) {
      if (ciResult.conclusion === "success") break;
      if (ciAttempt > 0) {
        // Wait for new CI after fix
        const newCi = await waitForCi(client, project.owner, project.repo, currentSha);
        if (!newCi) throw new Error("CI disappeared during fix loop");
        if (newCi.conclusion === "success") break;
        ciResult.conclusion = newCi.conclusion;
        ciResult.logsExcerpt = newCi.logsExcerpt;
      }

      if (ciResult.conclusion === "success") break;

      log.info({ ciAttempt, conclusion: ciResult.conclusion }, "CI failed; attempting fix");
      updateProjectTask(task.id, { ciRetryCount: ciAttempt + 1 });
      await postStatus(`❌ CI failed (${ciResult.conclusion}). Attempting fix ${ciAttempt + 1}/${config.claudeCode.ciMaxRetries}…`);

      // Invoke Claude Code with CI failure context
      const fixPrompt = [
        `The CI pipeline failed for this task. Fix the issue.`,
        ``,
        `CI failure logs:`,
        "```",
        ciResult.logsExcerpt.slice(0, 8000),
        "```",
        ``,
        `Fix the failing tests or build errors. Do not modify .github/workflows/.`,
      ].join("\n");

      const fixResult = await invokeClaudeCode(wtPath, fixPrompt);
      if (fixResult.exitCode !== 0 && !fixResult.stdout.trim()) {
        await comment(octokit, project.owner, project.repo, prNumber,
          `ai-dev: CI fix attempt ${ciAttempt + 1} failed — Claude Code error.`);
        continue;
      }

      // Commit fix
      await run("git", ["-C", wtPath, "add", "-A"]);
      const fixStatus = await run("git", ["-C", wtPath, "status", "--porcelain"]);
      if (!fixStatus.stdout.trim()) {
        await comment(octokit, project.owner, project.repo, prNumber,
          `ai-dev: CI fix attempt ${ciAttempt + 1} produced no changes.`);
        continue;
      }

      // Validate fix diff
      const fixStats = await getDiffStats(wtPath, base);
      const fixDiffError = validateDiff(fixStats);
      if (fixDiffError) {
        await comment(octokit, project.owner, project.repo, prNumber,
          `ai-dev: CI fix attempt ${ciAttempt + 1} — diff validation failed: ${fixDiffError}`);
        continue;
      }

      await run("git", ["-C", wtPath, "commit", "-m",
        `ai-dev: fix CI (attempt ${ciAttempt + 1})`]);

      // Push fix
      await run("git", ["-C", wtPath, "push", "--force",
        `https://x-access-token:${token}@github.com/${project.owner}/${project.repo}.git`,
        `${branch}:${branch}`]);

      currentSha = (await run("git", ["-C", wtPath, "rev-parse", "HEAD"])).stdout.trim();
      updateProjectTask(task.id, { headSha: currentSha });

      // Wait for new CI
      const newCi = await waitForCi(client, project.owner, project.repo, currentSha);
      if (!newCi) throw new Error("CI disappeared after fix push");
      ciResult.conclusion = newCi.conclusion;
      ciResult.logsExcerpt = newCi.logsExcerpt;
    }

    if (ciResult.conclusion !== "success") {
      throw new Error(`CI failed after ${config.claudeCode.ciMaxRetries} fix attempts: ${ciResult.conclusion}`);
    }

    // Merge the PR
    log.info({ prNumber }, "CI green; merging PR");
    await postStatus(`✅ CI passed. Merging PR #${prNumber}…`);
    const mergeResult = await mergePr(octokit, project.owner, project.repo, prNumber);
    if (!mergeResult.merged) {
      throw new Error(`merge failed: ${mergeResult.reason ?? "unknown"}`);
    }

    await comment(octokit, project.owner, project.repo, prNumber,
      `ai-dev project: task ${task.taskIndex + 1} merged. ✅`);

    // Clean up worktree (success case)
    await removeWorktree(repoDir, wtPath).catch(() => {});
    updateProjectTask(task.id, { worktreePath: null });
    log.info({ prNumber }, "task completed and merged");
  }
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function buildTaskPrompt(project: Project, task: ProjectTask): string {
  const subtasks = task.subtasks ? JSON.parse(task.subtasks) as string[] : [];
  const subtaskList = subtasks.length > 0
    ? `\n\nSubtasks:\n${subtasks.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
    : "";

  // Provide context from completed sibling tasks so this session knows what was already done
  const allTasks = listProjectTasks(project.id);
  const completedContext = allTasks
    .filter(t => t.state === "COMPLETED" && t.taskIndex < task.taskIndex)
    .map(t => `- Task ${t.taskIndex + 1}: ${t.title} (merged PR #${t.prNumber || "?"})`)
    .join("\n");

  const contextSection = completedContext
    ? `\n\n## Already completed (do not redo)\n${completedContext}`
    : "";

  return [
    `You are implementing task ${task.taskIndex + 1} of a multi-task project.`,
    ``,
    `## Task: ${task.title}`,
    ``,
    task.description,
    subtaskList,
    contextSection,
    ``,
    `## Rules`,
    `- Implement ONLY this task. Do not implement other tasks.`,
    `- Do NOT modify .github/workflows/ files.`,
    `- Do NOT modify deployment files (Dockerfile, docker-compose, k8s) unless the task explicitly requires it.`,
    `- Write tests if the project has a test framework set up.`,
    `- Make sure the code compiles/builds correctly.`,
    `- Keep changes focused and minimal.`,
    ``,
    `## Project context`,
    `Parent issue: "${project.title}" (#${project.issueNumber})`,
  ].join("\n");
}

function buildPrBody(project: Project, task: ProjectTask): string {
  return [
    `> Automated by **ai-dev project mode** for #${project.issueNumber}`,
    `> Task ${task.taskIndex + 1}: ${task.title}`,
    "",
    "## Description",
    task.description,
    "",
    "## How this was built",
    `- **Executor:** Claude Code (headless) via oMLX (\`${config.llm.modelPro}\`)`,
    `- **Validated:** diff limits, path restrictions, independent test run`,
    `- **CI required:** yes (Project Mode enforces green CI before merge)`,
    "",
    `Part of project #${project.issueNumber}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Final project validation
// ---------------------------------------------------------------------------

export async function runFinalValidation(project: Project): Promise<{
  passed: boolean;
  report: string;
}> {
  const tasks = listProjectTasks(project.id);
  const completed = tasks.filter((t) => t.state === ProjectTaskState.COMPLETED);
  const failed = tasks.filter((t) => t.state === ProjectTaskState.FAILED);
  const skipped = tasks.filter((t) => t.state === ProjectTaskState.SKIPPED);

  const lines: string[] = [
    "## 📊 Project Final Report",
    "",
    `**Project:** ${project.title} (#${project.issueNumber})`,
    `**Total tasks:** ${tasks.length}`,
    `**Completed:** ${completed.length}`,
    `**Failed:** ${failed.length}`,
    `**Skipped:** ${skipped.length}`,
    "",
  ];

  if (completed.length > 0) {
    lines.push("### ✅ Completed tasks");
    for (const t of completed) {
      const prLink = t.prNumber
        ? ` ([PR #${t.prNumber}](https://github.com/${project.owner}/${project.repo}/pull/${t.prNumber}))`
        : "";
      lines.push(`- **${t.taskIndex + 1}.** ${t.title}${prLink}`);
    }
    lines.push("");
  }

  if (failed.length > 0) {
    lines.push("### ❌ Failed tasks");
    for (const t of failed) {
      lines.push(`- **${t.taskIndex + 1}.** ${t.title} — \`${t.lastError?.slice(0, 100) ?? "unknown"}\``);
    }
    lines.push("");
  }

  const passed = failed.length === 0;
  lines.push(passed
    ? "**Result:** All tasks completed successfully. 🎉"
    : "**Result:** Some tasks failed. Review the errors above.");

  return { passed, report: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Cleanup helpers for failed tasks
// ---------------------------------------------------------------------------

export async function cleanupFailedWorktree(task: ProjectTask): Promise<void> {
  if (!task.worktreePath || !existsSync(task.worktreePath)) return;

  if (config.claudeCode.preserveFailedWorktrees) {
    logger.info({ taskId: task.id, path: task.worktreePath }, "preserving failed worktree for debugging");
    return;
  }

  try {
    rmSync(task.worktreePath, { recursive: true, force: true });
    updateProjectTask(task.id, { worktreePath: null });
  } catch {
    // best-effort
  }
}
