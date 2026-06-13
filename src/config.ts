import { readFileSync } from "node:fs";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

function boolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function resolvePrivateKey(): string {
  const inline = process.env.GITHUB_PRIVATE_KEY?.trim();
  const path = process.env.GITHUB_PRIVATE_KEY_PATH?.trim();
  if (inline) {
    // Support keys provided with literal "\n" sequences (common in .env files).
    return inline.includes("\\n") ? inline.replace(/\\n/g, "\n") : inline;
  }
  if (path) {
    return readFileSync(path, "utf8");
  }
  return "";
}

const RawSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8088),
  LOG_LEVEL: z.string().default("info"),
  LOG_PRETTY: z.string().optional(),

  GITHUB_APP_ID: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),

  LMSTUDIO_BASE_URL: z.string().default("http://192.168.4.5:1234/v1"),
  LMSTUDIO_API_KEY: z.string().default("lm-studio"),
  MODEL_CODE: z.string().default("qwen3-coder-30b-a3b-instruct"),
  MODEL_DEBUG: z.string().default("deepseek-coder-v2-lite-instruct"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  // LM Studio JIT auto-unload TTL (seconds). The idle model unloads after this,
  // so qwen and deepseek are not both resident at once. 0 disables sending ttl.
  LLM_TTL_SECONDS: z.coerce.number().int().nonnegative().default(900),
  IMPLEMENT_CONTEXT_FILES: z.coerce.number().int().nonnegative().default(40),
  IMPLEMENT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(24000),

  WORKDIR: z.string().default("/home/opti3/services/ai-dev/data/repos"),
  DB_PATH: z.string().default("/home/opti3/services/ai-dev/data/agent.db"),
  REPO_ALLOWLIST: z.string().default(""),
  TRIGGER_LABEL: z.string().default("ai-dev"),
  // Comma-separated GitHub logins allowed to trigger the agent. Empty = anyone.
  TRIGGER_USERS: z.string().default(""),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  AUTO_MERGE: z.string().optional(),
  MERGE_METHOD: z.enum(["squash", "merge", "rebase"]).default("squash"),
  BRANCH_PREFIX: z.string().default("feature/issue-"),

  GIT_AUTHOR_NAME: z.string().default("ai-dev-bot"),
  GIT_AUTHOR_EMAIL: z.string().default("ai-dev-bot@users.noreply.github.com"),

  CI_POLL_INTERVAL_MS: z.coerce.number().int().nonnegative().default(30000),
  CI_WAIT_TIMEOUT_MS: z.coerce.number().int().positive().default(1800000),

  COOLIFY_DEPLOY_HOOK_URL: z.string().default(""),
});

const raw = RawSchema.parse(process.env);

export const config = {
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,
  logPretty: boolFromEnv(raw.LOG_PRETTY, true),

  github: {
    appId: raw.GITHUB_APP_ID,
    privateKey: resolvePrivateKey(),
    webhookSecret: raw.GITHUB_WEBHOOK_SECRET,
  },

  llm: {
    baseUrl: raw.LMSTUDIO_BASE_URL,
    apiKey: raw.LMSTUDIO_API_KEY,
    modelCode: raw.MODEL_CODE,
    modelDebug: raw.MODEL_DEBUG,
    timeoutMs: raw.LLM_TIMEOUT_MS,
    maxOutputTokens: raw.LLM_MAX_OUTPUT_TOKENS,
    ttlSeconds: raw.LLM_TTL_SECONDS,
    implementContextFiles: raw.IMPLEMENT_CONTEXT_FILES,
    implementMaxFileBytes: raw.IMPLEMENT_MAX_FILE_BYTES,
  },

  agent: {
    workdir: raw.WORKDIR,
    dbPath: raw.DB_PATH,
    repoAllowlist: raw.REPO_ALLOWLIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    triggerLabel: raw.TRIGGER_LABEL.trim(),
    triggerUsers: raw.TRIGGER_USERS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    maxRetries: raw.MAX_RETRIES,
    autoMerge: boolFromEnv(raw.AUTO_MERGE, true),
    mergeMethod: raw.MERGE_METHOD,
    branchPrefix: raw.BRANCH_PREFIX,
    gitAuthorName: raw.GIT_AUTHOR_NAME,
    gitAuthorEmail: raw.GIT_AUTHOR_EMAIL,
  },

  ci: {
    pollIntervalMs: raw.CI_POLL_INTERVAL_MS,
    waitTimeoutMs: raw.CI_WAIT_TIMEOUT_MS,
  },

  coolify: {
    deployHookUrl: raw.COOLIFY_DEPLOY_HOOK_URL.trim(),
  },
} as const;

export type AppConfig = typeof config;

/**
 * Whether the given "owner/repo" (case-insensitive) is permitted.
 * Empty allowlist = deny all. Supported entry forms:
 *   - "owner/repo"  exact match
 *   - "owner/*"     any repo under that owner/org
 *   - "owner"       any repo under that owner/org (bare owner)
 */
export function isRepoAllowed(owner: string, repo: string): boolean {
  const list = config.agent.repoAllowlist;
  if (list.length === 0) return false;
  const o = owner.toLowerCase();
  const full = `${o}/${repo.toLowerCase()}`;
  return list.some((entry) => entry === full || entry === o || entry === `${o}/*`);
}

/**
 * Whether the GitHub login that triggered the event may run the agent.
 * Empty allowlist = anyone (no restriction). Case-insensitive.
 */
export function isUserAllowed(login: string | null | undefined): boolean {
  const list = config.agent.triggerUsers;
  if (list.length === 0) return true;
  if (!login) return false;
  return list.includes(login.toLowerCase());
}

/** Fail fast if required GitHub App settings are missing (skipped in smoke/test mode). */
export function assertGithubConfigured(): void {
  const missing: string[] = [];
  if (!config.github.appId) missing.push("GITHUB_APP_ID");
  if (!config.github.privateKey) missing.push("GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH");
  if (!config.github.webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (missing.length > 0) {
    throw new Error(`Missing required GitHub App config: ${missing.join(", ")}`);
  }
}
