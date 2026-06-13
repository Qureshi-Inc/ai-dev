/**
 * Redelivers the GitHub App's ping webhook and reports the new HTTP status,
 * confirming GitHub -> tunnel -> server works now that the server is up.
 */
import { getGithubApp } from "../src/github/app.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const app = getGithubApp();
  const { data } = await app.octokit.rest.apps.listWebhookDeliveries({ per_page: 20 });
  const ping = data.find((d) => d.event === "ping");
  if (!ping) {
    console.log("No ping delivery found to redeliver.");
    return;
  }
  await app.octokit.rest.apps.redeliverWebhookDelivery({ delivery_id: ping.id });
  console.log(`Redelivered ping (id ${ping.id}); waiting for result...`);
  await sleep(5000);
  const { data: after } = await app.octokit.rest.apps.listWebhookDeliveries({ per_page: 5 });
  console.log("LATEST DELIVERIES:");
  for (const d of after) {
    console.log(
      `  ${d.delivered_at}  ${d.event}  -> HTTP ${d.status_code} (${d.status})` +
        (d.redelivery ? "  [redelivery]" : ""),
    );
  }
}

main().catch((err) => {
  console.error("FAILED:", (err as Error).message);
  process.exit(1);
});
