import { config } from "../config.js";
import { TaskType } from "../types.js";

/**
 * Deterministic, rule-based model router. No LLM involved.
 *
 * - pro run (ai-dev-pro label): MODEL_PRO for every task.
 * - debug tasks (CI_ANALYSIS/DEBUG/REASONING): MODEL_DEBUG (deepseek), unless pro.
 * - coding tasks (PARSE/PLAN/IMPLEMENT/EDIT/GENERATE): MODEL_CODE (qwen) on the
 *   initial attempt, escalating to MODEL_PRO once attempt >= ESCALATE_AFTER_RETRIES.
 */
const DEBUG_TASKS: ReadonlySet<TaskType> = new Set([
  TaskType.CI_ANALYSIS,
  TaskType.DEBUG,
  TaskType.REASONING,
]);

export interface RouteContext {
  /** 0 = initial implement; N = the Nth CI-failure fix. */
  attempt?: number;
  /** ai-dev-pro run: force MODEL_PRO everywhere. */
  pro?: boolean;
}

export function routeModel(task: TaskType, ctx: RouteContext = {}): string {
  const attempt = ctx.attempt ?? 0;
  const pro = ctx.pro ?? false;

  if (pro) return config.llm.modelPro;
  if (DEBUG_TASKS.has(task)) return config.llm.modelDebug;
  // Coding task: escalate to the pro model after the configured number of attempts.
  return attempt >= config.llm.escalateAfterRetries ? config.llm.modelPro : config.llm.modelCode;
}
