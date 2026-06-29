import { config, isRepoAllowed, isUserAllowed } from "../config.js";
import {
  ProjectState,
  ProjectTaskState,
  PROJECT_TERMINAL_STATES,
  type Project,
  type ProjectCommand,
  type TaskExecutor,
} from "../types.js";
import {
  getOrCreateProject,
  getProjectById,
  getProjectByIssue,
  setProjectState,
  updateProject,
  listActiveProjects,
  createProjectTask,
  listProjectTasks,
  setTaskState,
  getNextReadyTasks,
  isProjectComplete,
  isProjectSuccessful,
  getProjectTaskByIndex,
  updateProjectTask,
} from "../storage/projectState.js";
import { octokitForRepo, type RepoClient } from "../github/app.js";
import { comment, getIssue } from "../github/repo.js";
import { generateTaskPlan } from "./taskMaster.js";
import { reportProjectProgress } from "./projectProgress.js";
import {
  ClaudeCodeTaskExecutor,
  runFinalValidation,
  cleanupFailedWorktree,
} from "./claudeCodeExecutor.js";
import { queue } from "../queue/queue.js";
import { logger } from "../utils/logger.js";
import { broadcastEvent } from "../sse.js";

// ---------------------------------------------------------------------------
// Task executor (Claude Code by default when Project Mode is enabled)
// ---------------------------------------------------------------------------

let _executor: TaskExecutor | null = null;

export function registerTaskExecutor(executor: TaskExecutor): void {
  _executor = executor;
}

export function getTaskExecutor(): TaskExecutor {
  if (!_executor) {
    _executor = new ClaudeCodeTaskExecutor();
  }
  return _executor;
}

/**
 * Called from the dashboard API to trigger project advancement
 * (after approve/resume/retry). Enqueues the work in the queue.
 */
export function advanceProjectFromDashboard(projectId: number): void {
  queue.enqueue(`project-advance#${projectId}`, () => advanceProject(projectId));
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Called when the "ai-dev-project" label is detected on an issue.
 * Creates the project record, generates a plan, and posts the status comment.
 */
export function submitProject(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  actor: string;
}): void {
  if (!config.project.enabled) {
    logger.info("project mode disabled; ignoring ai-dev-project label");
    return;
  }

  const { project, created } = getOrCreateProject({
    owner: params.owner,
    repo: params.repo,
    issueNumber: params.issueNumber,
    title: params.title,
    createdBy: params.actor,
  });

  if (!created) {
    if (PROJECT_TERMINAL_STATES.has(project.state)) {
      logger.info({ projectId: project.id, state: project.state }, "project already terminal; ignoring");
      return;
    }
    logger.info({ projectId: project.id, state: project.state }, "project already tracked; ignoring duplicate");
    return;
  }

  logger.info({ projectId: project.id, issue: params.issueNumber }, "project created -> planning");
  queue.enqueue(`project-plan#${project.id}`, () => planProject(project.id));
}

/**
 * Handle a "/ai-dev <command>" comment on a project issue.
 */
export function handleProjectCommand(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  actor: string;
  command: ProjectCommand;
}): void {
  if (!config.project.enabled) return;

  if (!isUserAllowed(params.actor)) {
    logger.warn({ actor: params.actor }, "project command from untrusted user; ignoring");
    return;
  }

  const project = getProjectByIssue(params.owner, params.repo, params.issueNumber);
  if (!project) {
    logger.info(
      { owner: params.owner, repo: params.repo, issue: params.issueNumber },
      "no project for this issue; ignoring command",
    );
    return;
  }

  const cmd = params.command;
  switch (cmd.type) {
    case "approve":
      queue.enqueue(`project-approve#${project.id}`, () => approveProject(project.id));
      break;
    case "pause":
      queue.enqueue(`project-pause#${project.id}`, () => pauseProject(project.id));
      break;
    case "resume":
      queue.enqueue(`project-resume#${project.id}`, () => resumeProject(project.id));
      break;
    case "status":
      queue.enqueue(`project-status#${project.id}`, () => refreshProjectStatus(project.id));
      break;
    case "retry":
      queue.enqueue(`project-retry#${project.id}`, () =>
        retryTask(project.id, cmd.taskId),
      );
      break;
    case "cancel":
      queue.enqueue(`project-cancel#${project.id}`, () => cancelProject(project.id));
      break;
  }
}

/**
 * On boot, resume any non-terminal projects.
 * Also recovers tasks that were RUNNING when the process died — resets them to READY
 * so advanceProject picks them up again.
 */
