import { db } from "./db.js";
import { logger } from "../utils/logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS task_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           INTEGER NOT NULL,
    phase_id             INTEGER,
    task_id              INTEGER NOT NULL,
    workflow_id          TEXT    NOT NULL,
    status               TEXT    NOT NULL,
    current_step         TEXT,
    starting_commit_sha  TEXT,
    resulting_commit_sha TEXT,
    branch_name          TEXT,
    worktree_path        TEXT,
    worker_id            TEXT,
    attempt_number       INTEGER NOT NULL DEFAULT 1,
    failure_type         TEXT,
    failure_message      TEXT,
    retryable            INTEGER,
    created_at           TEXT    NOT NULL,
    started_at           TEXT,
    completed_at         TEXT,
    updated_at           TEXT    NOT NULL,
    UNIQUE(task_id, workflow_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (phase_id)   REFERENCES project_phases(id) ON DELETE SET NULL,
    FOREIGN KEY (task_id)    REFERENCES project_tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_attempts (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    task_run_id            INTEGER NOT NULL,
    attempt_number         INTEGER NOT NULL,
    status                 TEXT    NOT NULL,
    failure_type           TEXT,
    failure_message        TEXT,
    retryable              INTEGER,
    model_provider         TEXT,
    model_name             TEXT,
    prompt_tokens_estimate INTEGER,
    output_token_count     INTEGER,
    started_at             TEXT    NOT NULL,
    completed_at           TEXT,
    heartbeat_at           TEXT,
    UNIQUE(task_run_id, attempt_number),
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS task_run_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_run_id INTEGER NOT NULL,
    attempt_id  INTEGER,
    event_type  TEXT    NOT NULL,
    step        TEXT,
    message     TEXT    NOT NULL,
    metadata    TEXT,
    created_at  TEXT    NOT NULL,
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id)  REFERENCES task_attempts(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS task_artifacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_run_id   INTEGER NOT NULL,
    attempt_id    INTEGER,
    artifact_type TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    content       TEXT,
    metadata      TEXT,
    created_at    TEXT    NOT NULL,
    FOREIGN KEY (task_run_id) REFERENCES task_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id)  REFERENCES task_attempts(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_task_runs_project  ON task_runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_task     ON task_runs(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status   ON task_runs(status);
  CREATE INDEX IF NOT EXISTS idx_task_attempts_run  ON task_attempts(task_run_id);
  CREATE INDEX IF NOT EXISTS idx_task_run_events_run ON task_run_events(task_run_id);
  CREATE INDEX IF NOT EXISTS idx_task_artifacts_run ON task_artifacts(task_run_id);
`);

logger.info("task run tables ready");
