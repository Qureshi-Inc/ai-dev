import { getGithubApp } from "./app.js";
import { config, isRepoAllowed, isUserAllowed } from "../config.js";
import { logger } from "../utils/logger.js";
import { submitIssue, handleWorkflowConclusion } from "../agent/orchestrator.js";
import { submitProject, handleProjectCommand } from "../agent/projectOrchestrator.js";
import { parseProjectCommand } from "../agent/projectCommands.js";

/** Register GitHub webhook handlers on the app's webhook emitter. */
export function registerWebhooks(): void {
  const app = getGithubApp();

  const maybeSubmit = (
    owner: string,
    repo: string,
    issue: { number: number; title: string; labels?: Array<{ name?: string } | string> },
    actor: string | null | undefined,
    via: string,
  ) => {
    if (!isRepoAllowed(owner, repo)) {
      logger.warn({ owner, repo }, "ignoring issue: repo not in allowlist");
      return;
    }

    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));

    // Project Mode: "ai-dev-project" label triggers the project orchestrator.
    if (config.project.enabled && labels.includes(config.project.label)) {
      if (!isUserAllowed(actor)) {
        logger.warn({ owner, repo, issue: issue.number, actor }, "ignoring project: actor not in trigger-user allowlist");
        return;
      }
      logger.info({ owner, repo, issue: issue.number, actor, via }, "project issue accepted -> enqueue");
      submitProject({ owner, repo, issueNumber: issue.number, title: issue.title, actor: actor ?? "unknown" });
      return;
    }

    const triggerLabels = [
      config.agent.triggerLabel,
      config.agent.proLabel,
      config.agent.epicLabel,
    ].filter(Boolean);
    if (triggerLabels.length > 0) {
      if (!labels.some((l) => triggerLabels.includes(l))) {
        logger.info({ owner, repo, issue: issue.number }, "ignoring issue: missing trigger label");
        return;
      }
    }
    if (!isUserAllowed(actor)) {
      logger.warn(
        { owner, repo, issue: issue.number, actor },
        "ignoring issue: actor not in trigger-user allowlist",
      );
      return;
    }
    logger.info({ owner, repo, issue: issue.number, actor, via }, "issue accepted -> enqueue");
    submitIssue({ owner, repo, issueNumber: issue.number, title: issue.title });
  };

  app.webhooks.on("issues.opened", async ({ payload }) => {
    maybeSubmit(
      payload.repository.owner.login,
      payload.repository.name,
      payload.issue,
      payload.sender?.login,
      "opened",
    );
  });

  // Allow triggering after creation by applying a trigger label (ai-dev / ai-dev-pro / ai-dev-epic / ai-dev-project).
  app.webhooks.on("issues.labeled", async ({ payload }) => {
    const triggerLabels = [
      config.agent.triggerLabel,
      config.agent.proLabel,
      config.agent.epicLabel,
      ...(config.project.enabled ? [config.project.label] : []),
    ].filter(Boolean);
    if (triggerLabels.length === 0) return;
    if (!payload.label?.name || !triggerLabels.includes(payload.label.name)) return;
    maybeSubmit(
      payload.repository.owner.login,
      payload.repository.name,
      payload.issue,
      payload.sender?.login,
      "labeled",
    );
  });

  // Issue comment handler for "/ai-dev <command>" project commands.
  app.webhooks.on("issue_comment.created", async ({ payload }) => {
    if (!config.project.enabled) return;
    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    if (!isRepoAllowed(owner, repo)) return;

    const body = payload.comment.body ?? "";
    const command = parseProjectCommand(body);
    if (!command) return;

    const actor = payload.sender?.login;
    if (!isUserAllowed(actor)) {
      logger.warn({ owner, repo, issue: payload.issue.number, actor }, "project command from untrusted user");
      return;
    }

    handleProjectCommand({
      owner,
      repo,
      issueNumber: payload.issue.number,
      actor: actor ?? "unknown",
      command,
    });
  });

  app.webhooks.on("workflow_run.completed", async ({ payload }) => {
    const wr = payload.workflow_run;
    handleWorkflowConclusion({
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      headBranch: wr.head_branch ?? "",
      headSha: wr.head_sha,
      conclusion: wr.conclusion ?? "unknown",
      runId: wr.id,
    });
  });

  app.webhooks.onError((err) => {
    logger.error({ err: err.message }, "webhook handler error");
  });

  logger.info(
    {
      triggerLabels: [config.agent.triggerLabel, config.agent.proLabel, ...(config.project.enabled ? [config.project.label] : [])].filter(Boolean),
      triggerUsers: config.agent.triggerUsers.length > 0 ? config.agent.triggerUsers : "(anyone)",
      projectMode: config.project.enabled,
    },
    "github webhooks registered (issues.opened, issues.labeled, issue_comment.created, workflow_run.completed)",
  );
}
