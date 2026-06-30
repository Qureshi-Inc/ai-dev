import { db } from "./db.js";
import "./projectDb.js"; // ensure project tables exist
import {
  ProjectState,
  ProjectTaskState,
  PhaseState,
  PROJECT_TERMINAL_STATES,
  PROJECT_TASK_TERMINAL_STATES,
  type Project,
  type ProjectTask,
  type ProjectPhase,
} from "../types.js";

// ---------------------------------------------------------------------------
// Row types (snake_case from SQLite)
// ---------------------------------------------------------------------------

interface ProjectRow {
  id: number;
  owner: string;
  repo: string;
  issue_number: number;
  title: string;
  state: string;
  status_comment_id: number | null;
  plan: string | null;
  created_by: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: number;
  project_id: number;
  task_index: number;
  title: string;
  description: string;
  state: string;
  dependencies: string | null;
  subtasks: string | null;
  job_id: number | null;
  last_error: string | null;
  branch: string | null;
  pr_number: number | null;
  head_sha: string | null;
  retry_count: number;
  ci_retry_count: number;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    state: row.state as ProjectState,
    statusCommentId: row.status_comment_id,
    plan: row.plan,
    createdBy: row.created_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PhaseRow {
  id: number;
  project_id: number;
  phase_index: number;
  title: string;
  description: string;
  state: string;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: TaskRow): ProjectTask {
  return {
    id: row.id,
    projectId: row.project_id,
    taskIndex: row.task_index,
    title: row.title,
    description: row.description,
    state: row.state as ProjectTaskState,
    dependencies: row.dependencies,
    subtasks: row.subtasks,
    jobId: row.job_id,
    lastError: row.last_error,
    branch: row.branch ?? null,
    prNumber: row.pr_number ?? null,
    headSha: row.head_sha ?? null,
    retryCount: row.retry_count ?? 0,
    ciRetryCount: row.ci_retry_count ?? 0,
    worktreePath: row.worktree_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToPhase(row: PhaseRow): ProjectPhase {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseIndex: row.phase_index,
    title: row.title,
    description: row.description,
    state: row.state as PhaseState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Project CRUD
// ---------------------------------------------------------------------------

export function getOrCreateProject(params: {
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  createdBy: string;
}): { project: Project; created: boolean } {
  const existing = getProjectByIssue(params.owner, params.repo, params.issueNumber);
  if (existing) return { project: existing, created: false };

  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO projects (owner, repo, issue_number, title, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.owner,
      params.repo,
      params.issueNumber,
      params.title,
      ProjectState.PLANNING,
      params.createdBy,
      ts,
      ts,
    );

  const project = getProjectById(Number(info.lastInsertRowid));
  if (!project) throw new Error("failed to create project");
  return { project, created: true };
}

export function getProjectById(id: number): Project | null {
  const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function getProjectByIssue(
  owner: string,
  repo: string,
  issueNumber: number,
): Project | null {
  const row = db
    .prepare("SELECT * FROM projects WHERE owner = ? AND repo = ? AND issue_number = ?")
    .get(owner, repo, issueNumber) as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
}

export function setProjectState(id: number, state: ProjectState): Project {
  db.prepare("UPDATE projects SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
  const p = getProjectById(id);
  if (!p) throw new Error(`project ${id} not found after state update`);
  return p;
}

export function updateProject(
  id: number,
  patch: Partial<{
    state: ProjectState;
    statusCommentId: number | null;
    plan: string | null;
    lastError: string | null;
    title: string;
  }>,
): Project {
  const COLS: Record<string, string> = {
    state: "state",
    statusCommentId: "status_comment_id",
    plan: "plan",
    lastError: "last_error",
    title: "title",
  };
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length > 0) {
    const sets = keys.map((k) => `${COLS[k]} = ?`);
    const values = keys.map((k) => patch[k] as unknown);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  const p = getProjectById(id);
  if (!p) throw new Error(`project ${id} not found after update`);
  return p;
}

export function listActiveProjects(): Project[] {
  const rows = db
    .prepare(
      `SELECT * FROM projects WHERE state NOT IN (?, ?, ?) ORDER BY updated_at ASC`,
    )
    .all(ProjectState.COMPLETED, ProjectState.CANCELLED, ProjectState.FAILED) as ProjectRow[];
  return rows.map(rowToProject);
}

// ---------------------------------------------------------------------------
// Task CRUD
// ---------------------------------------------------------------------------

export function createProjectTask(params: {
  projectId: number;
  taskIndex: number;
  title: string;
  description: string;
  dependencies: number[];
  subtasks: string[];
}): ProjectTask {
  const ts = now();
  const hasDeps = params.dependencies.length > 0;
  const state = hasDeps ? ProjectTaskState.BLOCKED : ProjectTaskState.READY;
  const info = db
    .prepare(
      `INSERT INTO project_tasks (project_id, task_index, title, description, state, dependencies, subtasks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.projectId,
      params.taskIndex,
      params.title,
      params.description,
      state,
      JSON.stringify(params.dependencies),
      JSON.stringify(params.subtasks),
      ts,
      ts,
    );
  const task = getProjectTaskById(Number(info.lastInsertRowid));
  if (!task) throw new Error("failed to create project task");
  return task;
}

export function getProjectTaskById(id: number): ProjectTask | null {
  const row = db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
  return row ? rowToTask(row) : null;
}

export function getProjectTaskByIndex(projectId: number, taskIndex: number): ProjectTask | null {
  const row = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? AND task_index = ?")
    .get(projectId, taskIndex) as TaskRow | undefined;
  return row ? rowToTask(row) : null;
}

export function listProjectTasks(projectId: number): ProjectTask[] {
  const rows = db
    .prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY task_index ASC")
    .all(projectId) as TaskRow[];
  return rows.map(rowToTask);
}

export function setTaskState(id: number, state: ProjectTaskState): ProjectTask {
  db.prepare("UPDATE project_tasks SET state = ?, updated_at = ? WHERE id = ?").run(
    state,
    now(),
    id,
  );
  const t = getProjectTaskById(id);
  if (!t) throw new Error(`task ${id} not found after state update`);
  return t;
}

export type ProjectTaskPatch = Partial<{
  state: ProjectTaskState;
  jobId: number | null;
  lastError: string | null;
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  retryCount: number;
  ciRetryCount: number;
  worktreePath: string | null;
}>;

export function updateProjectTask(id: number, patch: ProjectTaskPatch): ProjectTask {
  const COLS: Record<string, string> = {
    state: "state",
    jobId: "job_id",
    lastError: "last_error",
    branch: "branch",
    prNumber: "pr_number",
    headSha: "head_sha",
    retryCount: "retry_count",
    ciRetryCount: "ci_retry_count",
    worktreePath: "worktree_path",
  };
  const keys = Object.keys(patch) as (keyof ProjectTaskPatch)[];
  if (keys.length > 0) {
    const sets = keys.map((k) => `${COLS[k]} = ?`);
    const values = keys.map((k) => patch[k] as unknown);
    sets.push("updated_at = ?");
    values.push(now());
    values.push(id);
    db.prepare(`UPDATE project_tasks SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }
  const t = getProjectTaskById(id);
  if (!t) throw new Error(`task ${id} not found after update`);
  return t;
}

// ---------------------------------------------------------------------------
// Dependency-aware task selection
// ---------------------------------------------------------------------------

export function parseDependencies(task: ProjectTask): number[] {
  if (!task.dependencies) return [];
  try {
    return JSON.parse(task.dependencies) as number[];
  } catch {
    return [];
  }
}

export function parseSubtasks(task: ProjectTask): string[] {
  if (!task.subtasks) return [];
  try {
    return JSON.parse(task.subtasks) as string[];
  } catch {
    return [];
  }
}

/**
 * Find the next task(s) eligible to run: state=READY and all dependencies completed.
 * Also promotes BLOCKED tasks to READY when their deps are met.
 */
export function getNextReadyTasks(projectId: number): ProjectTask[] {
  const tasks = listProjectTasks(projectId);

  const completedIndices = new Set(
    tasks
      .filter((t) => t.state === ProjectTaskState.COMPLETED)
      .map((t) => t.taskIndex),
  );

  for (const task of tasks) {
    if (task.state !== ProjectTaskState.BLOCKED) continue;
    const deps = parseDependencies(task);
    if (deps.every((d) => completedIndices.has(d))) {
      setTaskState(task.id, ProjectTaskState.READY);
      task.state = ProjectTaskState.READY;
    }
  }

  return tasks.filter((t) => t.state === ProjectTaskState.READY);
}

/**
 * Check if all tasks in a project have reached a terminal state.
 */
export function isProjectComplete(projectId: number): boolean {
  const tasks = listProjectTasks(projectId);
  if (tasks.length === 0) return false;
  return tasks.every((t) => PROJECT_TASK_TERMINAL_STATES.has(t.state as ProjectTaskState));
}

/**
 * Check if all non-skipped/failed tasks are completed.
 */
export function isProjectSuccessful(projectId: number): boolean {
  const tasks = listProjectTasks(projectId);
  if (tasks.length === 0) return false;
  return tasks.every(
    (t) =>
      t.state === ProjectTaskState.COMPLETED || t.state === ProjectTaskState.SKIPPED,
  );
}

// ---------------------------------------------------------------------------
// Phase CRUD
// ---------------------------------------------------------------------------

export function createPhase(params: {
  projectId: number;
  phaseIndex: number;
  title: string;
  description: string;
}): ProjectPhase {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO project_phases (project_id, phase_index, title, description, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.projectId,
      params.phaseIndex,
      params.title,
      params.description,
      PhaseState.PENDING,
      ts,
      ts,
    );
  const row = db.prepare("SELECT * FROM project_phases WHERE id = ?").get(Number(info.lastInsertRowid)) as PhaseRow | undefined;
  if (!row) throw new Error("failed to create phase");
  return rowToPhase(row);
}

export function listPhases(projectId: number): ProjectPhase[] {
  const rows = db
    .prepare("SELECT * FROM project_phases WHERE project_id = ? ORDER BY phase_index ASC")
    .all(projectId) as PhaseRow[];
  return rows.map(rowToPhase);
}

export function setPhaseState(id: number, state: PhaseState): ProjectPhase {
  db.prepare("UPDATE project_phases SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
  const row = db.prepare("SELECT * FROM project_phases WHERE id = ?").get(id) as PhaseRow | undefined;
  if (!row) throw new Error(`phase ${id} not found after state update`);
  return rowToPhase(row);
}

export function getNextPendingPhase(projectId: number): ProjectPhase | null {
  const row = db
    .prepare(
      "SELECT * FROM project_phases WHERE project_id = ? AND state = ? ORDER BY phase_index ASC LIMIT 1",
    )
    .get(projectId, PhaseState.PENDING) as PhaseRow | undefined;
  return row ? rowToPhase(row) : null;
}

export function isAllPhasesComplete(projectId: number): boolean {
  const phases = listPhases(projectId);
  if (phases.length === 0) return true;
  return phases.every(
    (p) => p.state === PhaseState.COMPLETED || p.state === PhaseState.SKIPPED,
  );
}

export function getRunningPhase(projectId: number): ProjectPhase | null {
  const row = db
    .prepare(
      "SELECT * FROM project_phases WHERE project_id = ? AND state = ? ORDER BY phase_index ASC LIMIT 1",
    )
    .get(projectId, PhaseState.RUNNING) as PhaseRow | undefined;
  return row ? rowToPhase(row) : null;
}

/**
 * Delete all tasks for a project (used when transitioning between phases
 * to replace old tasks with new ones for the next phase).
 */
export function deleteProjectTasks(projectId: number): void {
  db.prepare("DELETE FROM project_tasks WHERE project_id = ?").run(projectId);
}
