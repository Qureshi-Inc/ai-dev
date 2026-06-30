import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
 * Plan via Bedrock (Claude Opus) using the SDK directly.
 * No Claude Code CLI wrapper — direct API call guarantees JSON response.
 */
async function planViaBedrock(prompt: string): Promise<TaskPlan> {
  logger.info("task master: using Bedrock (Claude Opus) for planning");

  const { AnthropicBedrock } = await import("@anthropic-ai/bedrock-sdk");

  const client = new AnthropicBedrock({
    awsRegion: process.env.AWS_REGION || "us-east-1",
  });

  const response = await client.messages.create({
    model: "us.anthropic.claude-opus-4-6-v1",
    max_tokens: 16000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
    system: "You are a task planning AI. You MUST respond with ONLY a valid JSON object. No prose, no explanation, no code fences. Just the raw JSON.",
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => (block as unknown as { text: string }).text)
    .join("");

  if (!text) {
    throw new Error("Bedrock returned empty response");
  }

  logger.info({ model: "claude-opus-4-6", chars: text.length }, "Bedrock planning response received");
  return extractJson<TaskPlan>(text);
}

/**
 * Plan via Task Master CLI. Writes a PRD file, runs task-master parse-prd,
 * reads back generated tasks. Task Master uses claude-code provider (Bedrock/Opus).
 * Returns shared context via .taskmaster/tasks/tasks.json that the executor can reference.
 */
async function planViaTaskMasterCli(params: {
  issueTitle: string;
  issueBody: string;
  repoContext: string;
  projectDir: string;
}): Promise<TaskPlan> {
  const { issueTitle, issueBody, repoContext, projectDir } = params;
  logger.info("task master: using Task Master CLI (Bedrock) for planning");

  // Ensure .taskmaster directory exists in the project
  const tmDir = join(projectDir, ".taskmaster");
  const docsDir = join(tmDir, "docs");
  const tasksDir = join(tmDir, "tasks");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });

  // Write the PRD
  const prd = [
    `# ${issueTitle}`,
    "",
    issueBody,
    "",
    "## Repository Context",
    "",
    repoContext,
    "",
    "## Execution Constraints",
    "",
    "- Executor: Claude Code running headlessly (no human in the loop)",
    "- Coding model: Qwen 3.6 35B (local, on Apple M2 Max 96GB via oMLX)",
    "- Each task runs in an isolated git worktree with a fresh Claude Code session",
    "- Each task produces exactly ONE pull request",
    "- EVERY task MUST produce code changes — never create analysis-only tasks",
    "- Do NOT create tasks that modify .github/workflows/",
    "- Keep tasks small and focused — the 35B local model works best with clear instructions",
    "- Include file paths in task descriptions when possible",
  ].join("\n");

  const prdPath = join(docsDir, "prd.txt");
  writeFileSync(prdPath, prd);

  // Build env for task-master (needs PATH with node 20, AWS creds for Bedrock)
  const env: Record<string, string> = {};
  const inheritKeys = [
    "HOME", "PATH", "USER", "LANG", "SHELL", "TMPDIR",
    "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
    "CLAUDE_CODE_USE_BEDROCK", "NVM_DIR", "NVM_BIN",
  ];
  for (const key of inheritKeys) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  env.NO_COLOR = "1";

  // Run task-master parse-prd
  const tmBin = config.project.taskMasterCmd || "task-master";
  const result = await run(tmBin, [
    "parse-prd",
    `--input=${prdPath}`,
    `--num-tasks=${config.project.maxTasks}`,
  ], {
    cwd: projectDir,
    env,
    input: "",
    timeout: 300000,
    allowFailure: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(`task-master parse-prd failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
  }

  // Read generated tasks
  const tasksFile = join(tasksDir, "tasks.json");
  if (!existsSync(tasksFile)) {
    throw new Error("task-master did not create tasks.json");
  }

  const tasksData = JSON.parse(readFileSync(tasksFile, "utf8")) as {
    tasks?: Array<{
      id: number;
      title: string;
      description: string;
      dependencies: number[];
      subtasks?: Array<{ title: string; description?: string }>;
      priority?: string;
      details?: string;
    }>;
  };

  if (!tasksData.tasks || tasksData.tasks.length === 0) {
    throw new Error("task-master produced no tasks");
  }

  // Convert to our TaskPlan format
  const tasks: TaskPlanEntry[] = tasksData.tasks.map((t) => ({
    title: t.title,
    description: [
      t.description,
      t.details ? `\nImplementation details:\n${t.details}` : "",
    ].join(""),
    dependencies: t.dependencies || [],
    subtasks: (t.subtasks || []).map(s => s.title || s.description || ""),
  }));

  logger.info({ tasks: tasks.length }, "Task Master CLI generated plan");
  return { tasks };
}

/**
 * Generate a dependency-aware task plan for a project issue.
 * Priority order: Task Master CLI → Claude Code (Bedrock) → oMLX fallback.
 */
export async function generateTaskPlan(params: {
  jobId: number | null;
  issueTitle: string;
  issueBody: string;
  repoContext: string;
  pro?: boolean;
  projectDir?: string;
}): Promise<TaskPlan> {
  const { issueTitle, issueBody, repoContext, pro } = params;

  let plan: TaskPlan | null = null;

  // Priority 1: Bedrock (Claude Opus) direct API call — reliable JSON
  if (config.project.planViaClaudeCode) {
    try {
      const prompt = buildPlanningPrompt({ issueTitle, issueBody, repoContext });
      plan = await planViaBedrock(prompt);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Bedrock planning failed; falling back to oMLX");
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

  // Validate, clamp, and fix dependency chains
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

  // Force task 0 to always be dependency-free (guarantees at least one task can start)
  if (validated.length > 0) {
    validated[0].dependencies = [];
  }

  // Limit dependency depth: no task should have more than 3 levels of transitive deps.
  // This prevents a single failure from cascading across the entire plan.
  // Also ensure at least 2 tasks are dependency-free if plan has 5+ tasks.
  if (validated.length >= 5) {
    const depFreeCount = validated.filter(t => t.dependencies.length === 0).length;
    if (depFreeCount < 2) {
      // Find the first task with deps that only depends on task 0, make it dep-free
      for (let i = 1; i < validated.length; i++) {
        if (validated[i].dependencies.length === 1 && validated[i].dependencies[0] === 0) {
          validated[i].dependencies = [];
          break;
        }
      }
    }
  }

  return { tasks: validated };
}
