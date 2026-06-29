import { db } from "./db.js";
import { logger } from "../utils/logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    owner             TEXT    NOT NULL,
    repo              TEXT    NOT NULL,
    issue_number      INTEGER NOT NULL,
    title             TEXT    NOT NULL,
    state             TEXT    NOT NULL,
    status_comment_id INTEGER,
    plan              TEXT,
    created_by        TEXT    NOT NULL,
    last_error        TEXT,
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL,
    UNIQUE(owner, repo, issue_number)
  );

  CREATE TABLE IF NOT EXISTS project_tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL,
    task_index    INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    description   TEXT    NOT NULL DEFAULT '',
    state         TEXT    NOT NULL,
    dependencies  TEXT,
    subtasks      TEXT,
    job_id        INTEGER,
    last_error    TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    UNIQUE(project_id, task_index),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES issue_jobs(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(state);
  CREATE INDEX IF NOT EXISTS idx_projects_issue ON projects(owner, repo, issue_number);
  CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_tasks_state ON project_tasks(state);
`);

// Lightweight migration: add columns introduced after initial release.
const taskCols = (db.prepare("PRAGMA table_info(project_tasks)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
if (!taskCols.includes("branch")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN branch TEXT");
}
if (!taskCols.includes("pr_number")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN pr_number INTEGER");
}
if (!taskCols.includes("head_sha")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN head_sha TEXT");
}
if (!taskCols.includes("retry_count")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
}
if (!taskCols.includes("ci_retry_count")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN ci_retry_count INTEGER NOT NULL DEFAULT 0");
}
if (!taskCols.includes("worktree_path")) {
  db.exec("ALTER TABLE project_tasks ADD COLUMN worktree_path TEXT");
}

logger.info("project mode tables ready");
