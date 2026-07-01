// ---------------------------------------------------------------------------
// Workflow / Durable Execution Types
// ---------------------------------------------------------------------------

import { TaskRunStatus } from "./stateMachine.js";

/** Artifact types that can be stored for a task run. */
export type ArtifactType =
  | "agent_output"
  | "prompt_manifest"
  | "diff_summary"
  | "test_output"
  | "build_output"
  | "commit_sha"
  | "pr_url"
  | "failure_diagnostic";

/** Attempt statuses. */
export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

/** A single task run record. */
export interface TaskRun {
  id: number;
  projectId: number;
  phaseId: number | null;
  taskId: number;
  workflowId: string;
  status: TaskRunStatus;
  currentStep: string | null;
  startingCommitSha: string | null;
  resultingCommitSha: string | null;
  branchName: string | null;
  worktreePath: string | null;
  workerId: string | null;
  attemptNumber: number;
  failureType: string | null;
  failureMessage: string | null;
  retryable: boolean | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

/** A single attempt within a task run. */
export interface TaskAttempt {
  id: number;
  taskRunId: number;
  attemptNumber: number;
  status: AttemptStatus;
  failureType: string | null;
  failureMessage: string | null;
  retryable: boolean | null;
  modelProvider: string | null;
  modelName: string | null;
  promptTokensEstimate: number | null;
  outputTokenCount: number | null;
  startedAt: string;
  completedAt: string | null;
  heartbeatAt: string | null;
}

/** An event logged during a task run. */
export interface TaskRunEvent {
  id: number;
  taskRunId: number;
  attemptId: number | null;
  eventType: string;
  step: string | null;
  message: string;
  metadata: string | null;
  createdAt: string;
}

/** An artifact produced by a task run. */
export interface TaskArtifact {
  id: number;
  taskRunId: number;
  attemptId: number | null;
  artifactType: ArtifactType;
  name: string;
  content: string | null;
  metadata: string | null;
  createdAt: string;
}
