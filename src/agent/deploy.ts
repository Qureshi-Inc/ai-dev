import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Fire the optional Coolify (or any) deploy webhook after a successful merge.
 * Returns true if a hook was configured and the POST succeeded.
 */
export async function triggerDeployHook(context: {
  owner: string;
  repo: string;
  prNumber: number | null;
}): Promise<boolean> {
  const url = config.coolify.deployHookUrl;
  if (!url) return false;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "ai-dev", ...context, at: new Date().toISOString() }),
    });
    logger.info({ ...context, status: res.status }, "deploy hook fired");
    return res.ok;
  } catch (err) {
    logger.error({ ...context, err: (err as Error).message }, "deploy hook failed");
    return false;
  }
}
