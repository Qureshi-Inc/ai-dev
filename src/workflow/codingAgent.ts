// ---------------------------------------------------------------------------
// Coding Agent Client — oMLX Claude Code with concurrency control
// ---------------------------------------------------------------------------

import { run, type RunResult } from "../utils/exec.js";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

// ---------------------------------------------------------------------------
// Sanitized environment for Claude Code (mirrors claudeCodeExecutor.ts)
// ---------------------------------------------------------------------------

const SECRET_ENV_KEYS = new Set([
  "GITHUB_PRIVATE_KEY",
  "GITHUB_PRIVATE_KEY_PATH",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_APP_ID",
  "COOLIFY_DEPLOY_HOOK_URL",
  "SSH_AUTH_SOCK",
  "DOCKER_HOST",
  "LMSTUDIO_API_KEY",
]);

function buildClaudeCodeEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  // Inherit safe basics
  const safeKeys = ["HOME", "PATH", "USER", "LANG", "TERM", "SHELL", "TMPDIR", "NODE_ENV"];
  for (const key of safeKeys) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // Route Claude Code to oMLX via ANTHROPIC_BASE_URL
  const omlxBase = config.llm.baseUrl.replace(/\/v1\/?$/, "");
  env.ANTHROPIC_BASE_URL = omlxBase;
  env.ANTHROPIC_API_KEY = config.llm.apiKey;
  env.CLAUDE_CODE_USE_BEDROCK = "";

  // Force all Claude Code model aliases to use the local oMLX model
  env.ANTHROPIC_SMALL_FAST_MODEL = config.llm.modelPro;
  env.CLAUDE_CODE_SMALL_FAST_MODEL = config.llm.modelPro;

  // Disable telemetry and interactive features
  env.CLAUDE_CODE_DISABLE_TELEMETRY = "1";
  env.CLAUDE_CODE_NON_INTERACTIVE = "1";
  env.NO_COLOR = "1";

  // Git author
  env.GIT_AUTHOR_NAME = config.agent.gitAuthorName;
  env.GIT_AUTHOR_EMAIL = config.agent.gitAuthorEmail;
  env.GIT_COMMITTER_NAME = config.agent.gitAuthorName;
  env.GIT_COMMITTER_EMAIL = config.agent.gitAuthorEmail;

  return env;
}

function validateEnv(env: Record<string, string>): void {
  for (const key of SECRET_ENV_KEYS) {
    if (key in env) {
      throw new Error(`SECURITY: secret "${key}" would leak to Claude Code subprocess`);
    }
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class CodingAgentClient {
  private activeCalls = 0;
  private maxConcurrent: number;
  private log = logger.child({ component: "CodingAgentClient" });

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Execute a coding task via Claude Code.
   */
  async execute(params: {
    worktreePath: string;
    prompt: string;
    modelId: string;
    timeoutMs: number;
    onHeartbeat?: () => void;
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (this.activeCalls >= this.maxConcurrent) {
      throw new Error(
        `Concurrency limit reached: ${this.activeCalls}/${this.maxConcurrent} active calls`,
      );
    }

    this.activeCalls++;
    let heartbeatInterval: ReturnType<typeof setInterval> | undefined;

    try {
      const env = buildClaudeCodeEnv();
      validateEnv(env);

      // Build Claude Code args
      const isRoot = process.getuid?.() === 0;
      const args = isRoot
        ? ["--model", params.modelId, "--allowedTools", "Edit,Write,Read,Bash", "-p", params.prompt]
        : ["--model", params.modelId, "--dangerously-skip-permissions", "-p", params.prompt];

      this.log.info(
        { model: params.modelId, cwd: params.worktreePath, timeout: params.timeoutMs },
        "invoking Claude Code",
      );

      // Set up heartbeat if callback provided
      if (params.onHeartbeat) {
        heartbeatInterval = setInterval(params.onHeartbeat, 30_000);
      }

      const result: RunResult = await run(config.claudeCode.bin, args, {
        cwd: params.worktreePath,
        env,
        timeout: params.timeoutMs,
        allowFailure: true,
        input: "",
      });

      this.log.info(
        { exitCode: result.exitCode, stdoutLen: result.stdout.length },
        "Claude Code completed",
      );

      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } finally {
      this.activeCalls--;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  }

  /**
   * Check whether a concurrency slot is available and oMLX is reachable.
   */
  isAvailable(): boolean {
    return this.activeCalls < this.maxConcurrent;
  }

  /**
   * Get the current number of active Claude Code invocations.
   */
  getActiveCount(): number {
    return this.activeCalls;
  }
}
