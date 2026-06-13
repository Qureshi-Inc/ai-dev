import { db } from "./db.js";
import type { TaskType } from "../types.js";

const MAX_STORED_CHARS = 100_000;

function clip(text: string): string {
  if (text.length <= MAX_STORED_CHARS) return text;
  return `${text.slice(0, MAX_STORED_CHARS)}\n...[truncated ${text.length - MAX_STORED_CHARS} chars]`;
}

export interface ModelCallRecord {
  jobId: number | null;
  taskType: TaskType;
  model: string;
  prompt: string;
  response: string;
  latencyMs: number;
}

/** Persist a full record of a model call for observability/audit. */
export function logModelCall(record: ModelCallRecord): void {
  db.prepare(
    `INSERT INTO model_calls (job_id, task_type, model, prompt, response, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.jobId,
    record.taskType,
    record.model,
    clip(record.prompt),
    clip(record.response),
    record.latencyMs,
    new Date().toISOString(),
  );
}
