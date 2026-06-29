import { config } from "../config.js";
import { TaskType, type TaskPlan, type TaskPlanEntry } from "../types.js";
import { callModelJson, extractJson } from "../llm/client.js";
import { run } from "../utils/exec.js";
import { logger } from "../utils/logger.js";

const TASK_PLAN_SCHEMA = `{
  "tasks": [
    {
      "title": "short task title",
      "description": "what this task should accomplish, with enough context for an implementer",
      "dependencies": [0],
      "subtasks": ["subtask description"]
    }
  ]
}`;

/**
 * Build the full planning prompt (shared between oMLX and Claude Code paths).
 */
function buildPlanningPrompt(params: {
  issueTitle: string;
  issueBody: string;
  repoContext: string;
}): string {
  return [
    "You are Task Master, a project planning agent. You break complex GitHub issues into",
    "dependency-ordered task plans that will be executed by a LOCAL coding model.",
    "",
    "## Execution environment",
    "- Executor: Claude Code running headlessly (no human in the loop)",
    "- Coding model: Qwen 3.6 35B (local, on Apple M2 Max 96GB via oMLX)",
    "- Each task runs in an isolated git worktree with a fresh Claude Code session",
    "- Each task produces exactly ONE pull request",
    "- Tasks are validated by: diff size limits, independent test runs, then GitHub Actions CI",
    "- Tasks run sequentially overnight — failures must not block subsequent independent tasks",
    "",
    "## Critical planning rules",
    "- EVERY task MUST produce code changes. Never create analysis-only, research, or",
    "  investigation tasks. The executor fails if no files are modified.",
    "- Do ALL analysis yourself NOW (you are Opus on Bedrock, you are the smart one).",
    "  Bake your analysis into each task's description so the coding model just implements.",
    "- Keep each task small and focused. The 35B local model works best with clear,",
    "  scoped instructions — not vague multi-step epics.",
    "- Write task descriptions as direct implementation instructions, not questions.",
    "  Bad: \"Investigate what's wrong with the buttons\"",
    "  Good: \"Fix button click handlers in index.html: add event listeners for .btn-primary",
    "  elements that call the submitForm() function\"",
    "- Include file paths in descriptions when you can infer them from the repo context.",
    "- Do NOT include tasks that modify .github/workflows/ (blocked by security policy).",
    "",
    "## Task structure rules",
    "- Tasks are indexed starting from 0.",
    "- A task's `dependencies` array lists indices of tasks that must complete first.",
    "- A task with no dependencies: `dependencies: []`.",
    "- Order: foundational (types, config, schemas) → implementation → tests.",
    `- Maximum ${config.project.maxTasks} tasks.`,
    "- Subtasks are finer-grained steps WITHIN a task (guidance for the executor).",
    "",
    "Output ONLY valid JSON matching this schema:",
    TASK_PLAN_SCHEMA,
    "",
    "## Issue",
    `### ${params.issueTitle}`,
    "",
    params.issueBody,
    "",
    "## Repository Context",
    params.repoContext,
    "",
    "Break this into implementation tasks. Do your analysis now, output actionable tasks.",
    "Output ONLY the JSON.",
  ].join("\n");
}

/**
 * Plan via Claude Code (Bedrock). Uses the host's Claude Code config which
 * has CLAUDE_CODE_USE_BEDROCK=1 and AWS credentials already set.
 */
