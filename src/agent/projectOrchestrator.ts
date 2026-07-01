import { config, isRepoAllowed, isUserAllowed } from "../config.js";
import {
  ProjectState,
  ProjectTaskState,
  PhaseState,
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
  createPhase,
  listPhases,
  setPhaseState,
  getNextPendingPhase,
  isAllPhasesComplete,
  getRunningPhase,
  deleteProjectTasks,
} from "../storage/projectState.js";
import { octokitForRepo, type RepoClient } from "../github/app.js";
import { comment, getIssue } from "../github/repo.js";
import { generateTaskPlan } from "./taskMaster.js";
import { generatePhases } from "./epicPlanner.js";
import { reportProjectProgress } from "./projectProgress.js";
import {
  ClaudeCodeTaskExecutor,
  runFinalValidation,
  cleanupFailedWorktree,
} from "./claudeCodeExecutor.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorktreeManager } from "../workflow/worktreeManager.js";
import { ContextBuilder } from "../workflow/contextBuilder.js";
import { CodingAgentClient } from "../workflow/codingAgent.js";
import { VerificationRunner } from "../workflow/verifier.js";
import * as taskRunState from "../storage/taskRunState.js";
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

// ---------------------------------------------------------------------------
// Workflow Engine (lazily initialized)
// ---------------------------------------------------------------------------

let _workflowEngine: WorkflowEngine | null = null;

export function getWorkflowEngine(): WorkflowEngine {
  if (!_workflowEngine) {
    const repoDir = config.agent.workdir;
    const worktreeDir = config.claudeCode.worktreeDir;
    const worktreeManager = new WorktreeManager(repoDir, worktreeDir);
    const contextBuilder = new ContextBuilder({
      maxInputTokens: config.workflow.contextMaxTokens,
      maxFiles: config.workflow.contextMaxFiles,
    });
    const codingAgent = new CodingAgentClient(1);
    const verifier = new VerificationRunner();
    _workflowEngine = new WorkflowEngine(
      taskRunState,
      worktreeManager,
      contextBuilder,
      codingAgent,
      verifier,
    );
  }
  return _workflowEngine;
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

/** Threshold for issue body length to trigger phase mode. */
const EPIC_BODY_THRESHOLD = 5000;
/** Threshold for task count to trigger phase mode (if body is shorter). */
const EPIC_TASK_THRESHOLD = 15;

async function getRepoContext(octokit: RepoClient["octokit"], owner: string, repo: string): Promise<string> {
  try {
    const { data: tree } = await octokit.rest.git.getTree({
      owner,
      repo,
      tree_sha: "HEAD",
      recursive: "true",
    });
    const paths = tree.tree
      .filter((t) => t.type === "blob")
      .map((t) => t.path)
      .slice(0, 80);
    return `File tree (top 80):\n${paths.join("\n")}`;
  } catch {
    return "(could not retrieve file tree)";
  }
}

async function planProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.PLANNING) return;

  let client: RepoClient | null = null;
  try {
    client = await octokitForRepo(project.owner, project.repo);
    const { octokit } = client;

    const issue = await getIssue(octokit, project.owner, project.repo, project.issueNumber);
    const repoContext = await getRepoContext(octokit, project.owner, project.repo);

    const issueBody = issue.body || "";
    const isEpicSized = issueBody.length > EPIC_BODY_THRESHOLD;

    // Attempt phase planning for epic-sized issues
    if (isEpicSized && config.project.planViaClaudeCode) {
      try {
        const phases = await generatePhases({
          issueTitle: issue.title,
          issueBody: issueBody,
          repoContext,
        });

        if (phases.length > 1) {
          // Save phases to DB
          for (let i = 0; i < phases.length; i++) {
            createPhase({
              projectId,
              phaseIndex: i,
              title: phases[i].title,
              description: phases[i].description,
            });
          }

          updateProject(projectId, {
            state: ProjectState.AWAITING_APPROVAL,
            plan: JSON.stringify({ phases }),
          });

          broadcastEvent("project_update", { projectId, state: ProjectState.AWAITING_APPROVAL, action: "phase_planned" });

          await reportProjectProgress(octokit, projectId);
          logger.info({ projectId, phases: phases.length }, "project phase-planned; awaiting approval");
          return;
        }
        // If only 1 phase returned, fall through to direct task planning
        logger.info({ projectId }, "epic planner returned single phase; falling back to direct task plan");
      } catch (err) {
        logger.warn(
          { projectId, err: (err as Error).message },
          "phase generation failed; falling back to direct task planning",
        );
      }
    }

    // Direct task planning (non-phased or fallback)
    const plan = await generateTaskPlan({
      jobId: null,
      issueTitle: issue.title,
      issueBody: issueBody,
      repoContext,
      pro: true,
    });

    // If the planner returns too many tasks AND Claude Code is available, try phasing
    if (plan.tasks.length > EPIC_TASK_THRESHOLD && config.project.planViaClaudeCode) {
      try {
        const phases = await generatePhases({
          issueTitle: issue.title,
          issueBody: issueBody,
          repoContext,
        });
        if (phases.length > 1) {
          for (let i = 0; i < phases.length; i++) {
            createPhase({
              projectId,
              phaseIndex: i,
              title: phases[i].title,
              description: phases[i].description,
            });
          }
          updateProject(projectId, {
            state: ProjectState.AWAITING_APPROVAL,
            plan: JSON.stringify({ phases }),
          });
          broadcastEvent("project_update", { projectId, state: ProjectState.AWAITING_APPROVAL, action: "phase_planned" });
          await reportProjectProgress(octokit, projectId);
          logger.info({ projectId, phases: phases.length }, "task plan was large; switched to phase mode");
          return;
        }
      } catch (err) {
        logger.warn({ projectId, err: (err as Error).message }, "fallback phase generation failed; using direct plan");
      }
    }

    // Persist tasks directly
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
      "ai-dev project: approved. Starting execution…",
    );
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  // If project has phases, start phase advancement; otherwise advance tasks directly
  const phases = listPhases(projectId);
  if (phases.length > 0) {
    await advancePhase(projectId);
  } else {
    await advanceProject(projectId);
  }
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

  // If phased and no current tasks exist (between phases), advance phase
  const phases = listPhases(projectId);
  const tasks = listProjectTasks(projectId);
  if (phases.length > 0 && tasks.length === 0) {
    await advancePhase(projectId);
  } else {
    await advanceProject(projectId);
  }
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
 * Advance a phased project: plan and execute the next pending phase.
 * Between phases, re-fetches the repo file tree for accurate context.
 */
