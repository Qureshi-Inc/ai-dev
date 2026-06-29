import { Router, type Request, type Response, type NextFunction } from "express";
import { config } from "./config.js";
import { db } from "./storage/db.js";
import {
  getProjectById,
  listProjectTasks,
  getProjectTaskById,
  setProjectState,
  updateProjectTask,
} from "./storage/projectState.js";
import { listActiveJobs } from "./storage/state.js";
import { getLatestOmlxStats } from "./omlx/monitor.js";
import { broadcastEvent, getBufferedEvents, getClientCount } from "./sse.js";
import { advanceProjectFromDashboard } from "./agent/projectOrchestrator.js";
import { queue } from "./queue/queue.js";
import {
  ProjectState,
  ProjectTaskState,
  PROJECT_TERMINAL_STATES,
} from "./types.js";

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function dashboardAuth(req: Request, res: Response, next: NextFunction): void {
  // Check Bearer token
  const authHeader = req.header("Authorization");
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (config.dashboard.apiToken && token === config.dashboard.apiToken) {
      next();
      return;
    }
  }

  // Check session cookie (GitHub login in a simple signed cookie)
  const sessionUser = req.header("X-Dashboard-User")?.toLowerCase();
  if (sessionUser) {
    const allowedUsers = config.dashboard.allowedUsers.length > 0
      ? config.dashboard.allowedUsers
      : config.agent.triggerUsers;
    // Empty allowed list = anyone with a session header is trusted
    if (allowedUsers.length === 0 || allowedUsers.includes(sessionUser)) {
      next();
      return;
    }
  }

  // If no token is configured, allow all requests (development mode)
  if (!config.dashboard.apiToken) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

// ---------------------------------------------------------------------------
// Helpers
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