async function planViaClaudeCode(prompt: string): Promise<TaskPlan> {
  logger.info("task master: using Claude Code (Bedrock) for planning");

  // Build env: inherit AWS/Bedrock vars from the host, plus Claude Code config.
  const env: Record<string, string> = {};
  const inheritKeys = [
    "HOME", "PATH", "USER", "LANG", "SHELL", "TMPDIR",
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
    "CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_MODEL", "CLAUDE_MODEL",
  ];
  for (const key of inheritKeys) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.CLAUDE_CODE_DISABLE_TELEMETRY = "1";
  env.NO_COLOR = "1";

  // Use -p for the prompt argument. As root in Docker, skip --dangerously-skip-permissions
  // (not allowed as root); Claude Code's --print mode doesn't need file permissions for
  // pure text generation anyway.
  const isRoot = process.getuid?.() === 0;
  const args = isRoot
    ? ["--print", "-p", prompt]
    : ["--print", "--dangerously-skip-permissions", "-p", prompt];

  const result = await run(config.claudeCode.bin, args, {
    env,
    input: "",
    timeout: 300000,
    allowFailure: true,
  });

  if (result.exitCode !== 0) {
    logger.warn({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
      "Claude Code planning failed; falling back to oMLX");
    throw new Error(`Claude Code exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
  }

  const text = result.stdout.trim();
  if (!text) {
    throw new Error("Claude Code returned empty response");
  }

  return extractJson<TaskPlan>(text);
}

/**
 * Generate a dependency-aware task plan for a project issue.
 * When PROJECT_PLAN_VIA_CLAUDE_CODE=true, uses Claude Code (Bedrock/Opus) for
 * higher-quality plans. Falls back to oMLX on failure.
 */
export async function generateTaskPlan(params: {
  jobId: number | null;
  issueTitle: string;
  issueBody: string;
  repoContext: string;
  pro?: boolean;
}): Promise<TaskPlan> {
  const { issueTitle, issueBody, repoContext, pro } = params;

  let plan: TaskPlan | null = null;

  // Try Claude Code (Bedrock) first if configured
  if (config.project.planViaClaudeCode) {
    try {
      const prompt = buildPlanningPrompt({ issueTitle, issueBody, repoContext });
      plan = await planViaClaudeCode(prompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Claude Code planning failed; falling back to oMLX");
      plan = null;
    }
  }

  // Fall back to oMLX (or use it if Claude Code planning is disabled)
  if (!plan) {
    const system = [
      "You are Task Master, a project planning agent. Your job is to break down a complex",
      "GitHub issue into a dependency-ordered task plan.",
      "",
      "Rules:",
      "- Each task should be a single, independently implementable unit of work.",
      "- Tasks are indexed starting from 0.",
      "- A task's `dependencies` array lists the indices of tasks that must complete first.",
      "- A task with no dependencies should have `dependencies: []`.",
      "- Keep tasks focused: each should produce one PR or logical change.",
      "- Order tasks so that foundational work (types, schemas, config) comes first.",
      "- Include testing tasks where appropriate.",
      `- Maximum ${config.project.maxTasks} tasks.`,
      "- Subtasks are finer-grained steps WITHIN a task (not separate tasks).",
      "",
      "Output ONLY valid JSON matching this schema:",
      TASK_PLAN_SCHEMA,
    ].join("\n");

    const user = [
      "## Issue",
      `### ${issueTitle}`,
      "",
      issueBody,
      "",
      "## Repository Context",
      repoContext,
      "",
      "Break this issue into an ordered, dependency-aware task plan.",
    ].join("\n");

    plan = await callModelJson<TaskPlan>(TaskType.PLAN, {
      system,
      user,
      jobId: params.jobId,
      pro,
    });
  }

  if (!plan || !Array.isArray(plan.tasks)) {
    logger.warn("task master returned invalid plan; using single-task fallback");
    return {
      tasks: [
        {
          title: issueTitle,
          description: issueBody,
          dependencies: [],
          subtasks: [],
        },
      ],
    };
  }

  // Validate and clamp
  const clamped = plan.tasks.slice(0, config.project.maxTasks);
  const validated: TaskPlanEntry[] = clamped.map((t, i) => ({
    title: t.title || `Task ${i + 1}`,
    description: t.description || "",
    dependencies: Array.isArray(t.dependencies)
      ? t.dependencies.filter((d) => typeof d === "number" && d >= 0 && d < i)
      : [],
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks.filter((s) => typeof s === "string")
      : [],
  }));

  return { tasks: validated };
}