export function resumeActiveProjects(): void {
  if (!config.project.enabled) return;

  const projects = listActiveProjects();
  for (const project of projects) {
    if (project.state === ProjectState.PLANNING) {
      queue.enqueue(`project-plan#${project.id}`, () => planProject(project.id));
    } else if (project.state === ProjectState.RUNNING) {
      // Recover tasks stuck in RUNNING state (process died mid-execution).
      const tasks = listProjectTasks(project.id);
      for (const task of tasks) {
        if (task.state === ProjectTaskState.RUNNING) {
          // If it already has a PR, it was in CI monitoring — re-run from there.
          // If not, reset to READY for a fresh attempt.
          setTaskState(task.id, ProjectTaskState.READY);
          logger.info({ projectId: project.id, taskId: task.id }, "recovered stuck RUNNING task -> READY");
        }
      }
      queue.enqueue(`project-resume#${project.id}`, () => advanceProject(project.id));
    }
  }
  if (projects.length > 0) {
    logger.info({ count: projects.length }, "resumed active projects after restart");
  }
}

// ---------------------------------------------------------------------------
// Internal orchestration
// ---------------------------------------------------------------------------

async function planProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.PLANNING) return;

  let client: RepoClient | null = null;
  try {
    client = await octokitForRepo(project.owner, project.repo);
    const { octokit } = client;

    const issue = await getIssue(octokit, project.owner, project.repo, project.issueNumber);

    // Gather basic repo context (file tree at root, README if available)
    let repoContext = "";
    try {
      const { data: tree } = await octokit.rest.git.getTree({
        owner: project.owner,
        repo: project.repo,
        tree_sha: "HEAD",
        recursive: "true",
      });
      const paths = tree.tree
        .filter((t) => t.type === "blob")
        .map((t) => t.path)
        .slice(0, 200);
      repoContext = `File tree (top 200):\n${paths.join("\n")}`;
    } catch {
      repoContext = "(could not retrieve file tree)";
    }

    const plan = await generateTaskPlan({
      jobId: null,
      issueTitle: issue.title,
      issueBody: issue.body,
      repoContext,
      pro: true,
    });

    // Persist tasks
    for (let i = 0; i < plan.tasks.length; i++) {
      const entry = plan.tasks[i];
      createProjectTask({
        projectId,
        taskIndex: i,
        title: entry.title,
        description: entry.description,
        dependencies: entry.dependencies,
        subtasks: entry.subtasks,
      });
    }

    updateProject(projectId, {
      state: ProjectState.AWAITING_APPROVAL,
      plan: JSON.stringify(plan),
    });

    broadcastEvent("project_update", { projectId, state: ProjectState.AWAITING_APPROVAL, action: "planned" });

    await reportProjectProgress(octokit, projectId);
    logger.info({ projectId, tasks: plan.tasks.length }, "project planned; awaiting approval");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, err: message }, "project planning failed");
    updateProject(projectId, { lastError: message, state: ProjectState.FAILED });
    if (client) {
      await reportProjectProgress(client.octokit, projectId).catch(() => {});
      await comment(
        client.octokit,
        project.owner,
        project.repo,
        project.issueNumber,
        `ai-dev project: planning failed.\n\n\`${message}\``,
      ).catch(() => {});
    }
  }
}

async function approveProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;

  if (project.state !== ProjectState.AWAITING_APPROVAL) {
    logger.info(
      { projectId, state: project.state },
      "approve command in wrong state; ignoring",
    );
    return;
  }

  setProjectState(projectId, ProjectState.RUNNING);
  broadcastEvent("project_update", { projectId, state: ProjectState.RUNNING, action: "approved" });
  logger.info({ projectId }, "project approved -> running");

  let client: RepoClient | null = null;
  try {
    client = await octokitForRepo(project.owner, project.repo);
    await comment(
      client.octokit,
      project.owner,
      project.repo,
      project.issueNumber,
      "ai-dev project: approved. Starting task execution…",
    );
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  await advanceProject(projectId);
}

async function pauseProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.RUNNING) return;

  setProjectState(projectId, ProjectState.PAUSED);
  broadcastEvent("project_update", { projectId, state: ProjectState.PAUSED, action: "paused" });
  logger.info({ projectId }, "project paused");

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await comment(
      client.octokit,
      project.owner,
      project.repo,
      project.issueNumber,
      "ai-dev project: paused. Use `/ai-dev resume` to continue.",
    );
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }
}

async function resumeProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.PAUSED) return;

  setProjectState(projectId, ProjectState.RUNNING);
  broadcastEvent("project_update", { projectId, state: ProjectState.RUNNING, action: "resumed" });
  logger.info({ projectId }, "project resumed");

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await comment(
      client.octokit,
      project.owner,
      project.repo,
      project.issueNumber,
      "ai-dev project: resumed.",
    );
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  await advanceProject(projectId);
}

async function cancelProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || PROJECT_TERMINAL_STATES.has(project.state)) return;

  setProjectState(projectId, ProjectState.CANCELLED);
  broadcastEvent("project_update", { projectId, state: ProjectState.CANCELLED, action: "cancelled" });
  logger.info({ projectId }, "project cancelled");

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await comment(
      client.octokit,
      project.owner,
      project.repo,
      project.issueNumber,
      "ai-dev project: cancelled.",
    );
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }
}