function rowToProjectSummary(row: ProjectRow) {
  return {
    id: row.id,
    owner: row.owner,
    repo: row.repo,
    issueNumber: row.issue_number,
    title: row.title,
    state: row.state,
    createdBy: row.created_by,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function taskCountsForProject(projectId: number): { total: number; completed: number; running: number; failed: number } {
  const tasks = listProjectTasks(projectId);
  return {
    total: tasks.length,
    completed: tasks.filter((t) => t.state === ProjectTaskState.COMPLETED || t.state === ProjectTaskState.SKIPPED).length,
    running: tasks.filter((t) => t.state === ProjectTaskState.RUNNING).length,
    failed: tasks.filter((t) => t.state === ProjectTaskState.FAILED).length,
  };
}

function paramAsString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

function handleOverview(_req: Request, res: Response): void {
  const activeJobs = listActiveJobs();

  const projectRows = db
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as ProjectRow[];

  const activeProjects = projectRows.filter(
    (r) => !["COMPLETED", "CANCELLED", "FAILED"].includes(r.state),
  );

  const taskRows = db
    .prepare("SELECT state, COUNT(*) as count FROM project_tasks GROUP BY state")
    .all() as Array<{ state: string; count: number }>;

  const taskStats: Record<string, number> = {};
  for (const row of taskRows) {
    taskStats[row.state] = row.count;
  }

  res.json({
    activeJobCount: activeJobs.length,
    totalProjects: projectRows.length,
    activeProjects: activeProjects.length,
    taskStats,
    queueDepth: queue.size(),
    sseClients: getClientCount(),
    omlxReachable: getLatestOmlxStats()?.reachable ?? null,
  });
}

function handleProjects(_req: Request, res: Response): void {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as ProjectRow[];

  const result = rows.map((row) => ({
    ...rowToProjectSummary(row),
    taskCounts: taskCountsForProject(row.id),
  }));

  res.json(result);
}

function handleProjectDetail(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const project = getProjectById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const tasks = listProjectTasks(id);
  res.json({ ...project, tasks });
}

function handleTaskDetail(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const task = getProjectTaskById(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  // Get model calls for this task's job
  let modelCalls: unknown[] = [];
  if (task.jobId) {
    modelCalls = db
      .prepare("SELECT * FROM model_calls WHERE job_id = ? ORDER BY id DESC LIMIT 50")
      .all(task.jobId) as unknown[];
  }

  res.json({ ...task, modelCalls });
}

function handleEvents(req: Request, res: Response): void {
  const since = parseInt(req.query.since as string, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);

  const events = getBufferedEvents(since, limit);
  res.json(events);
}

function handleHealth(_req: Request, res: Response): void {
  const omlxStats = getLatestOmlxStats();

  // Check SQLite health
  let sqliteOk = false;
  try {
    db.prepare("SELECT 1").get();
    sqliteOk = true;
  } catch {
    // DB not accessible
  }

  res.json({
    aiDev: { ok: true, uptime: process.uptime() },
    sqlite: { ok: sqliteOk },
    github: { configured: !!config.github.appId },
    omlx: {
      monitoring: config.dashboard.omlxMonitoringEnabled,
      reachable: omlxStats?.reachable ?? null,
      activeModel: omlxStats?.activeModel ?? null,
      isStale: omlxStats?.isStale ?? null,
      sampledAt: omlxStats?.sampledAt ?? null,
    },
    sseClients: getClientCount(),
  });
}

function handleOmlxStats(_req: Request, res: Response): void {
  const stats = getLatestOmlxStats();
  if (!stats) {
    res.json({ available: false, stats: null });
    return;
  }
  res.json({ available: true, stats });
}

// ---------------------------------------------------------------------------
// Command handlers (state mutations)
// ---------------------------------------------------------------------------

function handleApproveProject(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const project = getProjectById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.state !== ProjectState.AWAITING_APPROVAL) {
    res.status(409).json({
      error: `Cannot approve project in state ${project.state}`,
      currentState: project.state,
      expectedState: ProjectState.AWAITING_APPROVAL,
    });
    return;
  }

  const updated = setProjectState(id, ProjectState.RUNNING);
  broadcastEvent("project_update", { project: updated, action: "approve" });

  // Trigger the orchestrator to advance the project
  advanceProjectFromDashboard(id);

  res.json(updated);
}

function handlePauseProject(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const project = getProjectById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.state !== ProjectState.RUNNING) {
    res.status(409).json({
      error: `Cannot pause project in state ${project.state}`,
      currentState: project.state,
      expectedState: ProjectState.RUNNING,
    });
    return;
  }

  const updated = setProjectState(id, ProjectState.PAUSED);
  broadcastEvent("project_update", { project: updated, action: "pause" });
  res.json(updated);
}

function handleResumeProject(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const project = getProjectById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (project.state !== ProjectState.PAUSED) {
    res.status(409).json({
      error: `Cannot resume project in state ${project.state}`,
      currentState: project.state,
      expectedState: ProjectState.PAUSED,
    });
    return;
  }

  const updated = setProjectState(id, ProjectState.RUNNING);
  broadcastEvent("project_update", { project: updated, action: "resume" });

  // Trigger advancement
  advanceProjectFromDashboard(id);

  res.json(updated);
}

function handleCancelProject(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid project ID" });
    return;
  }

  const project = getProjectById(id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  if (PROJECT_TERMINAL_STATES.has(project.state)) {
    res.status(409).json({
      error: `Cannot cancel project in terminal state ${project.state}`,
      currentState: project.state,
    });
    return;
  }

  const updated = setProjectState(id, ProjectState.CANCELLED);
  broadcastEvent("project_update", { project: updated, action: "cancel" });
  res.json(updated);
}

function handleRetryTask(req: Request, res: Response): void {
  const id = parseInt(paramAsString(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid task ID" });
    return;
  }

  const task = getProjectTaskById(id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  if (task.state !== ProjectTaskState.FAILED) {
    res.status(409).json({
      error: `Cannot retry task in state ${task.state}`,
      currentState: task.state,
      expectedState: ProjectTaskState.FAILED,
    });
    return;
  }

  const updated = updateProjectTask(id, {
    state: ProjectTaskState.READY,
    lastError: null,
  });
  broadcastEvent("task_update", { task: updated, action: "retry" });

  // Check if project needs to be set back to running
  const project = getProjectById(task.projectId);
  if (project && project.state === ProjectState.FAILED) {
    setProjectState(project.id, ProjectState.RUNNING);
    broadcastEvent("project_update", {
      project: getProjectById(project.id),
      action: "resume_for_retry",
    });
  }

  // Trigger advancement
  if (project && (project.state === ProjectState.RUNNING || project.state === ProjectState.FAILED)) {
    advanceProjectFromDashboard(project.id);
  }

  res.json(updated);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createDashboardApiRouter(): Router {
  const router = Router();

  // Apply auth middleware to all routes
  router.use(dashboardAuth);

  // Read-only endpoints
  router.get("/overview", handleOverview);
  router.get("/projects", handleProjects);
  router.get("/projects/:id", handleProjectDetail);
  router.get("/tasks/:id", handleTaskDetail);
  router.get("/events", handleEvents);
  router.get("/health", handleHealth);
  router.get("/omlx", handleOmlxStats);

  // Command endpoints
  router.post("/projects/:id/approve", handleApproveProject);
  router.post("/projects/:id/pause", handlePauseProject);
  router.post("/projects/:id/resume", handleResumeProject);
  router.post("/projects/:id/cancel", handleCancelProject);
  router.post("/tasks/:id/retry", handleRetryTask);

  return router;
}
