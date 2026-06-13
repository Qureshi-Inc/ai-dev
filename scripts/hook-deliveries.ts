/**
 * Lists the GitHub App's recent webhook deliveries and the HTTP status GitHub
 * received from our endpoint. Confirms the GitHub -> tunnel -> server path.
 * Prints only delivery metadata (no secrets).
 */
import { getGithubApp } from "../src/github/app.js";

async function main(): Promise<void> {
  const app = getGithubApp();
  const { data } = await app.octokit.rest.apps.listWebhookDeliveries({ per_page: 10 });
  if (data.length === 0) {
    console.log("No webhook deliveries yet.");
    return;
  }
  console.log("RECENT DELIVERIES (newest first):");
  for (const d of data) {
    const action = d.action ? `.${d.action}` : "";
    console.log(
      `  ${d.delivered_at}  ${d.event}${action}  -> HTTP ${d.status_code} (${d.status})` +
        (d.redelivery ? "  [redelivery]" : ""),
    );
  }
}

main().catch((err) => {
  console.error("FAILED:", (err as Error).message);
  process.exit(1);
});
