import type { InstallationOctokit } from "../github/app.js";
import {
  ProjectState,
  ProjectTaskState,
  type Project,
  type ProjectTask,
} from "../types.js";
import {
  getProjectById,
  listProjectTasks,
  updateProject,
  parseSubtasks,
} from "../storage/projectState.js";
import { logger } from "../utils/logger.js";

function stateEmoji(state: ProjectTaskState): string {
  switch (state) {
    case ProjectTaskState.COMPLETED:
      return "✅";
    case ProjectTaskState.RUNNING:
      return "🔄";
    case ProjectTaskState.FAILED:
      return "❌";
    case ProjectTaskState.SKIPPED:
      return "⏭️";
    case ProjectTaskState.READY:
      return "🟡";
    case ProjectTaskState.BLOCKED:
      return "⬜";
    case ProjectTaskState.PENDING:
      return "⬜";
    default:
      return "⬜";
  }
}

function projectStateLabel(state: ProjectState): string {
  switch (state) {
    case ProjectState.PLANNING:
      return "📋 Planning…";
    case ProjectState.AWAITING_APPROVAL:
      return "⏳ Awaiting approval — comment `/ai-dev approve` to start execution";
    case ProjectState.RUNNING:
      return "🚀 Running";
    case ProjectState.PAUSED:
      return "⏸️ Paused — comment `/ai-dev resume` to continue";
    case ProjectState.COMPLETED:
      return "✅ Completed";
    case ProjectState.CANCELLED:
      return "🚫 Cancelled";
    case ProjectState.FAILED:
      return "❌ Failed";
    default:
      return state;
  }
}

function elapsed(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function buildProjectBody(project: Project, tasks: ProjectTask[]): string {
  const completed = tasks.filter((t) => t.state === ProjectTaskState.COMPLETED).length;
  const total = tasks.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  const lines: string[] = [
    "## 🗂️ ai-dev project",
    "",
    `**Status:** ${projectStateLabel(project.state)}`,
    `**Progress:** ${completed}/${total} tasks (${pct}%)`,
    `**Elapsed:** ${elapsed(project.createdAt)}`,
    "",
    "### Tasks",
    "",
  ];

  for (const task of tasks) {
    const deps = task.dependencies ? JSON.parse(task.dependencies) as number[] : [];
    const depStr = deps.length > 0 ? ` _(depends on: ${deps.map((d) => `#${d + 1}`).join(", ")})_` : "";
    const errorStr = task.state === ProjectTaskState.FAILED && task.lastError
      ? ` — \`${task.lastError.slice(0, 80)}\``
      : "";
    lines.push(
      `${stateEmoji(task.state as ProjectTaskState)} **${task.taskIndex + 1}.** ${task.title}${depStr}${errorStr}`,
    );

    const subtasks = parseSubtasks(task);
    for (const sub of subtasks) {
      lines.push(`   - ${sub}`);
    }
  }

  if (project.lastError) {
    lines.push(
      "",
      "<details><summary>Error details</summary>",
      "",
      "```",
      project.lastError,
      "```",
      "",
      "</details>",
    );
  }

  lines.push(
    "",
    "---",
    "**Commands:**",
    "- `/ai-dev approve` — start execution",
    "- `/ai-dev status` — refresh this comment",
    "- `/ai-dev pause` — pause execution",
    "- `/ai-dev resume` — resume execution",
    "- `/ai-dev retry <task-number>` — retry a failed task",
    "- `/ai-dev cancel` — cancel the project",
    "",
    `<sub>ai-dev project · updated ${new Date().toISOString()}</sub>`,
  );

  return lines.join("\n");
}

async function upsertComment(
  octokit: InstallationOctokit,
  owner: string,
  repo: string,
  issueNumber: number,
  commentId: number | null,
  body: string,
): Promise<number | null> {
  try {
    if (commentId) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
      return commentId;
    }
    const { data } = await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  } catch {
    if (commentId) {
      try {
        const { data } = await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body,
        });
        return data.id;
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

/**
 * Update the persistent status comment on the project's parent issue.
 * Best-effort: never throws.
 */
export async function reportProjectProgress(
  octokit: InstallationOctokit,
  projectId: number,
): Promise<void> {
  const project = getProjectById(projectId);
  if (!project) return;

  const tasks = listProjectTasks(projectId);
  const body = buildProjectBody(project, tasks);

  try {
    const commentId = await upsertComment(
      octokit,
      project.owner,
      project.repo,
      project.issueNumber,
      project.statusCommentId,
      body,
    );
    if (commentId && commentId !== project.statusCommentId) {
      updateProject(projectId, { statusCommentId: commentId });
    }
  } catch (err) {
    logger.warn(
      { projectId, err: (err as Error).message },
      "project progress update failed (non-fatal)",
    );
  }
}
