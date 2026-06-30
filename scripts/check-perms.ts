/** Prints the App installation's permissions for a repo (to confirm grants took effect). */
import { getGithubApp } from "../src/github/app.js";

async function main(): Promise<void> {
  const app = getGithubApp();
  const { data } = await app.octokit.rest.apps.getRepoInstallation({
    owner: "Qureshi-Inc",
    repo: "localapp",
  });
  const p = data.permissions ?? {};
  console.log("workflows:", (p as Record<string, string>).workflows ?? "(NOT GRANTED)");
  console.log("contents :", (p as Record<string, string>).contents);
  console.log("pull_requests:", (p as Record<string, string>).pull_requests);
  console.log("issues   :", (p as Record<string, string>).issues);
}

main().catch((e) => {
  console.error("FAILED:", (e as Error).message);
  process.exit(1);
});
