import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

mkdirSync(dirname(config.agent.dbPath), { recursive: true });

export const db = new Database(config.agent.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS issue_jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    owner         TEXT    NOT NULL,
    repo          TEXT    NOT NULL,
    issue_number  INTEGER NOT NULL,
    title         TEXT    NOT NULL,
    branch        TEXT,
    pr_number     INTEGER,
    head_sha      TEXT,
    state         TEXT    NOT NULL,
    retry_count   INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    spec          TEXT,
    plan          TEXT,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    UNIQUE(owner, repo, issue_number)
  );

  CREATE TABLE IF NOT EXISTS model_calls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      INTEGER,
    task_type   TEXT,
    model       TEXT,
    prompt      TEXT,
    response    TEXT,
    latency_ms  INTEGER,
    created_at  TEXT NOT NULL,
    FOREIGN KEY (job_id) REFERENCES issue_jobs(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_pr     ON issue_jobs(owner, repo, pr_number);
  CREATE INDEX IF NOT EXISTS idx_jobs_state  ON issue_jobs(state);
  CREATE INDEX IF NOT EXISTS idx_calls_job   ON model_calls(job_id);
`);

// Lightweight migration: add columns introduced after initial release.
const jobCols = (db.prepare("PRAGMA table_info(issue_jobs)").all() as Array<{ name: string }>).map(
  (c) => c.name,
);
if (!jobCols.includes("progress_comment_id")) {
  db.exec("ALTER TABLE issue_jobs ADD COLUMN progress_comment_id INTEGER");
}
if (!jobCols.includes("progress_pr_comment_id")) {
  db.exec("ALTER TABLE issue_jobs ADD COLUMN progress_pr_comment_id INTEGER");
}

logger.info({ dbPath: config.agent.dbPath }, "sqlite storage ready");
