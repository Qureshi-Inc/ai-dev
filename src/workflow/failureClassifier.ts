// ---------------------------------------------------------------------------
// Failure Classifier
// ---------------------------------------------------------------------------

export enum FailureType {
  MODEL_UNAVAILABLE = "MODEL_UNAVAILABLE",
  MODEL_TIMEOUT = "MODEL_TIMEOUT",
  MODEL_CONTEXT_LIMIT = "MODEL_CONTEXT_LIMIT",
  MODEL_MEMORY_GUARD = "MODEL_MEMORY_GUARD",
  MODEL_EMPTY_RESPONSE = "MODEL_EMPTY_RESPONSE",
  AGENT_NO_CHANGES = "AGENT_NO_CHANGES",
  AGENT_SCOPE_VIOLATION = "AGENT_SCOPE_VIOLATION",
  TOOL_FAILURE = "TOOL_FAILURE",
  GIT_FAILURE = "GIT_FAILURE",
  MERGE_CONFLICT = "MERGE_CONFLICT",
  TEST_FAILURE = "TEST_FAILURE",
  BUILD_FAILURE = "BUILD_FAILURE",
  LINT_FAILURE = "LINT_FAILURE",
  TYPECHECK_FAILURE = "TYPECHECK_FAILURE",
  AUTHENTICATION_FAILURE = "AUTHENTICATION_FAILURE",
  CONFIGURATION_FAILURE = "CONFIGURATION_FAILURE",
  WORKER_LOST = "WORKER_LOST",
  CANCELLED = "CANCELLED",
  UNKNOWN = "UNKNOWN",
}

export interface ClassifiedFailure {
  type: FailureType;
  message: string;
  retryable: boolean;
  requiresContextReduction: boolean;
}

interface FailureContext {
  exitCode?: number;
  stderr?: string;
  step?: string;
}

/**
 * Classify a failure based on error information and optional context (exit code, stderr, step).
 */
export function classifyFailure(
  error: unknown,
  context?: FailureContext,
): ClassifiedFailure {
  const errorMessage = extractMessage(error);
  const stderr = context?.stderr ?? "";
  const exitCode = context?.exitCode;
  const combined = `${errorMessage}\n${stderr}`.toLowerCase();

  // --- Exit code classification ---
  if (exitCode === 128) {
    // Check for merge conflict specifically
    if (combined.includes("merge conflict") || combined.includes("conflict")) {
      return {
        type: FailureType.MERGE_CONFLICT,
        message: errorMessage || "Merge conflict detected",
        retryable: false,
        requiresContextReduction: false,
      };
    }
    return {
      type: FailureType.GIT_FAILURE,
      message: errorMessage || "Git operation failed (exit 128)",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (exitCode === 137) {
    return {
      type: FailureType.MODEL_MEMORY_GUARD,
      message: errorMessage || "Process killed (OOM, exit 137)",
      retryable: true,
      requiresContextReduction: true,
    };
  }

  if (exitCode === 143) {
    return {
      type: FailureType.MODEL_TIMEOUT,
      message: errorMessage || "Process terminated (timeout, exit 143)",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  // --- Stderr / message pattern matching ---

  if (combined.includes("memory guard") || combined.includes("enospc") || combined.includes("out of memory")) {
    return {
      type: FailureType.MODEL_MEMORY_GUARD,
      message: errorMessage || "Memory guard triggered",
      retryable: true,
      requiresContextReduction: true,
    };
  }

  if (combined.includes("context length") || combined.includes("context_length_exceeded") || combined.includes("maximum context")) {
    return {
      type: FailureType.MODEL_CONTEXT_LIMIT,
      message: errorMessage || "Context length exceeded",
      retryable: true,
      requiresContextReduction: true,
    };
  }

  if (combined.includes("cannot load") || combined.includes("model not found") || combined.includes("no healthy upstream")) {
    return {
      type: FailureType.MODEL_UNAVAILABLE,
      message: errorMessage || "Model unavailable",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("timeout") || combined.includes("timed out") || combined.includes("etimedout")) {
    return {
      type: FailureType.MODEL_TIMEOUT,
      message: errorMessage || "Request timed out",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("empty response") || combined.includes("no content") || combined.includes("null response")) {
    return {
      type: FailureType.MODEL_EMPTY_RESPONSE,
      message: errorMessage || "Model returned empty response",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("merge conflict")) {
    return {
      type: FailureType.MERGE_CONFLICT,
      message: errorMessage || "Merge conflict detected",
      retryable: false,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("no changes") || combined.includes("nothing to commit") || combined.includes("working tree clean")) {
    return {
      type: FailureType.AGENT_NO_CHANGES,
      message: errorMessage || "Agent produced no changes",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("scope violation") || combined.includes("outside allowed")) {
    return {
      type: FailureType.AGENT_SCOPE_VIOLATION,
      message: errorMessage || "Agent violated scope constraints",
      retryable: false,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("authentication") || combined.includes("401") || combined.includes("403") || combined.includes("permission denied")) {
    return {
      type: FailureType.AUTHENTICATION_FAILURE,
      message: errorMessage || "Authentication/permission failure",
      retryable: false,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("test fail") || combined.includes("tests failed") || combined.includes("test suite failed")) {
    return {
      type: FailureType.TEST_FAILURE,
      message: errorMessage || "Tests failed",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("build fail") || combined.includes("compilation error") || combined.includes("build error")) {
    return {
      type: FailureType.BUILD_FAILURE,
      message: errorMessage || "Build failed",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("lint") && (combined.includes("error") || combined.includes("fail"))) {
    return {
      type: FailureType.LINT_FAILURE,
      message: errorMessage || "Lint errors detected",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("type error") || combined.includes("typecheck") || combined.includes("ts2")) {
    return {
      type: FailureType.TYPECHECK_FAILURE,
      message: errorMessage || "TypeScript type errors",
      retryable: true,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("cancel")) {
    return {
      type: FailureType.CANCELLED,
      message: errorMessage || "Operation cancelled",
      retryable: false,
      requiresContextReduction: false,
    };
  }

  if (combined.includes("configuration") || combined.includes("config") || combined.includes("missing env")) {
    return {
      type: FailureType.CONFIGURATION_FAILURE,
      message: errorMessage || "Configuration error",
      retryable: false,
      requiresContextReduction: false,
    };
  }

  // Step-based heuristics
  if (context?.step === "verifying") {
    if (combined.includes("fail")) {
      return {
        type: FailureType.TEST_FAILURE,
        message: errorMessage || "Verification step failed",
        retryable: true,
        requiresContextReduction: false,
      };
    }
  }

  // Fallback
  return {
    type: FailureType.UNKNOWN,
    message: errorMessage || "Unknown failure",
    retryable: true,
    requiresContextReduction: false,
  };
}

/**
 * Extract a human-readable message from an unknown error.
 */
function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "");
}
