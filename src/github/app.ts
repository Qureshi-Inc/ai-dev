import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import { config, assertGithubConfigured } from "../config.js";
import { logger } from "../utils/logger.js";

/** A REST-enabled Octokit instance (has the `.rest` namespace). */
export type InstallationOctokit = Octokit;

let _app: App | null = null;

/** Lazily construct and cache the GitHub App. Throws if config is incomplete. */
export function getGithubApp(): App {
  if (_app) return _app;
  assertGithubConfigured();
  _app = new App({
    appId: config.github.appId,
    privateKey: config.github.privateKey,
    webhooks: { secret: config.github.webhookSecret },
    // Use the REST-enabled Octokit so installation clients expose `.rest`.
    Octokit,
  });
  logger.info({ appId: config.github.appId }, "github app initialised");
  return _app;
}

export interface RepoClient {
  octokit: InstallationOctokit;
  /** Short-lived installation access token usable for git over HTTPS. */
  token: string;
  installationId: number;
}

/** Resolve an installation-scoped Octokit + raw token for a specific repo. */
export async function octokitForRepo(owner: string, repo: string): Promise<RepoClient> {
  const app = getGithubApp();
  const appOctokit = app.octokit as unknown as InstallationOctokit;
  const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
  const octokit = (await app.getInstallationOctokit(installation.id)) as unknown as InstallationOctokit;
  const auth = (await octokit.auth({ type: "installation" })) as { token: string };
  return { octokit, token: auth.token, installationId: installation.id };
}
