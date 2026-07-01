import { db } from "./db.js";
import "./taskRunDb.js"; // ensure task run tables exist
import { TaskRunStatus, assertTransition, isTerminal } from "../workflow/stateMachine.js";
import type {
  TaskRun,
  TaskAttempt,
  TaskRunEvent,
  TaskArtifact,
  ArtifactType,
  AttemptStatus,
} from "../workflow/types.js";

// ---------------------------------------------------------------------------
// Row types (snake_case from SQLite)
// ---------------------------------------------------------------------------

interface TaskRunRow {
  id: number;
  project_id: number;
  phase_id: number | null;
  task_id: number;
  workflow_id: string;
  status: string;
  current_step: string | null;
  starting_commit_sha: string | null;
  resulting_commit_sha: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  worker_id: string | null;
  attempt_number: number;
  failure_type: string | null;
  failure_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

interface TaskAttemptRow {
  id: number;
  task_run_id: number;
  attempt_number: number;
  status: string;
  failure_type: string | null;
  failure_message: string | null;
  retryable: number | null;
  model_provider: string | null;
  model_name: string | null;
  prompt_tokens_estimate: number | null;
  output_token_count: number | null;
  started_at: string;
  completed_at: string | null;
  heartbeat_at: string | null;
}

interface TaskRunEventRow {
  id: number;
  task_run_id: number;
  attempt_id: number | null;
  event_type: string;
  step: string | null;
  message: string;
  metadata: string | null;
  created_at: string;
}

interface TaskArtifactRow {
  id: number;
  task_run_id: number;
  attempt_id: number | null;
  artifact_type: string;
  name: string;
  content: string | null;
  metadata: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Row -> Model converters
// ---------------------------------------------------------------------------

function rowToTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    projectId: row.project_id,
    phaseId: row.phase_id,
    taskId: row.task_id,
    workflowId: row.workflow_id,
    status: row.status as TaskRunStatus,
    currentStep: row.current_step,
    startingCommitSha: row.starting_commit_sha,
    resultingCommitSha: row.resulting_commit_sha,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    workerId: row.worker_id,
    attemptNumber: row.attempt_number,
    failureType: row.failure_type,
    failureMessage: row.failure_message,
    retryable: row.retryable === null ? null : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskAttempt(row: TaskAttemptRow): TaskAttempt {
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    attemptNumber: row.attempt_number,
    status: row.status as AttemptStatus,
    failureType: row.failure_type,
    failureMessage: row.failure_message,
    retryable: row.retryable === null ? null : row.retryable === 1,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    promptTokensEstimate: row.prompt_tokens_estimate,
    outputTokenCount: row.output_token_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
  };
}

function rowToTaskRunEvent(row: TaskRunEventRow): TaskRunEvent {
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    step: row.step,
    message: row.message,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function rowToTaskArtifact(row: TaskArtifactRow): TaskArtifact {
  return {
    id: row.id,
    taskRunId: row.task_run_id,
    attemptId: row.attempt_id,
    artifactType: row.artifact_type as ArtifactType,
    name: row.name,
    content: row.content,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Task Run CRUD
// ---------------------------------------------------------------------------

export function createTaskRun(params: {
  projectId: number;
  phaseId?: number | null;
  taskId: number;
  workflowId: string;
  branchName?: string | null;
  worktreePath?: string | null;
  workerId?: string | null;
  startingCommitSha?: string | null;
}): TaskRun {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO task_runs (project_id, phase_id, task_id, workflow_id, status, branch_name, worktree_path, worker_id, starting_commit_sha, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.projectId,
      params.phaseId ?? null,
      params.taskId,
      params.workflowId,
      TaskRunStatus.QUEUED,
      params.branchName ?? null,
      params.worktreePath ?? null,
      params.workerId ?? null,
      params.startingCommitSha ?? null,
      ts,
      ts,
    );

  const run = getTaskRunById(Number(info.lastInsertRowid));
  if (!run) throw new Error("failed to create task run");
  return run;
}

export function getTaskRunById(id: number): TaskRun | null {
  const row = db.prepare("SELECT * FROM task_runs WHERE id = ?").get(id) as
    | TaskRunRow
    | undefined;
  return row ? rowToTaskRun(row) : null;
}

export function getActiveRunForTask(taskId: number): TaskRun | null {
  const row = db
    .prepare(
      `SELECT * FROM task_runs WHERE task_id = ? AND status NOT IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1`,
    )
    .get(
      taskId,
      TaskRunStatus.COMPLETED,
      TaskRunStatus.FAILED,
      TaskRunStatus.CANCELLED,
    ) as TaskRunRow | undefined;
  return row ? rowToTaskRun(row) : null;
}

export function updateTaskRunStatus(
  id: number,
  status: TaskRunStatus,
  metadata?: {
    failureType?: string | null;
    failureMessage?: string | null;
    retryable?: boolean | null;
    resultingCommitSha?: string | null;
    workerId?: string | null;
  },
): TaskRun {
  const existing = getTaskRunById(id);
  if (!existing) throw new Error(`task run ${id} not found`);

  assertTransition(existing.status, status);

  const ts = now();
  const startedAt = existing.startedAt ?? (status !== TaskRunStatus.QUEUED ? ts : null);
  const completedAt = isTerminal(status) ? ts : null;

  db.prepare(
    `UPDATE task_runs SET status = ?, failure_type = COALESCE(?, failure_type), failure_message = COALESCE(?, failure_message), retryable = COALESCE(?, retryable), resulting_commit_sha = COALESCE(?, resulting_commit_sha), worker_id = COALESCE(?, worker_id), started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at), updated_at = ? WHERE id = ?`,
  ).run(
    status,
    metadata?.failureType ?? null,
    metadata?.failureMessage ?? null,
    metadata?.retryable === undefined || metadata?.retryable === null
      ? null
      : metadata.retryable
        ? 1
        : 0,
    metadata?.resultingCommitSha ?? null,
    metadata?.workerId ?? null,
    startedAt,
    completedAt,
    ts,
    id,
  );

  const updated = getTaskRunById(id);
  if (!updated) throw new Error(`task run ${id} not found after status update`);
  return updated;
}

export function updateTaskRunStep(id: number, step: string): void {
  db.prepare("UPDATE task_runs SET current_step = ?, updated_at = ? WHERE id = ?").run(
    step,
    now(),
    id,
  );
}

// ---------------------------------------------------------------------------
// Attempt CRUD
// ---------------------------------------------------------------------------

export function createAttempt(
  taskRunId: number,
  attemptNumber: number,
  params?: { modelProvider?: string; modelName?: string },
): TaskAttempt {
  const ts = now();
  const info = db
    .prepare(
      `INSERT INTO task_attempts (task_run_id, attempt_number, status, model_provider, model_name, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskRunId,
      attemptNumber,
      "running",
      params?.modelProvider ?? null,
      params?.modelName ?? null,
      ts,
      ts,
    );

  // Update the attempt_number on the parent task_run
  db.prepare("UPDATE task_runs SET attempt_number = ?, updated_at = ? WHERE id = ?").run(
    attemptNumber,
    ts,
    taskRunId,
  );

  const row = db.prepare("SELECT * FROM task_attempts WHERE id = ?").get(
    Number(info.lastInsertRowid),
  ) as TaskAttemptRow | undefined;
  if (!row) throw new Error("failed to create task attempt");
  return rowToTaskAttempt(row);
}

export function completeAttempt(
  id: number,
  status: AttemptStatus,
  failure?: { type?: string; message?: string; retryable?: boolean },
): void {
  db.prepare(
    `UPDATE task_attempts SET status = ?, failure_type = ?, failure_message = ?, retryable = ?, completed_at = ? WHERE id = ?`,
  ).run(
    status,
    failure?.type ?? null,
    failure?.message ?? null,
    failure?.retryable === undefined ? null : failure.retryable ? 1 : 0,
    now(),
    id,
  );
}

export function updateHeartbeat(attemptId: number): void {
  db.prepare("UPDATE task_attempts SET heartbeat_at = ? WHERE id = ?").run(now(), attemptId);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function appendEvent(
  taskRunId: number,
  event: {
    attemptId?: number | null;
    eventType: string;
    step?: string | null;
    message: string;
    metadata?: Record<string, unknown> | null;
  },
): void {
  db.prepare(
    `INSERT INTO task_run_events (task_run_id, attempt_id, event_type, step, message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskRunId,
    event.attemptId ?? null,
    event.eventType,
    event.step ?? null,
    event.message,
    event.metadata ? JSON.stringify(event.metadata) : null,
    now(),
  );
}

export function getTaskRunEvents(taskRunId: number): TaskRunEvent[] {
  const rows = db
    .prepare("SELECT * FROM task_run_events WHERE task_run_id = ? ORDER BY created_at ASC")
    .all(taskRunId) as TaskRunEventRow[];
  return rows.map(rowToTaskRunEvent);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function storeArtifact(
  taskRunId: number,
  artifact: {
    attemptId?: number | null;
    artifactType: ArtifactType;
    name: string;
    content?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): void {
  db.prepare(
    `INSERT INTO task_artifacts (task_run_id, attempt_id, artifact_type, name, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskRunId,
    artifact.attemptId ?? null,
    artifact.artifactType,
    artifact.name,
    artifact.content ?? null,
    artifact.metadata ? JSON.stringify(artifact.metadata) : null,
    now(),
  );
}

export function getTaskRunArtifacts(taskRunId: number): TaskArtifact[] {
  const rows = db
    .prepare("SELECT * FROM task_artifacts WHERE task_run_id = ? ORDER BY created_at ASC")
    .all(taskRunId) as TaskArtifactRow[];
  return rows.map(rowToTaskArtifact);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function findStaleRuns(heartbeatTimeoutMs: number): TaskRun[] {
  const cutoff = new Date(Date.now() - heartbeatTimeoutMs).toISOString();
  // Find runs that have an active attempt whose heartbeat is older than cutoff
  const rows = db
    .prepare(
      `SELECT tr.* FROM task_runs tr
       INNER JOIN task_attempts ta ON ta.task_run_id = tr.id
       WHERE tr.status NOT IN (?, ?, ?)
         AND ta.status = 'running'
         AND ta.heartbeat_at < ?
       GROUP BY tr.id`,
    )
    .all(
      TaskRunStatus.COMPLETED,
      TaskRunStatus.FAILED,
      TaskRunStatus.CANCELLED,
      cutoff,
    ) as TaskRunRow[];
  return rows.map(rowToTaskRun);
}

export function listTaskRunsForProject(projectId: number): TaskRun[] {
  const rows = db
    .prepare("SELECT * FROM task_runs WHERE project_id = ? ORDER BY created_at ASC")
    .all(projectId) as TaskRunRow[];
  return rows.map(rowToTaskRun);
}
