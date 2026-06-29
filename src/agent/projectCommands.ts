import type { ProjectCommand } from "../types.js";

/**
 * Parse a "/ai-dev <command>" from an issue comment body.
 * Returns null if the comment does not contain a recognized command.
 */
export function parseProjectCommand(body: string): ProjectCommand | null {
  const lines = body.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^\/ai-dev\s+(\S+)(?:\s+(.*))?$/i);
    if (!match) continue;

    const cmd = match[1].toLowerCase();
    const arg = match[2]?.trim();

    switch (cmd) {
      case "approve":
        return { type: "approve" };
      case "pause":
        return { type: "pause" };
      case "resume":
        return { type: "resume" };
      case "status":
        return { type: "status" };
      case "cancel":
        return { type: "cancel" };
      case "retry": {
        const taskId = parseInt(arg ?? "", 10);
        if (isNaN(taskId) || taskId < 1) return null;
        // User-facing task numbers are 1-indexed; convert to 0-indexed task_index
        return { type: "retry", taskId: taskId - 1 };
      }
      default:
        return null;
    }
  }
  return null;
}
