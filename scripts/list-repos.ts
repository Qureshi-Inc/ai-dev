/**
 * Lists every repository the GitHub App installation can access, and verifies
 * the App ID + private key parse/authenticate correctly. Prints only repo
 * full-names (owner/repo) - no secrets.
 */
import { getGithubApp } from "../src/github/app.js";

async function main(): Promise<void> {
  const app = getGithubApp();
  const names: string[] = [];

  // Authenticates as the App (JWT), then per-installation tokens.
  await app.eachRepository(({ repository }) => {
    names.push(repository.full_name);
  });

  if (names.length === 0) {
    console.log("NO_REPOS: the App is installed but has access to 0 repositories.");
    console.log("Grant it repo access in the org's installation settings.");
    return;
  }
  console.log("ACCESSIBLE REPOS:");
  for (const n of names.sort()) console.log(`  ${n}`);
  console.log(`\nSuggested REPO_ALLOWLIST=${names.join(",")}`);
}

main().catch((err) => {
  console.error("AUTH/LIST FAILED:", (err as Error).message);
  process.exit(1);
});
