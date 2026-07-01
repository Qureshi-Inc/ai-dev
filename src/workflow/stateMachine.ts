// ---------------------------------------------------------------------------
// Task Run State Machine
// ---------------------------------------------------------------------------

export enum TaskRunStatus {
  QUEUED = "queued",
  VALIDATING = "validating",
  PREPARING_WORKTREE = "preparing_worktree",
  BUILDING_CONTEXT = "building_context",
  CODING = "coding",
  INSPECTING_DIFF = "inspecting_diff",
  VERIFYING = "verifying",
  REPAIRING = "repairing",
  COMMITTING = "committing",
  AWAITING_REVIEW = "awaiting_review",
  COMPLETED = "completed",
  BLOCKED = "blocked",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

/** Valid transitions from each state. */
const TRANSITIONS: Record<TaskRunStatus, TaskRunStatus[]> = {
  [TaskRunStatus.QUEUED]: [
    TaskRunStatus.VALIDATING,
    TaskRunStatus.CANCELLED,
    TaskRunStatus.FAILED,
  ],
  [TaskRunStatus.VALIDATING]: [
    TaskRunStatus.PREPARING_WORKTREE,
    TaskRunStatus.BLOCKED,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.PREPARING_WORKTREE]: [
    TaskRunStatus.BUILDING_CONTEXT,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.BUILDING_CONTEXT]: [
    TaskRunStatus.CODING,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.CODING]: [
    TaskRunStatus.INSPECTING_DIFF,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.INSPECTING_DIFF]: [
    TaskRunStatus.VERIFYING,
    TaskRunStatus.COMMITTING,
    TaskRunStatus.REPAIRING,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.VERIFYING]: [
    TaskRunStatus.COMMITTING,
    TaskRunStatus.REPAIRING,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.REPAIRING]: [
    TaskRunStatus.CODING,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.COMMITTING]: [
    TaskRunStatus.AWAITING_REVIEW,
    TaskRunStatus.COMPLETED,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.AWAITING_REVIEW]: [
    TaskRunStatus.COMPLETED,
    TaskRunStatus.REPAIRING,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
  ],
  [TaskRunStatus.COMPLETED]: [],
  [TaskRunStatus.BLOCKED]: [
    TaskRunStatus.QUEUED,
    TaskRunStatus.CANCELLED,
    TaskRunStatus.FAILED,
  ],
  [TaskRunStatus.FAILED]: [],
  [TaskRunStatus.CANCELLED]: [],
};

/** Terminal states that cannot transition further. */
const TERMINAL_STATES: ReadonlySet<TaskRunStatus> = new Set([
  TaskRunStatus.COMPLETED,
  TaskRunStatus.FAILED,
  TaskRunStatus.CANCELLED,
]);

/**
 * Check whether a state transition is valid.
 */
export function canTransition(from: TaskRunStatus, to: TaskRunStatus): boolean {
  const allowed = TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Assert that a state transition is valid; throws if not.
 */
export function assertTransition(from: TaskRunStatus, to: TaskRunStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} -> ${to}. Allowed transitions from ${from}: [${TRANSITIONS[from].join(", ")}]`,
    );
  }
}

/**
 * Check whether a status is terminal (no further transitions possible).
 */
export function isTerminal(status: TaskRunStatus): boolean {
  return TERMINAL_STATES.has(status);
}