async function advancePhase(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.RUNNING) return;

  // Check if all phases are done
  if (isAllPhasesComplete(projectId)) {
    await finalizeProject(projectId);
    return;
  }

  const nextPhase = getNextPendingPhase(projectId);
  if (!nextPhase) {
    // No pending phases — check if a running phase exists (tasks in progress)
    const running = getRunningPhase(projectId);
    if (running) {
      // Phase is RUNNING, tasks are being processed via advanceProject
      return;
    }
    // All done
    await finalizeProject(projectId);
    return;
  }

  // Set phase to RUNNING
  setPhaseState(nextPhase.id, PhaseState.RUNNING);
  broadcastEvent("project_update", { projectId, action: "phase_started", phaseIndex: nextPhase.phaseIndex });
  logger.info({ projectId, phaseIndex: nextPhase.phaseIndex, phaseTitle: nextPhase.title }, "starting phase");

  // Clear oMLX caches between phases to ensure memory headroom
  try {
    const { clearOmlxCaches } = await import("../omlx/monitor.js");
    await clearOmlxCaches();
  } catch { /* non-fatal */ }

  // Save a summary of completed tasks before deleting (for dashboard history).
  const prevTasks = listProjectTasks(projectId);
  if (prevTasks.length > 0) {
    const allPhases = listPhases(projectId);
    const prevPhase = allPhases.find((p: { state: string; id: number }) => (p.state === PhaseState.COMPLETED || p.state === PhaseState.FAILED) && p.id !== nextPhase.id);
    if (prevPhase && prevPhase.id !== nextPhase.id) {
      const completed = prevTasks.filter(t => t.state === "COMPLETED");
      const failed = prevTasks.filter(t => t.state === "FAILED");
      const summary = `Completed: ${completed.length}/${prevTasks.length} tasks. ` +
        (completed.length > 0 ? `PRs: ${completed.map(t => "#" + t.prNumber).filter(Boolean).join(", ")}. ` : "") +
        (failed.length > 0 ? `Failed: ${failed.map(t => t.title).join(", ")}` : "");
      // Append summary to phase description
      const { db } = await import("../storage/db.js");
      db.prepare("UPDATE project_phases SET description = description || ? WHERE id = ?")
        .run(`\n\n--- Results ---\n${summary}`, prevPhase.id);
    }
  }
  // Delete tasks (UNIQUE constraint on task_index requires it for new phase tasks).
  deleteProjectTasks(projectId);

  // Re-fetch repo context between phases
  let repoContext = "";
  try {
    const client = await octokitForRepo(project.owner, project.repo);
    repoContext = await getRepoContext(client.octokit, project.owner, project.repo);
  } catch {
    repoContext = "(could not retrieve file tree)";
  }

  // Generate tasks for this phase
  try {
    const plan = await generateTaskPlan({
      jobId: null,
      issueTitle: `${project.title} — Phase ${nextPhase.phaseIndex + 1}: ${nextPhase.title}`,
      issueBody: nextPhase.description,
      repoContext,
      pro: true,
    });

    // Persist tasks for this phase
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

    logger.info({ projectId, phaseIndex: nextPhase.phaseIndex, tasks: plan.tasks.length }, "phase tasks generated");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, phaseIndex: nextPhase.phaseIndex, err: message }, "phase task generation failed");
    setPhaseState(nextPhase.id, PhaseState.FAILED);
    updateProject(projectId, { lastError: `Phase ${nextPhase.phaseIndex + 1} planning failed: ${message}` });
    // Continue to next phase (skip failed one)
    await advancePhase(projectId);
    return;
  }

  // Update progress and start task execution
  try {
    const client = await octokitForRepo(project.owner, project.repo);
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }

  await advanceProject(projectId);
}

