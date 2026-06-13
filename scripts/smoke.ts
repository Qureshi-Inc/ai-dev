/**
 * Self-contained smoke test. Exercises the deterministic router, the SQLite state
 * machine + guardrails, model-call logging, the patch applier, the CI log
 * extractor, and the full HTTP webhook -> orchestrator dispatch path with a
 * simulated `issues.opened` payload (signed). No real GitHub/LM Studio needed:
 * the orchestrator job is expected to end FAILED because the fake App cannot
 * authenticate to GitHub - which still proves the wiring end to end.
 */
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "ai-dev-smoke-"));
const SECRET = "smoke-secret";
const PORT = 8791;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Configure the environment BEFORE importing any app modules (config reads env at load).
process.env.DB_PATH = join(TMP, "agent.db");
process.env.WORKDIR = join(TMP, "repos");
process.env.REPO_ALLOWLIST = "octo/demo";
process.env.TRIGGER_LABEL = "ai-dev";
process.env.TRIGGER_USERS = ""; // no actor restriction for the test (don't inherit .env)
process.env.GITHUB_APP_ID = "123456";
process.env.GITHUB_WEBHOOK_SECRET = SECRET;
process.env.GITHUB_PRIVATE_KEY = privateKey;
process.env.LMSTUDIO_BASE_URL = "http://127.0.0.1:9/v1"; // unreachable -> fast fail
process.env.CI_POLL_INTERVAL_MS = "0";
process.env.LOG_LEVEL = "warn";
process.env.LOG_PRETTY = "false";
process.env.PORT = String(PORT);

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}`);
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sign(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

async function main(): Promise<void> {
  // ---- 1. Deterministic router ----
  console.log("[router]");
  const { routeModel } = await import("../src/router/router.js");
  const { TaskType, JobState } = await import("../src/types.js");
  const { config, isRepoAllowed } = await import("../src/config.js");
  check("IMPLEMENT -> code model", routeModel(TaskType.IMPLEMENT) === config.llm.modelCode);
  check("PLAN -> code model", routeModel(TaskType.PLAN) === config.llm.modelCode);
  check("CI_ANALYSIS -> debug model", routeModel(TaskType.CI_ANALYSIS) === config.llm.modelDebug);
  check("DEBUG -> debug model", routeModel(TaskType.DEBUG) === config.llm.modelDebug);
  check("allowlist permits octo/demo", isRepoAllowed("octo", "demo"));
  check("allowlist denies other/repo", !isRepoAllowed("other", "repo"));

  // ---- 2. Storage state machine + guardrails ----
  console.log("[storage]");
  const state = await import("../src/storage/state.js");
  const a = state.getOrCreateJob({ owner: "octo", repo: "demo", issueNumber: 42, title: "T" });
  check("first getOrCreateJob creates", a.created === true);
  const b = state.getOrCreateJob({ owner: "octo", repo: "demo", issueNumber: 42, title: "T" });
  check("second getOrCreateJob is idempotent (one job per issue)", b.created === false && b.job.id === a.job.id);

  state.saveSpec(a.job.id, {
    title: "T",
    summary: "s",
    requirements: ["r1"],
    acceptanceCriteria: [],
    affectedAreas: ["src/x.ts"],
    notes: "",
  });
  const reloaded = state.getJobById(a.job.id)!;
  check("spec round-trips", state.parseSpec(reloaded)?.requirements[0] === "r1");

  state.setState(a.job.id, JobState.CI_RUNNING);
  check("setState transitions", state.getJobById(a.job.id)!.state === JobState.CI_RUNNING);

  let r = 0;
  for (let i = 0; i < config.agent.maxRetries; i++) r = state.incrementRetry(a.job.id);
  check("retry counter reaches MAX_RETRIES", r === config.agent.maxRetries);
  check("retry guardrail boundary", r >= config.agent.maxRetries);

  // ---- 3. Model-call logging ----
  console.log("[model log]");
  const { logModelCall } = await import("../src/storage/modelLog.js");
  const { db } = await import("../src/storage/db.js");
  logModelCall({
    jobId: a.job.id,
    taskType: TaskType.IMPLEMENT,
    model: config.llm.modelCode,
    prompt: "p",
    response: "x",
    latencyMs: 5,
  });
  const calls = db.prepare("SELECT COUNT(*) AS n FROM model_calls WHERE job_id = ?").get(a.job.id) as { n: number };
  check("model call persisted", calls.n === 1);

  // ---- 4. Patch applier ----
  console.log("[patch]");
  const { applyEdits } = await import("../src/utils/patch.js");
  const repoDir = join(TMP, "patchrepo");
  mkdirSync(repoDir, { recursive: true });
  applyEdits(repoDir, [
    { path: "src/hello.ts", action: "create", content: "export const hi = () => 'hi';\n" },
    { path: "README.md", action: "create", content: "# demo\n" },
  ]);
  check("create writes file", readFileSync(join(repoDir, "src/hello.ts"), "utf8").includes("hi"));
  applyEdits(repoDir, [{ path: "src/hello.ts", action: "modify", content: "export const hi = () => 'bye';\n" }]);
  check("modify updates file", readFileSync(join(repoDir, "src/hello.ts"), "utf8").includes("bye"));
  applyEdits(repoDir, [{ path: "README.md", action: "delete", content: "" }]);
  check("delete removes file", !existsSync(join(repoDir, "README.md")));
  let traversalBlocked = false;
  try {
    applyEdits(repoDir, [{ path: "../escape.txt", action: "create", content: "no" }]);
  } catch {
    traversalBlocked = true;
  }
  check("path traversal rejected", traversalBlocked);

  // ---- 5. CI log extractor ----
  console.log("[ci logs]");
  const { extractRelevantLogs } = await import("../src/ci/logs.js");
  const rawLog = [
    ...Array.from({ length: 50 }, (_, i) => `info line ${i}`),
    "Error: expected 'hi' but received 'bye'",
    "    at Object.<anonymous> (test/hello.test.ts:3:10)",
    "Tests: 1 failed, 0 passed",
  ].join("\n");
  const excerpt = extractRelevantLogs(rawLog);
  check("log excerpt keeps the error line", excerpt.includes("expected 'hi'"));
  check("log excerpt keeps the failure summary", excerpt.includes("1 failed"));

  // ---- 6. HTTP webhook -> orchestrator dispatch (simulated, signed) ----
  console.log("[webhook e2e]");
  await import("../src/index.js"); // boots express server + registers webhooks

  // Wait for the server to be listening.
  let up = false;
  for (let i = 0; i < 50; i++) {
    try {
      const h = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (h.ok) {
        up = true;
        break;
      }
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  check("server is listening", up);

  const event = {
    action: "opened",
    issue: {
      number: 7,
      title: "Add hello function",
      body: "Add hello() returning 'hi'.",
      labels: [{ name: "ai-dev" }],
    },
    repository: { name: "demo", owner: { login: "octo" } },
    sender: { login: "tester" },
  };
  const payload = JSON.stringify(event);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": randomUUID(),
      "x-github-event": "issues",
      "x-hub-signature-256": sign(payload),
    },
    body: payload,
  });
  check("webhook accepted (202)", res.status === 202);

  // The job should be created and then driven to a terminal FAILED state
  // (fake GitHub App can't authenticate), proving the dispatch loop runs.
  let job = null as ReturnType<typeof state.getJobByIssue>;
  for (let i = 0; i < 60; i++) {
    job = state.getJobByIssue("octo", "demo", 7);
    if (job && job.state === JobState.FAILED) break;
    await sleep(250);
  }
  check("webhook created a job", job !== null);
  check("job reached terminal FAILED (auth boundary)", job?.state === JobState.FAILED);

  // Bad signature must be rejected.
  const bad = await fetch(`http://127.0.0.1:${PORT}/api/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-delivery": randomUUID(),
      "x-github-event": "issues",
      "x-hub-signature-256": "sha256=deadbeef",
    },
    body: payload,
  });
  check("bad signature rejected (400)", bad.status === 400);

  console.log("");
  if (failures === 0) {
    console.log("SMOKE OK: all checks passed");
    process.exit(0);
  } else {
    console.error(`SMOKE FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