async function retryTask(projectId: number, taskIndex: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;

  const task = getProjectTaskByIndex(projectId, taskIndex);
  if (!task) {
    logger.warn({ projectId, taskIndex }, "retry: task not found");
    return;
  }

  if (task.state !== ProjectTaskState.FAILED) {
    logger.info({ projectId, taskIndex, state: task.state }, "retry: task not in FAILED state");
    return;
  }

  updateProjectTask(task.id, { state: ProjectTaskState.READY, lastError: null });
  logger.info({ projectId, taskIndex }, "task reset to READY for retry");

  if (project.state === ProjectState.FAILED) {
    setProjectState(projectId, ProjectState.RUNNING);
  }

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  if (
    project.state === ProjectState.RUNNING ||
    project.state === ProjectState.FAILED
  ) {
    await advanceProject(projectId);
  }
}

async function refreshProjectStatus(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await reportProjectProgress(client.octokit, projectId);
  } catch (err) {
    logger.warn({ projectId, err: (err as Error).message }, "status refresh failed");
  }
}

/**
 * Advance the project: pick next ready task, execute sequentially (one at a time).
 * After each task completes (or fails), re-evaluate and continue.
 */
async function advanceProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.RUNNING) return;

  // Check for completion
  if (isProjectComplete(projectId)) {
    await finalizeProject(projectId);
    return;
  }

  const readyTasks = getNextReadyTasks(projectId);
  if (readyTasks.length === 0) {
    // Check if we're deadlocked: no READY tasks, no RUNNING tasks, but BLOCKED tasks remain.
    // This means failed dependencies are blocking progress. Skip blocked tasks to unblock.
    const allTasks = listProjectTasks(projectId);
    const hasRunning = allTasks.some(t => t.state === ProjectTaskState.RUNNING);
    if (hasRunning) {
      logger.debug({ projectId }, "no ready tasks; waiting for running tasks to finish");
      return;
    }
    const blockedTasks = allTasks.filter(t => t.state === ProjectTaskState.BLOCKED);
    if (blockedTasks.length > 0) {
      // Deadlock: skip blocked tasks whose dependencies failed
      for (const bt of blockedTasks) {
        setTaskState(bt.id, ProjectTaskState.SKIPPED);
        updateProjectTask(bt.id, { lastError: "skipped: dependency task(s) failed" });
        logger.info({ projectId, taskId: bt.id }, "skipped blocked task (failed dependencies)");
      }
      // Now check completion again
      if (isProjectComplete(projectId)) {
        await finalizeProject(projectId);
      }
    } else {
      // No blocked, no ready, no running — should be complete
      if (isProjectComplete(projectId)) {
        await finalizeProject(projectId);
      }
    }
    return;
  }

  // Execute one task at a time (sequential by default)
  const task = readyTasks[0];
  const executor = getTaskExecutor();
  if (!executor.canExecute(task)) {
    logger.warn({ projectId, taskId: task.id }, "executor cannot handle task");
    return;
  }

  setTaskState(task.id, ProjectTaskState.RUNNING);
  broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.RUNNING, action: "started" });

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  queue.enqueue(`project-task#${task.id}`, async () => {
    const freshProject = getProjectById(projectId);
    if (!freshProject || freshProject.state !== ProjectState.RUNNING) return;

    try {
      await executor.executeTask(freshProject, task);
      setTaskState(task.id, ProjectTaskState.COMPLETED);
      broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.COMPLETED, action: "completed" });
      logger.info({ projectId, taskId: task.id }, "task completed successfully");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateProjectTask(task.id, {
        state: ProjectTaskState.FAILED,
        lastError: message.slice(0, 1000),
      });
      broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.FAILED, action: "failed", error: message.slice(0, 200) });
      logger.error({ projectId, taskId: task.id, err: message }, "task execution failed");
      await cleanupFailedWorktree(task).catch(() => {});
    }

    // Update progress
    try {
      const client = await octokitForRepo(project.owner, project.repo);
      await reportProjectProgress(client.octokit, projectId);
    } catch {
      /* best-effort */
    }

    // Continue to next task
    await advanceProject(projectId);
  });
}

/**
 * Run full-project validation after all tasks finish and post final report.
 */
async function finalizeProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;

  const success = isProjectSuccessful(projectId);
  const finalState = success ? ProjectState.COMPLETED : ProjectState.FAILED;
  setProjectState(projectId, finalState);
  broadcastEvent("project_update", { projectId, state: finalState, action: "finalized", success });
  logger.info({ projectId, success }, "project completed");

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    const { report } = await runFinalValidation(project);
    await comment(client.octokit, project.owner, project.repo, project.issueNumber, report);
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }
}
