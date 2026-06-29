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
process.env.PRO_LABEL = "ai-dev-pro";
process.env.ESCALATE_AFTER_RETRIES = "1";
process.env.PROJECT_MODE_ENABLED = "true";
process.env.PROJECT_LABEL = "ai-dev-project";
process.env.PROJECT_MAX_TASKS = "50";

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
  check("IMPLEMENT attempt 0 -> code model", routeModel(TaskType.IMPLEMENT, { attempt: 0 }) === config.llm.modelCode);
  check("IMPLEMENT attempt 1 -> pro model (escalation)", routeModel(TaskType.IMPLEMENT, { attempt: 1 }) === config.llm.modelPro);
  check("PARSE pro -> pro model", routeModel(TaskType.PARSE, { pro: true }) === config.llm.modelPro);
  check("CI_ANALYSIS pro -> pro model", routeModel(TaskType.CI_ANALYSIS, { pro: true }) === config.llm.modelPro);
  check("CI_ANALYSIS attempt 3 (not pro) -> debug model", routeModel(TaskType.CI_ANALYSIS, { attempt: 3 }) === config.llm.modelDebug);
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
  // Surgical edit: exact SEARCH/REPLACE on existing content.
  applyEdits(repoDir, [
    { path: "src/hello.ts", action: "edit", content: "", search: "'bye'", replace: "'ciao'" },
  ]);
  check("edit exact match applies", readFileSync(join(repoDir, "src/hello.ts"), "utf8").includes("ciao"));
  // Whitespace-tolerant edit: SEARCH differs only by leading indentation.
  applyEdits(repoDir, [
    { path: "src/hello.ts", action: "edit", content: "", search: "  export const hi = () => 'ciao';", replace: "export const hi = () => 'hola';" },
  ]);
  check("edit whitespace-tolerant match applies", readFileSync(join(repoDir, "src/hello.ts"), "utf8").includes("hola"));
  // A SEARCH that does not exist must throw loudly.
  let editNotFound = false;
  try {
    applyEdits(repoDir, [{ path: "src/hello.ts", action: "edit", content: "", search: "NOT_PRESENT_ANYWHERE", replace: "x" }]);
  } catch {
    editNotFound = true;
  }
  check("edit missing SEARCH throws", editNotFound);
  // CRLF tolerance: file uses CRLF, the model's SEARCH uses LF -> still applies.
  applyEdits(repoDir, [{ path: "src/crlf.ts", action: "create", content: "const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n" }]);
  applyEdits(repoDir, [{ path: "src/crlf.ts", action: "edit", content: "", search: "const b = 2;", replace: "const b = 22;" }]);
  check("edit tolerates CRLF file vs LF search", readFileSync(join(repoDir, "src/crlf.ts"), "utf8").includes("const b = 22;"));
  applyEdits(repoDir, [{ path: "README.md", action: "delete", content: "" }]);
  check("delete removes file", !existsSync(join(repoDir, "README.md")));
  let traversalBlocked = false;
  try {
    applyEdits(repoDir, [{ path: "../escape.txt", action: "create", content: "no" }]);
  } catch {
    traversalBlocked = true;
  }
  check("path traversal rejected", traversalBlocked);

  // ---- 4b. Implement output parser (regression: @@EDIT without trailing @@END) ----
  console.log("[parse]");
  const { parseDelimited } = await import("../src/agent/implement.js");
  // Aider-style edit block where the model omits @@END (terminated by REPLACE line).
  const editNoEnd = [
    "COMMIT: feat: tweak",
    "SUMMARY: change a line",
    "@@EDIT index.html",
    "<<<<<<< SEARCH",
    "  <title>Old</title>",
    "=======",
    "  <title>New</title>",
    ">>>>>>> REPLACE",
  ].join("\n");
  const parsedNoEnd = parseDelimited(editNoEnd);
  check("parses @@EDIT without trailing @@END", !!parsedNoEnd && parsedNoEnd.files.length === 1);
  check("edit block -> action 'edit'", parsedNoEnd?.files[0].action === "edit");
  check("edit search captured", parsedNoEnd?.files[0].search === "  <title>Old</title>");
  check("edit replace captured", parsedNoEnd?.files[0].replace === "  <title>New</title>");
  // The same block WITH a trailing @@END must also still parse.
  const parsedWithEnd = parseDelimited(editNoEnd + "\n@@END\n");
  check("parses @@EDIT with optional @@END", parsedWithEnd?.files[0].replace === "  <title>New</title>");
  // Mixed: a full-file @@FILE block followed by an @@EDIT (no @@END) both parse.
  const mixed = [
    "COMMIT: c",
    "@@FILE new.txt create",
    "hello",
    "@@END",
    "@@EDIT a.ts",
    "<<<<<<< SEARCH",
    "const x = 1;",
    "=======",
    "const x = 2;",
    ">>>>>>> REPLACE",
  ].join("\n");
  const parsedMixed = parseDelimited(mixed);
  check("mixed @@FILE + @@EDIT both parse", parsedMixed?.files.length === 2);
  check("mixed: first is create", parsedMixed?.files[0].action === "create");
  check("mixed: second is edit", parsedMixed?.files[1].action === "edit");

  // ---- 4c. Context file reader: full vs truncated-with-notice ----
  console.log("[context]");
  const { readFileSafe } = await import("../src/agent/context.js");
  const ctxDir = join(TMP, "ctxrepo");
  mkdirSync(ctxDir, { recursive: true });
  applyEdits(ctxDir, [
    { path: "small.txt", action: "create", content: "line1\nline2\n" },
    { path: "big.txt", action: "create", content: "x".repeat(5000) },
  ]);
  check("full file returned under cap", readFileSafe(ctxDir, "small.txt", 200000) === "line1\nline2\n");
  const truncated = readFileSafe(ctxDir, "big.txt", 1000) ?? "";
  check("oversize file is truncated", truncated.length < 5000 && truncated.includes("TRUNCATED"));
  check("truncation notice steers model to @@FILE rewrite", truncated.includes("@@FILE"));
  check("full big file when cap is high", (readFileSafe(ctxDir, "big.txt", 200000) ?? "").length === 5000);

  // ---- 4c2. Workflow-edit guardrail (block by default; YAML-validate when enabled) ----
  console.log("[workflow guard]");
  const { partitionWorkflowEdits, isWorkflowPath, isValidWorkflowYaml } = await import("../src/utils/patch.js");
  check(
    "isWorkflowPath matches .github/workflows/*.yml|yaml",
    isWorkflowPath(".github/workflows/deploy.yml") && isWorkflowPath(".github/workflows/ci.yaml"),
  );
  check("isWorkflowPath ignores normal files", !isWorkflowPath("src/index.ts") && !isWorkflowPath("README.md"));
  const validWf =
    "name: CI\non:\n  push:\n    branches: [main]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n";
  const brokenWf = "name: CI\non: [push, pull_request\njobs:\n  build:\n    runs-on: ubuntu-latest\n"; // unclosed [
  check("valid workflow YAML accepted", isValidWorkflowYaml(validWf));
  check("broken workflow YAML rejected", !isValidWorkflowYaml(brokenWf));
  check("workflow YAML missing jobs rejected", !isValidWorkflowYaml("on: push\n"));
  // (a) disabled -> all workflow edits blocked, non-workflow edits kept.
  const partOff = partitionWorkflowEdits(
    TMP,
    [
      { path: ".github/workflows/deploy.yml", action: "create", content: validWf },
      { path: "index.html", action: "create", content: "<!DOCTYPE html>\n" },
    ],
    false,
  );
  check(
    "disabled: workflow edit blocked, normal edit kept",
    partOff.blocked.includes(".github/workflows/deploy.yml") &&
      partOff.kept.length === 1 &&
      partOff.kept[0].path === "index.html" &&
      partOff.invalid.length === 0,
  );
  // (b) enabled -> valid workflow kept, invalid workflow dropped.
  const partOnValid = partitionWorkflowEdits(
    TMP,
    [{ path: ".github/workflows/deploy.yml", action: "create", content: validWf }],
    true,
  );
  check(
    "enabled: valid workflow kept",
    partOnValid.kept.length === 1 && partOnValid.blocked.length === 0 && partOnValid.invalid.length === 0,
  );
  const partOnInvalid = partitionWorkflowEdits(
    TMP,
    [{ path: ".github/workflows/bad.yml", action: "create", content: brokenWf }],
    true,
  );
  check(
    "enabled: invalid workflow dropped (not committed)",
    partOnInvalid.kept.length === 0 && partOnInvalid.invalid.includes(".github/workflows/bad.yml"),
  );

  // ---- 4d. Implement prompt: full-file retry mode forbids @@EDIT ----
  console.log("[prompt]");
  const { implementPrompt } = await import("../src/llm/prompts.js");
  const promptArgs = {
    spec: { title: "t", summary: "s", requirements: [], acceptanceCriteria: [], affectedAreas: [], notes: "" },
    steps: ["do x"],
    files: [],
    fileTree: "index.html",
    stepIndex: 0,
    epic: true,
  };
  const normalPrompt = implementPrompt({ ...promptArgs });
  check("default implement prompt offers @@EDIT", normalPrompt.system.includes("@@EDIT"));
  const forcedPrompt = implementPrompt({ ...promptArgs, forceFullFile: true });
  check(
    "forceFullFile prompt switches to full-file mode",
    forcedPrompt.system.includes("FULL-FILE MODE") && forcedPrompt.system.includes("Do NOT use @@EDIT"),
  );

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

  // ---- 6. Project Mode ----
  console.log("[project mode]");
  const projectState = await import("../src/storage/projectState.js");
  const { parseProjectCommand } = await import("../src/agent/projectCommands.js");
  const { ProjectState, ProjectTaskState } = await import("../src/types.js");

  // -- Command parser --
  check("parse /ai-dev approve", parseProjectCommand("/ai-dev approve")?.type === "approve");
  check("parse /ai-dev pause", parseProjectCommand("/ai-dev pause")?.type === "pause");
  check("parse /ai-dev resume", parseProjectCommand("/ai-dev resume")?.type === "resume");
  check("parse /ai-dev status", parseProjectCommand("/ai-dev status")?.type === "status");
  check("parse /ai-dev cancel", parseProjectCommand("/ai-dev cancel")?.type === "cancel");
  const retryCmd = parseProjectCommand("/ai-dev retry 3");
  check("parse /ai-dev retry 3", retryCmd?.type === "retry" && retryCmd.taskId === 2);
  check("parse /ai-dev retry (invalid)", parseProjectCommand("/ai-dev retry") === null);
  check("parse unrelated comment", parseProjectCommand("this is a regular comment") === null);
  check("parse /ai-dev in multiline", parseProjectCommand("some text\n/ai-dev approve\nmore text")?.type === "approve");

  // -- Project CRUD --
  const p1 = projectState.getOrCreateProject({
    owner: "octo",
    repo: "demo",
    issueNumber: 100,
    title: "Big Feature",
    createdBy: "tester",
  });
  check("project created", p1.created === true);
  check("project initial state is PLANNING", p1.project.state === ProjectState.PLANNING);

  const p2 = projectState.getOrCreateProject({
    owner: "octo",
    repo: "demo",
    issueNumber: 100,
    title: "Big Feature",
    createdBy: "tester",
  });
  check("project duplicate prevention (UNIQUE constraint)", p2.created === false && p2.project.id === p1.project.id);

  // -- Task CRUD --
  const t1 = projectState.createProjectTask({
    projectId: p1.project.id,
    taskIndex: 0,
    title: "Add types",
    description: "Define TypeScript interfaces",
    dependencies: [],
    subtasks: ["Define Project interface", "Define ProjectTask interface"],
  });
  check("task created with READY state (no deps)", t1.state === ProjectTaskState.READY);

  const t2 = projectState.createProjectTask({
    projectId: p1.project.id,
    taskIndex: 1,
    title: "Add storage",
    description: "SQLite tables",
    dependencies: [0],
    subtasks: [],
  });
  check("task with deps created as BLOCKED", t2.state === ProjectTaskState.BLOCKED);

  const t3 = projectState.createProjectTask({
    projectId: p1.project.id,
    taskIndex: 2,
    title: "Add API",
    description: "REST endpoints",
    dependencies: [0, 1],
    subtasks: [],
  });
  check("task with multiple deps created as BLOCKED", t3.state === ProjectTaskState.BLOCKED);

  // -- Dependency-aware task selection --
  let readyTasks = projectState.getNextReadyTasks(p1.project.id);
  check("only task 0 is ready initially", readyTasks.length === 1 && readyTasks[0].taskIndex === 0);

  // Complete task 0 -> task 1 should become READY
  projectState.setTaskState(t1.id, ProjectTaskState.COMPLETED);
  readyTasks = projectState.getNextReadyTasks(p1.project.id);
  check("task 1 promoted to READY after dep 0 completes", readyTasks.length === 1 && readyTasks[0].taskIndex === 1);

  // Complete task 1 -> task 2 should become READY
  projectState.setTaskState(t2.id, ProjectTaskState.COMPLETED);
  readyTasks = projectState.getNextReadyTasks(p1.project.id);
  check("task 2 promoted to READY after deps 0,1 complete", readyTasks.length === 1 && readyTasks[0].taskIndex === 2);

  // -- Completion checks --
  check("project not complete (task 2 still READY)", !projectState.isProjectComplete(p1.project.id));
  projectState.setTaskState(t3.id, ProjectTaskState.COMPLETED);
  check("project complete (all tasks terminal)", projectState.isProjectComplete(p1.project.id));
  check("project successful (all completed)", projectState.isProjectSuccessful(p1.project.id));

  // -- State transitions --
  projectState.setProjectState(p1.project.id, ProjectState.AWAITING_APPROVAL);
  check("project state transition", projectState.getProjectById(p1.project.id)!.state === ProjectState.AWAITING_APPROVAL);

  // -- Config integration --
  check("project mode enabled", config.project.enabled === true);
  check("project label configured", config.project.label === "ai-dev-project");
  check("project max tasks configured", config.project.maxTasks === 50);

  // ---- 6b. Execution engine (secret isolation, config, task updates) ----
  console.log("[execution engine]");
  const { validateSanitizedEnv, ClaudeCodeTaskExecutor, runFinalValidation } = await import("../src/agent/claudeCodeExecutor.js");

  // -- Secret isolation --
  const cleanEnv = {
    HOME: "/home/test",
    PATH: "/usr/bin",
    ANTHROPIC_BASE_URL: "http://192.168.4.38:1234",
    ANTHROPIC_API_KEY: "test-key",
  };
  check("clean env passes validation", validateSanitizedEnv(cleanEnv).length === 0);

  const leakyEnv = {
    ...cleanEnv,
    GITHUB_PRIVATE_KEY: "-----BEGIN RSA-----",
    GITHUB_WEBHOOK_SECRET: "secret123",
  };
  const leaks = validateSanitizedEnv(leakyEnv);
  check("leaky env detected (GITHUB_PRIVATE_KEY)", leaks.includes("GITHUB_PRIVATE_KEY"));
  check("leaky env detected (GITHUB_WEBHOOK_SECRET)", leaks.includes("GITHUB_WEBHOOK_SECRET"));

  const dockerLeakEnv = { ...cleanEnv, DOCKER_HOST: "unix:///var/run/docker.sock" };
  check("DOCKER_HOST leak detected", validateSanitizedEnv(dockerLeakEnv).includes("DOCKER_HOST"));

  const sshLeakEnv = { ...cleanEnv, SSH_AUTH_SOCK: "/tmp/ssh-agent" };
  check("SSH_AUTH_SOCK leak detected", validateSanitizedEnv(sshLeakEnv).includes("SSH_AUTH_SOCK"));

  // -- Executor instantiation --
  const executor = new ClaudeCodeTaskExecutor();
  check("executor instantiates", executor !== null);
  check("executor.canExecute always true", executor.canExecute(t1));

  // -- Task update with new fields --
  const taskWithBranch = projectState.updateProjectTask(t1.id, {
    branch: "project/100/task-1",
    prNumber: 42,
    headSha: "abc123",
    retryCount: 2,
    ciRetryCount: 1,
    worktreePath: "/tmp/wt/test",
  });
  check("task branch persisted", taskWithBranch.branch === "project/100/task-1");
  check("task prNumber persisted", taskWithBranch.prNumber === 42);
  check("task headSha persisted", taskWithBranch.headSha === "abc123");
  check("task retryCount persisted", taskWithBranch.retryCount === 2);
  check("task ciRetryCount persisted", taskWithBranch.ciRetryCount === 1);
  check("task worktreePath persisted", taskWithBranch.worktreePath === "/tmp/wt/test");

  // -- Duplicate prevention (existing branch detection on restart) --
  const dupTask = projectState.getProjectTaskByIndex(p1.project.id, 0);
  check("task retrievable by index for restart recovery", dupTask?.id === t1.id);

  // -- Final validation report generation --
  const report = await runFinalValidation(p1.project);
  check("final validation produces report", report.report.includes("Final Report"));
  check("final validation reports correct task count", report.report.includes(`${3}`));

  // -- Config: Claude Code settings loaded --
  check("claude code timeout configured", config.claudeCode.timeoutMs > 0);
  check("claude code max retries configured", config.claudeCode.maxRetries >= 0);
  check("claude code max changed files configured", config.claudeCode.maxChangedFiles > 0);
  check("claude code max diff bytes configured", config.claudeCode.maxDiffBytes > 0);
  check("claude code worktree dir configured", config.claudeCode.worktreeDir.length > 0);
  check("claude code preserve failed worktrees default true", config.claudeCode.preserveFailedWorktrees === true);

  // ---- 7. HTTP webhook -> orchestrator dispatch (simulated, signed) ----
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
