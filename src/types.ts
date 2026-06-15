/** Deterministic router task categories. */
export enum TaskType {
  // -> code model (Qwen)
  IMPLEMENT = "IMPLEMENT",
  EDIT = "EDIT",
  GENERATE = "GENERATE",
  PARSE = "PARSE",
  PLAN = "PLAN",
  // -> debug model (DeepSeek)
  CI_ANALYSIS = "CI_ANALYSIS",
  DEBUG = "DEBUG",
  REASONING = "REASONING",
}

/** Per-issue job lifecycle states (persisted). */
export enum JobState {
  QUEUED = "QUEUED",
  PARSING = "PARSING",
  PLANNING = "PLANNING",
  IMPLEMENTING = "IMPLEMENTING",
  PR_OPEN = "PR_OPEN",
  CI_RUNNING = "CI_RUNNING",
  FIXING = "FIXING",
  MERGED = "MERGED",
  DEPLOYED = "DEPLOYED",
  FAILED = "FAILED",
}

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  JobState.MERGED,
  JobState.DEPLOYED,
  JobState.FAILED,
]);

export interface IssueJob {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  state: JobState;
  retryCount: number;
  pro: boolean;
  lastError: string | null;
  spec: string | null; // JSON string of IssueSpec
  plan: string | null; // JSON string of string[]
  progressCommentId: number | null;
  progressPrCommentId: number | null;
  epic: boolean;
  /** Whether CI exists for the current head SHA: null = undetermined, true/false once checked. */
  ciPresent: boolean | null;
  createdAt: string;
  updatedAt: string;
}

/** Structured spec extracted from a GitHub issue. */
export interface IssueSpec {
  title: string;
  summary: string;
  requirements: string[];
  acceptanceCriteria: string[];
  affectedAreas: string[];
  notes: string;
  /** The original issue title + body, verbatim. Source of truth for the implementer. */
  originalRequest?: string;
}

/** A single file mutation proposed by the code model. */
export interface FileEdit {
  path: string;
  action: "create" | "modify" | "delete" | "edit";
  /** Full file content for create/modify/delete (delete = ""). Unused for "edit". */
  content: string;
  /** For action "edit": exact existing text to find. */
  search?: string;
  /** For action "edit": replacement text. */
  replace?: string;
}

export interface ImplementResult {
  commitMessage: string;
  summary: string;
  files: FileEdit[];
}

export interface DebugResult {
  rootCause: string;
  fixInstructions: string;
  suspectedFiles: string[];
}

export interface CiOutcome {
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "unknown";
  runId: number | null;
  headSha: string;
  logsExcerpt: string;
}