/**
 * Advance the project: pick next ready task, execute sequentially (one at a time).
 * After each task completes (or fails), re-evaluate and continue.
 */
async function advanceProject(projectId: number): Promise<void> {
  const project = getProjectById(projectId);
  if (!project || project.state !== ProjectState.RUNNING) return;

  const phases = listPhases(projectId);
  const isPhased = phases.length > 0;

  // If phased project has no tasks, advance to next phase
  const allTasks = listProjectTasks(projectId);
  if (isPhased && allTasks.length === 0) {
    await advancePhase(projectId);
    return;
  }

  // Check for completion of current tasks
  if (isProjectComplete(projectId)) {
    if (isPhased) {
      // Current phase's tasks are done — mark phase as complete and advance
      const runningPhase = getRunningPhase(projectId);
      if (runningPhase) {
        // Phase is successful if majority of tasks completed (not all need to pass)
        const phaseTasks = listProjectTasks(projectId);
        const completed = phaseTasks.filter(t => t.state === "COMPLETED").length;
        const total = phaseTasks.length;
        const phaseSuccess = total > 0 && (completed / total) >= 0.5;
        setPhaseState(runningPhase.id, phaseSuccess ? PhaseState.COMPLETED : PhaseState.FAILED);
        logger.info({ projectId, phaseIndex: runningPhase.phaseIndex, phaseSuccess }, "phase completed");
      }
      await advancePhase(projectId);
    } else {
      await finalizeProject(projectId);
    }
    return;
  }

  const readyTasks = getNextReadyTasks(projectId);
  if (readyTasks.length === 0) {
    // Check if we're deadlocked: no READY tasks, no RUNNING tasks, but BLOCKED tasks remain.
    const allTasks = listProjectTasks(projectId);
    const hasRunning = allTasks.some(t => t.state === ProjectTaskState.RUNNING);
    if (hasRunning) {
      logger.debug({ projectId }, "no ready tasks; waiting for running tasks to finish");
      return;
    }

    const blockedTasks = allTasks.filter(t => t.state === ProjectTaskState.BLOCKED);
    const failedTasks = allTasks.filter(t => t.state === ProjectTaskState.FAILED);

    // AUTO-RETRY: If there are failed tasks that haven't exhausted retries, retry them
    // before skipping anything. This gives tasks a second chance.
    if (failedTasks.length > 0) {
      const maxRetries = config.claudeCode.maxRetries;
      for (const ft of failedTasks) {
        if (ft.retryCount < maxRetries) {
          logger.info({ projectId, taskId: ft.id, retryCount: ft.retryCount }, "auto-retrying failed task");
          setTaskState(ft.id, ProjectTaskState.READY);
          updateProjectTask(ft.id, { lastError: null });
          // Found a retriable task — advance will pick it up
          await advanceProject(projectId);
          return;
        }
      }
    }

    const failedIndices = new Set(
      failedTasks.map(t => t.taskIndex),
    );

    if (blockedTasks.length > 0) {
      // Only skip tasks that DIRECTLY depend on a permanently failed task (exhausted retries).
      let skippedAny = false;
      for (const bt of blockedTasks) {
        const deps = bt.dependencies ? JSON.parse(bt.dependencies) as number[] : [];
        const hasFailedDep = deps.some(d => failedIndices.has(d));
        if (hasFailedDep) {
          setTaskState(bt.id, ProjectTaskState.SKIPPED);
          updateProjectTask(bt.id, { lastError: `skipped: depends on failed task(s) ${deps.filter(d => failedIndices.has(d)).join(", ")}` });
          logger.info({ projectId, taskId: bt.id, failedDeps: deps.filter(d => failedIndices.has(d)) }, "skipped task (direct dep failed)");
          skippedAny = true;
        }
      }

      // After skipping direct dependents, try to promote remaining blocked tasks
      if (skippedAny) {
        const newReady = getNextReadyTasks(projectId);
        if (newReady.length > 0) {
          await advanceProject(projectId);
          return;
        }
      }

      // Still deadlocked — skip remaining
      const stillBlocked = listProjectTasks(projectId).filter(t => t.state === ProjectTaskState.BLOCKED);
      for (const bt of stillBlocked) {
        setTaskState(bt.id, ProjectTaskState.SKIPPED);
        updateProjectTask(bt.id, { lastError: "skipped: no path to completion" });
      }

      // Check completion
      if (isProjectComplete(projectId)) {
        if (isPhased) {
          const runningPhase = getRunningPhase(projectId);
          if (runningPhase) {
            const success = isProjectSuccessful(projectId);
            setPhaseState(runningPhase.id, success ? PhaseState.COMPLETED : PhaseState.FAILED);
          }
          await advancePhase(projectId);
        } else {
          await finalizeProject(projectId);
        }
      }
    } else {
      // No blocked, no ready, no running — should be complete
      if (isProjectComplete(projectId)) {
        if (isPhased) {
          const runningPhase = getRunningPhase(projectId);
          if (runningPhase) {
            const success = isProjectSuccessful(projectId);
            setPhaseState(runningPhase.id, success ? PhaseState.COMPLETED : PhaseState.FAILED);
          }
          await advancePhase(projectId);
        } else {
          await finalizeProject(projectId);
        }
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

    let client: RepoClient | null = null;
    try {
      client = await octokitForRepo(freshProject.owner, freshProject.repo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateProjectTask(task.id, {
        state: ProjectTaskState.FAILED,
        lastError: `Failed to get repo client: ${message}`.slice(0, 1000),
      });
      broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.FAILED, action: "failed", error: message.slice(0, 200) });
      await advanceProject(projectId);
      return;
    }

    const base = "main"; // default base branch
    const engine = getWorkflowEngine();
    const result = await engine.executeTask({
      project: freshProject,
      task,
      phase: getRunningPhase(projectId) ?? undefined,
      token: client.token,
      owner: freshProject.owner,
      repo: freshProject.repo,
      baseBranch: base,
    });

    if (result.success) {
      setTaskState(task.id, ProjectTaskState.COMPLETED);
      if (result.prNumber) updateProjectTask(task.id, { prNumber: result.prNumber });
      if (result.commitSha) updateProjectTask(task.id, { headSha: result.commitSha });
      broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.COMPLETED, action: "completed" });
      logger.info({ projectId, taskId: task.id }, "task completed successfully");
    } else {
      // Failure already classified and stored by the engine
      const run = taskRunState.getActiveRunForTask(task.id);
      const failureMsg = run?.failureMessage?.slice(0, 1000) ?? "execution failed";
      updateProjectTask(task.id, {
        state: ProjectTaskState.FAILED,
        lastError: failureMsg,
      });
      broadcastEvent("task_update", { projectId, taskId: task.id, state: ProjectTaskState.FAILED, action: "failed", error: failureMsg.slice(0, 200) });
      logger.error({ projectId, taskId: task.id, err: failureMsg }, "task execution failed");
    }

    // Update progress
    try {
      const progressClient = await octokitForRepo(freshProject.owner, freshProject.repo);
      await reportProjectProgress(progressClient.octokit, projectId);
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

  const phases = listPhases(projectId);
  const isPhased = phases.length > 0;

  // For phased projects, check overall success across phases
  let success: boolean;
  if (isPhased) {
    success = phases.every(
      (p) => p.state === PhaseState.COMPLETED || p.state === PhaseState.SKIPPED,
    );
  } else {
    success = isProjectSuccessful(projectId);
  }

  const finalState = success ? ProjectState.COMPLETED : ProjectState.FAILED;
  setProjectState(projectId, finalState);
  broadcastEvent("project_update", { projectId, state: finalState, action: "finalized", success });
  logger.info({ projectId, success, phased: isPhased }, "project completed");

  try {
    const client = await octokitForRepo(project.owner, project.repo);
    const { report } = await runFinalValidation(project);
    await comment(client.octokit, project.owner, project.repo, project.issueNumber, report);
    await reportProjectProgress(client.octokit, projectId);
  } catch {
    /* best-effort */
  }
}
