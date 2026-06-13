import { config } from "../config.js";
import { TaskType } from "../types.js";

/**
 * Deterministic, rule-based model router. No LLM involved.
 *
 * - Code generation / edits / planning  -> code model (Qwen)
 * - CI failure analysis / debugging / reasoning -> debug model (DeepSeek)
 */
const DEBUG_TASKS: ReadonlySet<TaskType> = new Set([
  TaskType.CI_ANALYSIS,
  TaskType.DEBUG,
  TaskType.REASONING,
]);

export function routeModel(task: TaskType): string {
  return DEBUG_TASKS.has(task) ? config.llm.modelDebug : config.llm.modelCode;
}
