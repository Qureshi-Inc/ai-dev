import { getGithubApp } from "./app.js";
import { config, isRepoAllowed, isUserAllowed } from "../config.js";
import { logger } from "../utils/logger.js";
import { submitIssue, handleWorkflowConclusion } from "../agent/orchestrator.js";

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
    if (config.agent.triggerLabel) {
      const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")));
      if (!labels.includes(config.agent.triggerLabel)) {
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

  // Allow triggering after creation by applying the trigger label.
  app.webhooks.on("issues.labeled", async ({ payload }) => {
    if (!config.agent.triggerLabel) return;
    if (payload.label?.name !== config.agent.triggerLabel) return;
    maybeSubmit(
      payload.repository.owner.login,
      payload.repository.name,
      payload.issue,
      payload.sender?.login,
      "labeled",
    );
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
      triggerLabel: config.agent.triggerLabel || "(any)",
      triggerUsers: config.agent.triggerUsers.length > 0 ? config.agent.triggerUsers : "(anyone)",
    },
    "github webhooks registered (issues.opened, issues.labeled, workflow_run.completed)",
  );
}
