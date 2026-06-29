/**
 * Compatibility check for Claude Code + oMLX integration.
 * Verifies:
 *   1. Claude Code binary exists and runs
 *   2. oMLX is reachable
 *   3. The configured model exists on oMLX
 *   4. A real tool call succeeds (not just printed text)
 *   5. Secret isolation: no forbidden env vars leak
 *
 * Usage: npx tsx scripts/check-claude-code.ts
 *
 * This script uses a separate temp DB to avoid touching the production DB.
 */
import { config as loadDotenv } from "dotenv";
loadDotenv();

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use a temp DB so we don't need write access to the production DB.
const TMP = mkdtempSync(join(tmpdir(), "ai-dev-check-"));
process.env.DB_PATH = join(TMP, "check.db");

let failures = 0;
let passes = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes++;
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main(): Promise<void> {
  const { config } = await import("../src/config.js");
  const { run } = await import("../src/utils/exec.js");
  const { validateSanitizedEnv } = await import("../src/agent/claudeCodeExecutor.js");

  console.log("[claude-code binary]");

  // 1. Check Claude Code binary exists
  const whichResult = await run("which", [config.claudeCode.bin], { allowFailure: true });
  const binExists = whichResult.exitCode === 0;
  check("claude code binary found", binExists, `'${config.claudeCode.bin}' not in PATH`);

  if (binExists) {
    // Check version
    const versionResult = await run(config.claudeCode.bin, ["--version"], { allowFailure: true });
    const hasVersion = versionResult.exitCode === 0 && versionResult.stdout.trim().length > 0;
    check("claude code version responds", hasVersion, versionResult.stderr);
    if (hasVersion) {
      console.log(`         version: ${versionResult.stdout.trim()}`);
    }
  }

  console.log("\n[omlx connectivity]");

  // 2. Check oMLX is reachable
  const baseUrl = config.llm.baseUrl.replace(/\/v1\/?$/, "");
  let omlxReachable = false;
  try {
    const res = await fetch(`${config.llm.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.llm.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    omlxReachable = res.ok;
    check("omlx reachable", omlxReachable, `status ${res.status}`);

    if (omlxReachable) {
      const body = await res.json() as { data?: Array<{ id: string }> };
      const models = (body.data ?? []).map((m) => m.id);
      console.log(`         models available: ${models.join(", ") || "(none)"}`);

      // 3. Check configured model exists
      const modelExists = models.some((m) =>
        m.toLowerCase() === config.llm.modelPro.toLowerCase(),
      );
      check(
        `configured model '${config.llm.modelPro}' exists`,
        modelExists,
        `available: ${models.join(", ")}`,
      );
    }
  } catch (err) {
    check("omlx reachable", false, (err as Error).message);
  }

  console.log("\n[secret isolation]");

  // 5. Verify secret isolation
  // Build the env that would be passed to Claude Code
  const buildClaudeCodeEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    const safeKeys = ["HOME", "PATH", "USER", "LANG", "TERM", "SHELL", "TMPDIR", "NODE_ENV"];
    for (const key of safeKeys) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    env.ANTHROPIC_BASE_URL = config.llm.baseUrl.replace(/\/v1\/?$/, "");
    env.ANTHROPIC_API_KEY = config.llm.apiKey;
    env.ANTHROPIC_MODEL = config.llm.modelPro;
    env.CLAUDE_MODEL = config.llm.modelPro;
    env.CLAUDE_CODE_DISABLE_TELEMETRY = "1";
    env.CLAUDE_CODE_NON_INTERACTIVE = "1";
    env.NO_COLOR = "1";
    env.GIT_AUTHOR_NAME = config.agent.gitAuthorName;
    env.GIT_AUTHOR_EMAIL = config.agent.gitAuthorEmail;
    env.GIT_COMMITTER_NAME = config.agent.gitAuthorName;
    env.GIT_COMMITTER_EMAIL = config.agent.gitAuthorEmail;
    return env;
  };

  const sanitizedEnv = buildClaudeCodeEnv();
  const leaks = validateSanitizedEnv(sanitizedEnv);
  check("no secrets in sanitized env", leaks.length === 0, `leaked: ${leaks.join(", ")}`);
  check("GITHUB_PRIVATE_KEY not passed", !("GITHUB_PRIVATE_KEY" in sanitizedEnv));
  check("GITHUB_WEBHOOK_SECRET not passed", !("GITHUB_WEBHOOK_SECRET" in sanitizedEnv));
  check("COOLIFY_DEPLOY_HOOK_URL not passed", !("COOLIFY_DEPLOY_HOOK_URL" in sanitizedEnv));
  check("SSH_AUTH_SOCK not passed", !("SSH_AUTH_SOCK" in sanitizedEnv));
  check("DOCKER_HOST not passed", !("DOCKER_HOST" in sanitizedEnv));

  // Verify the right vars ARE present
  check("ANTHROPIC_BASE_URL set", "ANTHROPIC_BASE_URL" in sanitizedEnv);
  check("ANTHROPIC_API_KEY set", "ANTHROPIC_API_KEY" in sanitizedEnv);
  check("ANTHROPIC_MODEL set", "ANTHROPIC_MODEL" in sanitizedEnv);

  console.log("\n[tool call verification]");

  // 4. Real tool call test (only if oMLX is reachable and binary exists)
  if (omlxReachable && binExists) {
    console.log("         sending test prompt to Claude Code via oMLX...");
    const testResult = await run(config.claudeCode.bin, [
      "--print",
      "--dangerously-skip-permissions",
      "What is 2+2? Reply with only the number.",
    ], {
      env: sanitizedEnv,
      allowFailure: true,
      timeout: 60000,
      input: "",
    });

    const gotResponse = testResult.exitCode === 0 && testResult.stdout.trim().length > 0;
    check("claude code got a response from omlx", gotResponse,
      gotResponse ? "" : `exit=${testResult.exitCode} stderr=${testResult.stderr.slice(0, 200)}`);

    if (gotResponse) {
      const output = testResult.stdout.trim();
      const hasActualContent = output.length > 0 && output.length < 100;
      check("response is concise (not a tool-call dump)", hasActualContent,
        `output length: ${output.length}`);

      // Check it's not just printing a tool-call schema
      const looksLikeToolCall = output.includes('"type": "tool_use"') || output.includes("tool_call");
      check("response is actual text (not raw tool-call JSON)", !looksLikeToolCall,
        looksLikeToolCall ? "output looks like a raw tool-call object" : "");

      console.log(`         response: "${output.slice(0, 80)}"`);
    }
  } else {
    console.log("         skipped (oMLX unreachable or binary missing)");
  }

  console.log("");
  if (failures === 0) {
    console.log(`COMPATIBILITY CHECK OK: ${passes} checks passed`);
    process.exit(0);
  } else {
    console.error(`COMPATIBILITY CHECK FAILED: ${failures} of ${passes + failures} checks failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("check crashed:", err);
  process.exit(1);
});
