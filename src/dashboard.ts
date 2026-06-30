import { db } from "./storage/db.js";
import { config } from "./config.js";
import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Data access helpers (raw SQL for the dashboard — read-only)
// ---------------------------------------------------------------------------

interface DashboardPhase {
  id: number;
  projectId: number;
  phaseIndex: number;
  title: string;
  description: string;
  state: string;
  createdAt: string;
  updatedAt: string;
}

interface DashboardProject {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  state: string;
  createdBy: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  tasks: DashboardTask[];
  phases: DashboardPhase[];
}

interface DashboardTask {
  id: number;
  projectId: number;
  taskIndex: number;
  title: string;
  description: string;
  state: string;
  dependencies: string | null;
  lastError: string | null;
  branch: string | null;
  prNumber: number | null;
  retryCount: number;
  ciRetryCount: number;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DashboardModelCall {
  id: number;
  jobId: number | null;
  taskType: string | null;
  model: string | null;
  prompt: string | null;
  response: string | null;
  latencyMs: number | null;
  createdAt: string;
}

interface DashboardJob {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  branch: string | null;
  prNumber: number | null;
  state: string;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

function getAllProjects(): DashboardProject[] {
  const rows = db
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as Array<{
    id: number;
    owner: string;
    repo: string;
    issue_number: number;
    title: string;
    state: string;
    created_by: string;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => {
    const taskRows = db
      .prepare("SELECT * FROM project_tasks WHERE project_id = ? ORDER BY task_index ASC")
      .all(r.id) as Array<{
      id: number;
      project_id: number;
      task_index: number;
      title: string;
      description: string;
      state: string;
      dependencies: string | null;
      last_error: string | null;
      branch: string | null;
      pr_number: number | null;
      retry_count: number;
      ci_retry_count: number;
      worktree_path: string | null;
      created_at: string;
      updated_at: string;
    }>;

    const phaseRows = db
      .prepare("SELECT * FROM project_phases WHERE project_id = ? ORDER BY phase_index ASC")
      .all(r.id) as Array<{
      id: number;
      project_id: number;
      phase_index: number;
      title: string;
      description: string;
      state: string;
      created_at: string;
      updated_at: string;
    }>;

    return {
      id: r.id,
      owner: r.owner,
      repo: r.repo,
      issueNumber: r.issue_number,
      title: r.title,
      state: r.state,
      createdBy: r.created_by,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      tasks: taskRows.map((t) => ({
        id: t.id,
        projectId: t.project_id,
        taskIndex: t.task_index,
        title: t.title,
        description: t.description,
        state: t.state,
        dependencies: t.dependencies,
        lastError: t.last_error,
        branch: t.branch,
        prNumber: t.pr_number,
        retryCount: t.retry_count ?? 0,
        ciRetryCount: t.ci_retry_count ?? 0,
        worktreePath: t.worktree_path,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
      phases: phaseRows.map((ph) => ({
        id: ph.id,
        projectId: ph.project_id,
        phaseIndex: ph.phase_index,
        title: ph.title,
        description: ph.description,
        state: ph.state,
        createdAt: ph.created_at,
        updatedAt: ph.updated_at,
      })),
    };
  });
}

function getRecentModelCalls(limit: number): DashboardModelCall[] {
  const rows = db
    .prepare("SELECT * FROM model_calls ORDER BY id DESC LIMIT ?")
    .all(limit) as Array<{
    id: number;
    job_id: number | null;
    task_type: string | null;
    model: string | null;
    prompt: string | null;
    response: string | null;
    latency_ms: number | null;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    taskType: r.task_type,
    model: r.model,
    prompt: r.prompt,
    response: r.response,
    latencyMs: r.latency_ms,
    createdAt: r.created_at,
  }));
}

function getAllJobs(): DashboardJob[] {
  const rows = db
    .prepare("SELECT * FROM issue_jobs ORDER BY updated_at DESC LIMIT 100")
    .all() as Array<{
    id: number;
    owner: string;
    repo: string;
    issue_number: number;
    title: string;
    branch: string | null;
    pr_number: number | null;
    state: string;
    retry_count: number;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    owner: r.owner,
    repo: r.repo,
    issueNumber: r.issue_number,
    title: r.title,
    branch: r.branch,
    prNumber: r.pr_number,
    state: r.state,
    retryCount: r.retry_count,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

export function handleDashboardProjects(_req: Request, res: Response): void {
  res.json(getAllProjects());
}

export function handleDashboardModelCalls(req: Request, res: Response): void {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(getRecentModelCalls(limit));
}

export function handleDashboardJobs(_req: Request, res: Response): void {
  res.json(getAllJobs());
}

// ---------------------------------------------------------------------------
// HTML dashboard page
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function elapsed(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return `${Math.floor(ms / 86_400_000)}d ${Math.floor((ms % 86_400_000) / 3_600_000)}h`;
}

function truncate(str: string | null, max: number): string {
  if (!str) return "";
  if (str.length <= max) return escapeHtml(str);
  return escapeHtml(str.slice(0, max)) + "...";
}

// Server-side render helpers used for initial page load HTML
function renderProjectsHtml(projects: DashboardProject[]): string {
  if (projects.length === 0) return "<p>No projects</p>";
  return projects.map((p) => {
    const done = p.tasks.filter((t) => t.state === "COMPLETED" || t.state === "SKIPPED").length;
    const total = p.tasks.length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const running = p.tasks.find((t) => t.state === "RUNNING");
    const next = p.tasks.find((t) => t.state === "READY" || t.state === "QUEUED" || t.state === "PENDING");
    const blocked = p.tasks.filter((t) => t.state === "BLOCKED").length;
    return `<div class="proj-card"><div class="proj-top"><span class="badge badge-${p.state.toLowerCase().replace(/_/g, "-")}">${p.state}</span><span class="proj-title">${escapeHtml(p.title)}</span><span class="proj-ref mono">${escapeHtml(p.owner)}/${escapeHtml(p.repo)}#${p.issueNumber}</span></div><div class="proj-bar"><div class="proj-fill" style="width:${pct}%"></div></div><div class="proj-meta"><span>${done}/${total} tasks</span><span>${elapsed(p.createdAt)}</span>${running ? `<span class="running-label">Running: ${escapeHtml(running.title)}</span>` : ""}${next && !running ? `<span>Next: ${escapeHtml(next.title)}</span>` : ""}${blocked > 0 ? `<span>${blocked} blocked</span>` : ""}</div></div>`;
  }).join("");
}

function renderModelCallsHtml(calls: DashboardModelCall[]): string {
  if (calls.length === 0) return "<p>No model calls recorded</p>";
  return calls.map((c) => {
    const provider = (c.model && /claude|anthropic/i.test(c.model)) ? "Bedrock" : "oMLX";
    return `<div class="mc-row"><span class="mc-type mono">${escapeHtml(c.taskType || "-")}</span><span class="mc-model mono">${escapeHtml(c.model || "-")}</span><span class="mc-provider">${provider}</span><span class="mc-latency">${c.latencyMs != null ? c.latencyMs + "ms" : "-"}</span><span class="mc-time">${elapsed(c.createdAt)} ago</span></div>`;
  }).join("");
}

function renderJobsHtml(jobs: DashboardJob[]): string {
  if (jobs.length === 0) return "<p>No jobs</p>";
  return jobs.map((j) => {
    return `<div class="job-card"><div class="job-top"><span class="badge badge-${j.state.toLowerCase().replace(/_/g, "-")}">${j.state}</span><span class="job-title">${escapeHtml(j.title)}</span></div><div class="job-meta"><span class="mono">${escapeHtml(j.owner)}/${escapeHtml(j.repo)}#${j.issueNumber}</span>${j.branch ? `<span class="mono">${escapeHtml(j.branch)}</span>` : ""}${j.prNumber ? `<a href="https://github.com/${escapeHtml(j.owner)}/${escapeHtml(j.repo)}/pull/${j.prNumber}" class="job-pr">PR #${j.prNumber}</a>` : ""}${j.retryCount > 0 ? `<span class="job-retry">Retries: ${j.retryCount}</span>` : ""}<span>${elapsed(j.updatedAt)} ago</span></div>${j.lastError ? `<div class="job-error mono">${truncate(j.lastError, 200)}</div>` : ""}</div>`;
  }).join("");
}

export function renderDashboard(_req: Request, res: Response): void {
  const codingModel = escapeHtml(config.llm.modelPro);
  const planningModel = "Claude Opus (Bedrock)";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
<title>ai-dev</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{font-size:16px}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#09090b;color:#e4e4e7;line-height:1.5;min-width:360px;padding:16px 16px 80px;max-width:1100px;margin:0 auto;-webkit-font-smoothing:antialiased}
.mono{font-family:"SF Mono","JetBrains Mono","Fira Code",Menlo,monospace;font-size:0.8125rem}
a{color:#60a5fa;text-decoration:none}
a:hover{text-decoration:underline}
.hdr{display:flex;align-items:center;justify-content:space-between;padding-bottom:16px;border-bottom:1px solid #27272a;margin-bottom:20px}
.hdr-left{display:flex;align-items:center;gap:10px}
.hdr h1{font-size:1.375rem;font-weight:700;color:#fff}
.live-dot{width:10px;height:10px;border-radius:50%;background:#22c55e;animation:pulse 2s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.hdr-status{font-size:.8125rem;color:#71717a}
.conn-lost{display:none;background:#7f1d1d;color:#fca5a5;padding:10px 16px;border-radius:8px;margin-bottom:16px;font-size:.875rem;font-weight:500}
.conn-lost.visible{display:block}
.tabs{display:flex;gap:4px;margin-bottom:20px;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tab{padding:10px 18px;background:#18181b;border:1px solid #27272a;color:#a1a1aa;cursor:pointer;border-radius:8px;font:inherit;font-size:.875rem;font-weight:500;white-space:nowrap;min-height:44px;transition:background .15s,color .15s,border-color .15s}
.tab.active{background:#27272a;color:#fff;border-color:#3f3f46}
.tab:hover{background:#1f1f23}
.section{margin-bottom:24px}
.section-title{font-size:1rem;font-weight:600;color:#fff;margin-bottom:12px}
.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}
.sum-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px}
.sum-card .sum-count{font-size:1.75rem;font-weight:700;line-height:1.2}
.sum-card .sum-label{font-size:.8125rem;color:#71717a;margin-top:2px}
.sum-blue .sum-count{color:#60a5fa}
.sum-amber .sum-count{color:#fbbf24}
.sum-gray .sum-count{color:#a1a1aa}
.sum-green .sum-count{color:#4ade80}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:.6875rem;font-weight:700;text-transform:uppercase;letter-spacing:.03em}
.badge-running,.badge-implementing{background:#166534;color:#4ade80}
.badge-completed,.badge-merged,.badge-deployed{background:#064e3b;color:#6ee7b7}
.badge-failed{background:#7f1d1d;color:#fca5a5}
.badge-ready,.badge-planning,.badge-parsing{background:#1e3a5f;color:#93c5fd}
.badge-blocked,.badge-paused,.badge-fixing{background:#422006;color:#fdba74}
.badge-awaiting-approval{background:#3b0764;color:#d8b4fe}
.badge-pending,.badge-queued,.badge-cancelled,.badge-skipped,.badge-waiting{background:#27272a;color:#a1a1aa}
.badge-pr-open{background:#3b0764;color:#d8b4fe}
.badge-ci-running{background:#422006;color:#fde047}
.proj-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:background .15s;display:flex;align-items:center}
.proj-card:hover{background:#1f1f23;border-color:#3f3f46}
.proj-card-body{flex:1;min-width:0}
.proj-card .chevron{color:#3f3f46;font-size:1.25rem;margin-left:12px;flex-shrink:0}
.proj-card:hover .chevron{color:#71717a}
.proj-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.proj-title{font-weight:600;font-size:.9375rem;color:#fff}
.proj-ref{font-size:.75rem;color:#71717a}
.proj-bar{height:4px;background:#27272a;border-radius:2px;overflow:hidden;margin-bottom:8px}
.proj-fill{height:100%;background:#4ade80;border-radius:2px;transition:width .3s}
.proj-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:.75rem;color:#71717a}
.proj-meta .running-label{color:#4ade80;font-weight:500}
.running-now-card{display:flex;align-items:center;gap:14px;background:#052e16;border:1px solid #166534;border-radius:10px;padding:16px 18px;margin-bottom:24px}
.running-now-pulse{width:12px;height:12px;border-radius:50%;background:#4ade80;animation:pulse 1.5s ease-in-out infinite;flex-shrink:0}
.running-now-task{font-weight:600;color:#fff;font-size:.9375rem}
.running-now-project{font-size:.8125rem;color:#86efac;margin-top:2px}
.running-now-elapsed{font-size:.75rem;color:#4ade80;margin-top:4px;font-weight:500}
.running-now-idle{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:16px 18px;margin-bottom:24px;color:#71717a;font-size:.875rem}
.attn-grid{display:grid;gap:10px}
.attn-card{display:flex;align-items:flex-start;gap:12px;background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px}
.attn-icon{font-size:1.25rem;line-height:1;flex-shrink:0;margin-top:2px}
.attn-failed .attn-icon{color:#f87171}
.attn-stalled .attn-icon{color:#fbbf24}
.attn-approval .attn-icon{color:#a78bfa}
.attn-ci .attn-icon{color:#fb923c}
.attn-title{font-weight:600;font-size:.875rem;color:#fff}
.attn-desc{font-size:.8125rem;color:#d4d4d8;margin-top:2px}
.attn-ctx{font-size:.75rem;color:#71717a;margin-top:4px}
.activity-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #1f1f23}
.activity-row:last-child{border-bottom:none}
.activity-icon{font-size:.5rem;color:#3f3f46}
.activity-msg{flex:1;font-size:.8125rem;color:#d4d4d8}
.activity-time{font-size:.75rem;color:#71717a;white-space:nowrap}
.mc-row{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid #1f1f23;cursor:pointer;transition:background .1s;min-height:44px;flex-wrap:wrap}
.mc-row:hover{background:#1f1f23}
.mc-type{width:90px;flex-shrink:0;font-weight:500;color:#93c5fd;font-size:.75rem}
.mc-model{flex:1;min-width:100px;color:#d4d4d8;font-size:.75rem}
.mc-provider{width:60px;color:#a1a1aa;font-size:.75rem}
.mc-latency{width:60px;text-align:right;color:#fbbf24;font-size:.75rem}
.mc-time{width:70px;text-align:right;color:#71717a;font-size:.75rem}
.mc-expand{display:none;padding:12px 14px;background:#09090b;border-bottom:1px solid #1f1f23}
.mc-expand.open{display:block}
.mc-expand pre{font-family:"SF Mono","JetBrains Mono",monospace;font-size:.75rem;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;color:#a1a1aa;margin-top:8px;padding:10px;background:#0f0f12;border-radius:6px}
.mc-expand-label{font-size:.6875rem;color:#71717a;text-transform:uppercase;font-weight:600;letter-spacing:.05em}
.mc-copy-btn{display:inline-block;padding:4px 10px;background:#27272a;border:1px solid #3f3f46;border-radius:4px;color:#a1a1aa;font-size:.6875rem;cursor:pointer;margin-left:8px;min-height:28px}
.mc-copy-btn:hover{background:#3f3f46;color:#fff}
.job-card{background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:10px}
.job-top{display:flex;align-items:center;gap:10px;margin-bottom:6px;flex-wrap:wrap}
.job-title{font-weight:600;font-size:.875rem;color:#fff}
.job-meta{display:flex;gap:12px;flex-wrap:wrap;font-size:.75rem;color:#71717a}
.job-pr{color:#60a5fa;text-decoration:none}
.job-pr:hover{text-decoration:underline}
.job-retry{color:#fbbf24}
.job-error{margin-top:8px;padding:8px 10px;background:#1c1017;border:1px solid #7f1d1d;border-radius:6px;color:#fca5a5;font-size:.75rem}
.health-row{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 16px;background:#18181b;border:1px solid #27272a;border-radius:10px}
.health-item{display:flex;align-items:center;gap:6px;font-size:.8125rem}
.health-dot{width:8px;height:8px;border-radius:50%}
.health-ok{background:#4ade80}
.health-warn{background:#fbbf24}
.health-err{background:#f87171}
.health-unknown{background:#71717a}
.back-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;background:#18181b;border:1px solid #27272a;border-radius:8px;color:#a1a1aa;font-size:.875rem;cursor:pointer;margin-bottom:16px;min-height:44px;transition:background .15s}
.back-btn:hover{background:#27272a;color:#fff}
.detail-header{margin-bottom:20px}
.detail-title{font-size:1.25rem;font-weight:700;color:#fff;margin-bottom:8px}
.detail-meta{display:flex;gap:12px;flex-wrap:wrap;align-items:center;font-size:.8125rem;color:#71717a}
.task-row{display:flex;align-items:center;gap:10px;padding:12px 14px;background:#18181b;border:1px solid #27272a;border-radius:8px;margin-bottom:6px;cursor:pointer;transition:background .15s;min-height:44px}
.task-row:hover{background:#1f1f23;border-color:#3f3f46}
.task-icon{flex-shrink:0;font-size:.875rem}
.task-body{flex:1;min-width:0}
.task-title-text{font-size:.875rem;color:#e4e4e7;font-weight:500}
.task-meta-row{font-size:.75rem;color:#71717a;margin-top:2px}
.task-chevron{color:#3f3f46;flex-shrink:0}
.action-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:8px;font-size:.8125rem;font-weight:600;cursor:pointer;min-height:44px;border:1px solid;transition:background .15s,color .15s}
.action-btn-approve{background:#052e16;border-color:#166534;color:#4ade80}
.action-btn-approve:hover{background:#166534}
.action-btn-pause{background:#422006;border-color:#854d0e;color:#fbbf24}
.action-btn-pause:hover{background:#854d0e}
.action-btn-resume{background:#1e3a5f;border-color:#1d4ed8;color:#93c5fd}
.action-btn-resume:hover{background:#1d4ed8}
.action-btn-cancel{background:#7f1d1d;border-color:#991b1b;color:#fca5a5}
.action-btn-cancel:hover{background:#991b1b}
.action-btn-retry{background:#1e3a5f;border-color:#1d4ed8;color:#93c5fd}
.action-btn-retry:hover{background:#1d4ed8}
.actions-row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
.collapsible-header{display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 14px;background:#18181b;border:1px solid #27272a;border-radius:8px;font-size:.8125rem;color:#a1a1aa;min-height:44px}
.collapsible-header:hover{background:#1f1f23}
.collapsible-body{display:none;padding:12px 14px;background:#0f0f12;border:1px solid #27272a;border-top:none;border-radius:0 0 8px 8px;margin-top:-1px}
.collapsible-body.open{display:block}
.copy-btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;background:#27272a;border:1px solid #3f3f46;border-radius:4px;color:#a1a1aa;font-size:.6875rem;cursor:pointer;min-height:28px}
.copy-btn:hover{background:#3f3f46;color:#fff}
.error-box{background:#1c1017;border:1px solid #7f1d1d;border-radius:8px;padding:12px 14px;margin-top:12px}
.error-box-title{font-size:.75rem;color:#fca5a5;font-weight:600;margin-bottom:4px}
.error-box-text{font-size:.75rem;color:#fca5a5;white-space:pre-wrap;word-break:break-all}
.bottom-nav{display:none;position:fixed;bottom:0;left:0;right:0;height:56px;background:#18181b;border-top:1px solid #27272a;z-index:100}
.bottom-nav-inner{display:flex;height:100%;max-width:1100px;margin:0 auto}
.nav-item{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:#71717a;font-size:.625rem;min-height:44px;transition:color .15s}
.nav-item.active{color:#60a5fa}
.nav-item:hover{color:#a1a1aa}
.nav-icon{font-size:1.125rem}
@media(max-width:768px){
  .summary{grid-template-columns:repeat(2,1fr)}
  .tabs{display:none}
  .bottom-nav{display:block}
  body{padding-bottom:72px}
}
@media(max-width:480px){
  body{padding:12px 12px 72px;font-size:.9375rem}
  .hdr h1{font-size:1.125rem}
  .summary{grid-template-columns:repeat(2,1fr);gap:8px}
  .sum-card{padding:12px}
  .sum-card .sum-count{font-size:1.5rem}
}
</style>
</head>
<body>
<div class="hdr">
  <div class="hdr-left"><div class="live-dot"></div><h1>ai-dev</h1></div>
  <span class="hdr-status" id="hdr-status">Live &middot; Updated 0s ago</span>
</div>
<div class="conn-lost" id="conn-lost">Connection lost &mdash; retrying...</div>
<div class="tabs" id="tabs"></div>
<div id="app"></div>
<div class="bottom-nav" id="bottom-nav"></div>
<script>
(function() {
  var DATA = { projects: [], calls: [], jobs: [], health: null, omlx: null };
  var lastRefreshTime = Date.now();
  var connected = true;
  var codingModel = "${codingModel}";
  var planningModel = "${planningModel}";

  function escapeHtml(s) {
    if (!s) return "";
    var d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }
  function elapsed(iso) {
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 60000) return Math.floor(ms / 1000) + "s";
    if (ms < 3600000) return Math.floor(ms / 60000) + "m";
    if (ms < 86400000) return Math.floor(ms / 3600000) + "h " + Math.floor((ms % 3600000) / 60000) + "m";
    return Math.floor(ms / 86400000) + "d " + Math.floor((ms % 86400000) / 3600000) + "h";
  }
  function truncate(s, max) {
    if (!s) return "";
    if (s.length <= max) return escapeHtml(s);
    return escapeHtml(s.slice(0, max)) + "...";
  }
  function badgeClass(state) { return "badge badge-" + state.toLowerCase().replace(/_/g, "-"); }
  function stateIcon(state) {
    if (state === "RUNNING" || state === "IMPLEMENTING") return '<span style="color:#60a5fa">&#9679;</span>';
    if (state === "COMPLETED" || state === "MERGED") return '<span style="color:#4ade80">&#10003;</span>';
    if (state === "FAILED") return '<span style="color:#f87171">&#10005;</span>';
    if (state === "READY" || state === "PLANNING") return '<span style="color:#a1a1aa">&#9675;</span>';
    if (state === "WAITING" || state === "BLOCKED" || state === "PENDING" || state === "QUEUED") return '<span style="color:#71717a">&#9203;</span>';
    return '<span style="color:#71717a">&#9675;</span>';
  }
  function findProject(id) {
    for (var i = 0; i < DATA.projects.length; i++) { if (DATA.projects[i].id === id) return DATA.projects[i]; }
    return null;
  }
  function findTask(id) {
    for (var i = 0; i < DATA.projects.length; i++) {
      for (var j = 0; j < DATA.projects[i].tasks.length; j++) {
        if (DATA.projects[i].tasks[j].id === id) return { project: DATA.projects[i], task: DATA.projects[i].tasks[j] };
      }
    }
    return null;
  }
  function nav(hash) { window.location.hash = hash; }
  function getRoute() {
    var h = window.location.hash || "#home";
    if (h.indexOf("#project/") === 0) return { view: "project", id: parseInt(h.slice(9), 10) };
    if (h.indexOf("#task/") === 0) return { view: "task", id: parseInt(h.slice(6), 10) };
    if (h === "#model-calls") return { view: "model-calls", id: 0 };
    if (h === "#jobs") return { view: "jobs", id: 0 };
    if (h === "#health") return { view: "health", id: 0 };
    return { view: "home", id: 0 };
  }

  function renderTabs() {
    var route = getRoute();
    var items = [
      { hash: "#home", label: "Home" },
      { hash: "#model-calls", label: "Model Calls" },
      { hash: "#jobs", label: "Jobs" },
      { hash: "#health", label: "Health" }
    ];
    var html = "";
    for (var i = 0; i < items.length; i++) {
      var active = (items[i].hash === "#" + route.view) || (items[i].hash === "#home" && route.view === "home");
      html += '<button class="tab' + (active ? " active" : "") + '" data-hash="' + items[i].hash + '">' + items[i].label + '</button>';
    }
    document.getElementById("tabs").innerHTML = html;
  }

  function renderBottomNav() {
    var route = getRoute();
    var items = [
      { hash: "#home", icon: "&#9679;", label: "Home" },
      { hash: "#home", icon: "&#9881;", label: "Projects" },
      { hash: "#model-calls", icon: "&#9889;", label: "Activity" },
      { hash: "#health", icon: "&#9829;", label: "Health" },
      { hash: "#jobs", icon: "&#8943;", label: "More" }
    ];
    var html = '<div class="bottom-nav-inner">';
    for (var i = 0; i < items.length; i++) {
      var active = (items[i].hash === "#" + route.view) || (items[i].hash === "#home" && (route.view === "home" || route.view === "project" || route.view === "task"));
      html += '<div class="nav-item' + (active ? " active" : "") + '" data-hash="' + items[i].hash + '"><span class="nav-icon">' + items[i].icon + '</span>' + items[i].label + '</div>';
    }
    html += '</div>';
    document.getElementById("bottom-nav").innerHTML = html;
  }

  function renderHome() {
    var projects = DATA.projects;
    var running = 0, completed = 0, queued = 0, attention = 0;
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (p.state === "RUNNING") running++;
      if (p.state === "COMPLETED") completed++;
      if (p.state === "QUEUED" || p.state === "PENDING" || p.state === "PLANNING") queued++;
      if (p.state === "AWAITING_APPROVAL") attention++;
      for (var j = 0; j < p.tasks.length; j++) {
        if (p.tasks[j].state === "FAILED") attention++;
        if (p.tasks[j].state === "RUNNING" && (Date.now() - new Date(p.tasks[j].updatedAt).getTime() > 600000)) attention++;
      }
    }
    var html = '<div class="summary">';
    html += '<div class="sum-card sum-blue"><div class="sum-count">' + running + '</div><div class="sum-label">Running</div></div>';
    html += '<div class="sum-card sum-amber"><div class="sum-count">' + attention + '</div><div class="sum-label">Needs Attention</div></div>';
    html += '<div class="sum-card sum-gray"><div class="sum-count">' + queued + '</div><div class="sum-label">Queued</div></div>';
    html += '<div class="sum-card sum-green"><div class="sum-count">' + completed + '</div><div class="sum-label">Completed</div></div>';
    html += '</div>';
    // Attention items
    var attnItems = [];
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      if (p.state === "AWAITING_APPROVAL") attnItems.push('<div class="attn-card attn-approval"><span class="attn-icon">&#9998;</span><div class="attn-body"><div class="attn-title">Awaiting Approval</div><div class="attn-desc">' + escapeHtml(p.title) + '</div><div class="attn-ctx">' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '#' + p.issueNumber + '</div></div></div>');
      for (var j = 0; j < p.tasks.length; j++) {
        var t = p.tasks[j];
        if (t.state === "FAILED") attnItems.push('<div class="attn-card attn-failed"><span class="attn-icon">&#10007;</span><div class="attn-body"><div class="attn-title">Task Failed</div><div class="attn-desc">' + escapeHtml(t.title) + '</div><div class="attn-ctx">' + escapeHtml(p.title) + ' &middot; ' + elapsed(t.updatedAt) + ' ago</div></div></div>');
        if (t.state === "RUNNING" && (Date.now() - new Date(t.updatedAt).getTime() > 600000)) attnItems.push('<div class="attn-card attn-stalled"><span class="attn-icon">&#9888;</span><div class="attn-body"><div class="attn-title">Stalled &gt; 10 min</div><div class="attn-desc">' + escapeHtml(t.title) + '</div><div class="attn-ctx">' + escapeHtml(p.title) + ' &middot; ' + elapsed(t.updatedAt) + ' running</div></div></div>');
      }
    }
    if (attnItems.length > 0) html += '<section class="section"><h2 class="section-title">Needs Attention</h2><div class="attn-grid">' + attnItems.join("") + '</div></section>';
    // Running now
    html += '<section class="section"><h2 class="section-title">Running Now</h2>';
    var foundRunning = false;
    for (var i = 0; i < projects.length && !foundRunning; i++) {
      for (var j = 0; j < projects[i].tasks.length; j++) {
        if (projects[i].tasks[j].state === "RUNNING") {
          var rt = projects[i].tasks[j]; var rp = projects[i];
          html += '<div class="running-now-card"><div class="running-now-pulse"></div><div class="running-now-info"><div class="running-now-task">' + escapeHtml(rt.title) + '</div><div class="running-now-project">' + escapeHtml(rp.title) + ' &middot; ' + escapeHtml(rp.owner) + '/' + escapeHtml(rp.repo) + '#' + rp.issueNumber + '</div><div class="running-now-elapsed">' + elapsed(rt.updatedAt) + ' elapsed</div></div></div>';
          foundRunning = true; break;
        }
      }
    }
    if (!foundRunning) html += '<div class="running-now-idle"><span style="color:#3f3f46">&#9679;</span> Idle &mdash; waiting for work</div>';
    html += '</section>';
    // Projects
    html += '<section class="section"><h2 class="section-title">Active Projects</h2>';
    if (!projects.length) { html += '<p style="color:#71717a">No projects</p>'; }
    else {
      for (var i = 0; i < projects.length; i++) {
        var p = projects[i];
        var done = 0, total = p.tasks.length, runLabel = "", nextLabel = "", blocked = 0;
        for (var j = 0; j < p.tasks.length; j++) {
          if (p.tasks[j].state === "COMPLETED" || p.tasks[j].state === "SKIPPED") done++;
          if (p.tasks[j].state === "RUNNING" && !runLabel) runLabel = p.tasks[j].title;
          if ((p.tasks[j].state === "READY" || p.tasks[j].state === "QUEUED" || p.tasks[j].state === "PENDING") && !nextLabel) nextLabel = p.tasks[j].title;
          if (p.tasks[j].state === "BLOCKED") blocked++;
        }
        var pct = total > 0 ? Math.round((done / total) * 100) : 0;
        html += '<div class="proj-card" data-nav="#project/' + p.id + '"><div class="proj-card-body"><div class="proj-top"><span class="' + badgeClass(p.state) + '">' + p.state + '</span><span class="proj-title">' + escapeHtml(p.title) + '</span><span class="proj-ref mono">' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '#' + p.issueNumber + '</span></div><div class="proj-bar"><div class="proj-fill" style="width:' + pct + '%"></div></div><div class="proj-meta"><span>' + done + '/' + total + ' tasks</span><span>' + elapsed(p.createdAt) + '</span>' + (runLabel ? '<span class="running-label">Running: ' + escapeHtml(runLabel) + '</span>' : '') + (!runLabel && nextLabel ? '<span>Next: ' + escapeHtml(nextLabel) + '</span>' : '') + (blocked > 0 ? '<span>' + blocked + ' blocked</span>' : '') + '</div></div><span class="chevron">&#8250;</span></div>';
      }
    }
    html += '</section>';
    // Recent activity
    html += '<section class="section"><h2 class="section-title">Recent Activity</h2>';
    if (!DATA.calls.length) { html += '<p style="color:#71717a">No recent activity</p>'; }
    else {
      var items = DATA.calls.slice(0, 10);
      for (var i = 0; i < items.length; i++) {
        html += '<div class="activity-row"><span class="activity-icon">&#9679;</span><span class="activity-msg">' + escapeHtml(items[i].taskType || "Call") + ' &middot; ' + escapeHtml(items[i].model || "unknown") + '</span><span class="activity-time">' + elapsed(items[i].createdAt) + ' ago</span></div>';
      }
    }
    html += '</section>';
    // Health summary
    html += '<section class="section"><h2 class="section-title">System Health</h2><div class="health-row">';
    html += '<div class="health-item"><span class="health-dot health-ok"></span>ai-dev</div>';
    var omlxClass = "health-unknown", ghClass = "health-unknown";
    if (DATA.health) {
      omlxClass = (DATA.health.omlx && DATA.health.omlx.reachable) ? "health-ok" : "health-err";
      ghClass = (DATA.health.github && DATA.health.github.configured) ? "health-ok" : "health-warn";
    }
    html += '<div class="health-item"><span class="health-dot ' + omlxClass + '"></span>oMLX</div>';
    html += '<div class="health-item"><span class="health-dot ' + ghClass + '"></span>GitHub</div>';
    html += '<div class="health-item"><span class="health-dot health-ok"></span>SQLite</div>';
    html += '<div style="margin-left:auto;font-size:.75rem;color:#71717a">Model: <span class="mono" style="color:#a1a1aa">' + escapeHtml(codingModel) + '</span></div>';
    html += '</div></section>';
    return html;
  }

  function renderProjectDetail(id) {
    var p = findProject(id);
    if (!p) return '<div class="back-btn" data-nav="#home">&larr; Back</div><p style="color:#71717a">Project not found</p>';
    var done = 0, total = p.tasks.length;
    for (var i = 0; i < p.tasks.length; i++) { if (p.tasks[i].state === "COMPLETED" || p.tasks[i].state === "SKIPPED") done++; }
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    var html = '<div class="back-btn" data-nav="#home">&larr; Back</div>';
    html += '<div class="detail-header"><div class="detail-title">' + escapeHtml(p.title) + '</div>';
    html += '<div class="detail-meta"><span class="' + badgeClass(p.state) + '">' + p.state + '</span>';
    html += '<a href="https://github.com/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '" target="_blank" rel="noopener">' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '</a>';
    html += '<a href="https://github.com/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '/issues/' + p.issueNumber + '" target="_blank" rel="noopener">#' + p.issueNumber + '</a>';
    html += '</div></div>';
    // Models
    html += '<div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:20px">';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px"><span style="font-size:.8125rem;color:#71717a">Planning</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(planningModel) + '</span></div>';
    html += '<div style="display:flex;justify-content:space-between"><span style="font-size:.8125rem;color:#71717a">Coding</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(codingModel) + ' (oMLX)</span></div>';
    html += '</div>';
    // Status explanation + actions (prominent when paused/failed)
    if (p.state === "PAUSED" || p.state === "FAILED" || p.state === "AWAITING_APPROVAL") {
      var statusBg = p.state === "FAILED" ? "#1c1017" : p.state === "PAUSED" ? "#1a1500" : "#0f1a2e";
      var statusBorder = p.state === "FAILED" ? "#7f1d1d" : p.state === "PAUSED" ? "#854d0e" : "#1d4ed8";
      var statusIcon = p.state === "FAILED" ? "&#10060;" : p.state === "PAUSED" ? "&#9208;" : "&#9203;";
      var statusMsg = p.state === "FAILED" ? "Project failed" : p.state === "PAUSED" ? "Project is paused" : "Awaiting your approval";
      var statusDetail = p.lastError ? p.lastError : p.state === "PAUSED" ? "Paused by user or system. Resume to continue execution." : p.state === "AWAITING_APPROVAL" ? "Review the plan above, then approve to start execution." : "An error occurred during execution.";
      html += '<div style="background:' + statusBg + ';border:1px solid ' + statusBorder + ';border-radius:10px;padding:16px;margin-bottom:20px">';
      html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><span style="font-size:1.2rem">' + statusIcon + '</span><span style="font-size:.9375rem;font-weight:600;color:#e4e4e7">' + statusMsg + '</span></div>';
      html += '<p style="font-size:.8125rem;color:#a1a1aa;margin-bottom:12px">' + escapeHtml(statusDetail).slice(0, 300) + '</p>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
      if (p.state === "AWAITING_APPROVAL") html += '<button class="action-btn action-btn-approve" data-action="approve" data-pid="' + p.id + '">&#10003; Approve &amp; Start</button>';
      if (p.state === "PAUSED") html += '<button class="action-btn action-btn-resume" data-action="resume" data-pid="' + p.id + '">&#9654; Resume</button>';
      if (p.state === "FAILED") html += '<button class="action-btn action-btn-resume" data-action="resume" data-pid="' + p.id + '">&#8635; Retry</button>';
      html += '<button class="action-btn action-btn-cancel" data-action="cancel" data-pid="' + p.id + '">Cancel</button>';
      html += '</div></div>';
    }
    // Phase progress (if phased project)
    var phases = p.phases || [];
    if (phases.length > 0) {
      var completedPhases = 0, runningPhase = null;
      for (var i = 0; i < phases.length; i++) {
        if (phases[i].state === "COMPLETED") completedPhases++;
        if (phases[i].state === "RUNNING" && !runningPhase) runningPhase = phases[i];
      }
      var phaseProgress = runningPhase && total > 0 ? done / total : 0;
      var overallPct = Math.round(((completedPhases + phaseProgress) / phases.length) * 100);
      html += '<div style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">Overall Progress</span><span style="color:#a1a1aa">' + overallPct + '% (Phase ' + (completedPhases + (runningPhase ? 1 : 0)) + ' of ' + phases.length + ')</span></div>';
      html += '<div class="proj-bar" style="height:6px"><div class="proj-fill" style="width:' + overallPct + '%"></div></div></div>';
      html += '<section class="section"><h2 class="section-title">Phases</h2>';
      for (var i = 0; i < phases.length; i++) {
        var ph = phases[i];
        var phBadgeColor = ph.state === "RUNNING" ? "#1d4ed8" : ph.state === "COMPLETED" ? "#166534" : ph.state === "FAILED" ? "#991b1b" : "#27272a";
        var phTextColor = ph.state === "RUNNING" ? "#93c5fd" : ph.state === "COMPLETED" ? "#4ade80" : ph.state === "FAILED" ? "#fca5a5" : "#a1a1aa";
        var phIcon = ph.state === "RUNNING" ? "&#9679;" : ph.state === "COMPLETED" ? "&#10003;" : ph.state === "FAILED" ? "&#10005;" : "&#9675;";
        var phOpen = (runningPhase && ph.phaseIndex === runningPhase.phaseIndex) ? " open" : "";
        var phBorderLeft = ph.state === "RUNNING" ? "border-left:3px solid #3b82f6;" : ph.state === "COMPLETED" ? "border-left:3px solid #22c55e;" : ph.state === "FAILED" ? "border-left:3px solid #ef4444;" : "border-left:3px solid #3f3f46;";
        html += '<details style="margin-bottom:8px"' + phOpen + '><summary style="display:flex;align-items:center;gap:10px;padding:12px 16px;background:#18181b;border:1px solid #27272a;border-radius:10px;cursor:pointer;list-style:none;min-height:44px;' + phBorderLeft + '">';
        html += '<span style="color:' + phTextColor + ';font-size:1rem">' + phIcon + '</span>';
        html += '<div style="flex:1"><span style="font-size:.875rem;color:#e4e4e7;font-weight:600">Phase ' + (ph.phaseIndex + 1) + ': ' + escapeHtml(ph.title) + '</span>';
        // Show task count for this phase if running
        if (ph.state === "RUNNING" && p.tasks.length > 0) {
          var phaseDone = 0; for (var ti = 0; ti < p.tasks.length; ti++) { if (p.tasks[ti].state === "COMPLETED" || p.tasks[ti].state === "SKIPPED") phaseDone++; }
          html += '<div style="font-size:.75rem;color:#71717a;margin-top:2px">' + phaseDone + '/' + p.tasks.length + ' tasks</div>';
        }
        html += '</div>';
        html += '<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:.6875rem;font-weight:700;background:' + phBadgeColor + ';color:' + phTextColor + '">' + ph.state + '</span>';
        html += '</summary>';
        // Phase expanded content
        html += '<div style="padding:14px 16px;background:#0f0f12;border:1px solid #27272a;border-top:none;border-radius:0 0 10px 10px">';
        // Description
        html += '<div style="font-size:.8125rem;color:#a1a1aa;margin-bottom:12px;white-space:pre-wrap">' + escapeHtml(ph.description) + '</div>';
        // Tasks for this phase (if it's the running phase)
        if (ph.state === "RUNNING" && p.tasks.length > 0) {
          html += '<div style="border-top:1px solid #27272a;padding-top:12px;margin-top:8px">';
          html += '<div style="font-size:.75rem;font-weight:600;color:#71717a;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Tasks</div>';
          for (var ti = 0; ti < p.tasks.length; ti++) {
            var t = p.tasks[ti];
            var tIcon = t.state === "RUNNING" ? '<span style="color:#60a5fa">&#9679;</span>' : t.state === "COMPLETED" ? '<span style="color:#4ade80">&#10003;</span>' : t.state === "FAILED" ? '<span style="color:#f87171">&#10005;</span>' : t.state === "SKIPPED" ? '<span style="color:#71717a">&#8594;</span>' : '<span style="color:#52525b">&#9675;</span>';
            var tBg = t.state === "RUNNING" ? "background:#0f1a2e;" : "";
            var tColor = t.state === "RUNNING" ? "color:#e4e4e7;font-weight:500;" : "color:#a1a1aa;";
            html += '<div data-nav="#task/' + t.id + '" style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;cursor:pointer;min-height:40px;' + tBg + '" class="task-row">';
            html += tIcon;
            html += '<span style="flex:1;font-size:.8125rem;' + tColor + '">' + (t.taskIndex + 1) + '. ' + escapeHtml(t.title) + '</span>';
            if (t.prNumber) html += '<a href="https://github.com/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '/pull/' + t.prNumber + '" target="_blank" rel="noopener" style="color:#60a5fa;font-size:.75rem">PR #' + t.prNumber + '</a>';
            if (t.state === "RUNNING") html += '<span style="color:#60a5fa;font-size:.6875rem">' + elapsed(t.updatedAt) + '</span>';
            if (t.state === "FAILED") html += '<span style="color:#f87171;font-size:.6875rem">failed</span>';
            html += '</div>';
            if (t.lastError && (t.state === "FAILED" || t.state === "SKIPPED")) html += '<div style="font-size:.75rem;color:#f87171;padding:4px 10px 4px 36px;margin-bottom:4px">' + escapeHtml(t.lastError).slice(0, 150) + '</div>';
          }
          html += '</div>';
        }
        // For completed phases, show summary
        if (ph.state === "COMPLETED") {
          html += '<div style="border-top:1px solid #27272a;padding-top:8px;margin-top:8px;font-size:.75rem;color:#4ade80">&#10003; All tasks completed and merged</div>';
        }
        if (ph.state === "FAILED") {
          html += '<div style="border-top:1px solid #27272a;padding-top:8px;margin-top:8px;font-size:.75rem;color:#f87171">&#10005; Phase failed — some tasks could not complete</div>';
        }
        html += '</div></details>';
      }
      html += '</section>';
    } else {
      // Non-phased: show simple progress
      html += '<div style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">Progress</span><span style="color:#a1a1aa">' + done + '/' + total + ' tasks (' + pct + '%)</span></div>';
      html += '<div class="proj-bar" style="height:6px"><div class="proj-fill" style="width:' + pct + '%"></div></div></div>';
    }
    // Task list grouped by state
    if (phases.length > 0 && p.tasks.length > 0) {
      var currentPhaseTitle = runningPhase ? runningPhase.title : "Current Phase";
      html += '<section class="section"><h2 class="section-title">Tasks: ' + escapeHtml(currentPhaseTitle) + '</h2></section>';
    }
    var groups = [
      { label: "Running", states: ["RUNNING", "IMPLEMENTING", "CI_RUNNING"] },
      { label: "Failed", states: ["FAILED"] },
      { label: "Ready", states: ["READY", "PLANNING", "PARSING"] },
      { label: "Completed", states: ["COMPLETED", "MERGED", "SKIPPED"] },
      { label: "Waiting", states: ["WAITING", "BLOCKED", "PENDING", "QUEUED"] }
    ];
    for (var g = 0; g < groups.length; g++) {
      var groupTasks = [];
      for (var i = 0; i < p.tasks.length; i++) {
        for (var s = 0; s < groups[g].states.length; s++) {
          if (p.tasks[i].state === groups[g].states[s]) { groupTasks.push(p.tasks[i]); break; }
        }
      }
      if (groupTasks.length === 0) continue;
      html += '<section class="section"><h2 class="section-title">' + groups[g].label + ' (' + groupTasks.length + ')</h2>';
      for (var i = 0; i < groupTasks.length; i++) {
        var t = groupTasks[i];
        var prLink = t.prNumber ? ' <a href="https://github.com/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '/pull/' + t.prNumber + '" target="_blank" rel="noopener" style="color:#60a5fa">PR #' + t.prNumber + '</a>' : '';
        html += '<div class="task-row" data-nav="#task/' + t.id + '"><span class="task-icon">' + stateIcon(t.state) + '</span><div class="task-body"><div class="task-title-text">' + t.taskIndex + '. ' + escapeHtml(t.title) + '</div><div class="task-meta-row">' + elapsed(t.updatedAt) + ' ago' + prLink + '</div></div><span class="task-chevron">&#8250;</span></div>';
      }
      html += '</section>';
    }
    // Actions
    html += '<div class="actions-row">';
    if (p.state === "AWAITING_APPROVAL") html += '<button class="action-btn action-btn-approve" data-action="approve" data-pid="' + p.id + '">Approve</button>';
    if (p.state === "RUNNING") html += '<button class="action-btn action-btn-pause" data-action="pause" data-pid="' + p.id + '">Pause</button>';
    if (p.state === "PAUSED") html += '<button class="action-btn action-btn-resume" data-action="resume" data-pid="' + p.id + '">Resume</button>';
    if (p.state !== "COMPLETED" && p.state !== "CANCELLED") html += '<button class="action-btn action-btn-cancel" data-action="cancel" data-pid="' + p.id + '">Cancel</button>';
    html += '</div>';
    return html;
  }

  function renderTaskDetail(id) {
    var found = findTask(id);
    if (!found) return '<div class="back-btn" data-nav="#home">&larr; Back</div><p style="color:#71717a">Task not found</p>';
    var t = found.task; var p = found.project;
    var html = '<div class="back-btn" data-nav="#project/' + p.id + '">&larr; ' + escapeHtml(p.title) + '</div>';
    html += '<div class="detail-header"><div class="detail-title">' + t.taskIndex + '. ' + escapeHtml(t.title) + '</div>';
    html += '<div class="detail-meta"><span class="' + badgeClass(t.state) + '">' + t.state + '</span></div></div>';
    if (t.description) html += '<div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:.8125rem;color:#d4d4d8;white-space:pre-wrap">' + escapeHtml(t.description) + '</div>';
    // Execution info
    html += '<section class="section"><h2 class="section-title">Execution</h2><div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px">';
    if (t.branch) html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">Branch</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(t.branch) + '</span></div>';
    if (t.prNumber) html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">PR</span><a href="https://github.com/' + escapeHtml(p.owner) + '/' + escapeHtml(p.repo) + '/pull/' + t.prNumber + '" target="_blank" rel="noopener">#' + t.prNumber + '</a></div>';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">Retries</span><span style="color:#d4d4d8">' + t.retryCount + '</span></div>';
    html += '<div style="display:flex;justify-content:space-between;font-size:.8125rem"><span style="color:#71717a">CI Retries</span><span style="color:#d4d4d8">' + t.ciRetryCount + '</span></div>';
    html += '</div></section>';
    // Error
    if (t.lastError) {
      html += '<div class="error-box"><div class="error-box-title">Error</div><div class="error-box-text mono">' + escapeHtml(t.lastError) + '</div></div>';
    }
    // Retry button
    if (t.state === "FAILED") {
      html += '<div class="actions-row"><button class="action-btn action-btn-retry" data-task-action="retry" data-tid="' + t.id + '">Retry Task</button></div>';
    }
    // Technical details
    if (t.worktreePath) {
      html += '<div style="margin-top:16px"><div class="collapsible-header" data-collapse="tech-' + t.id + '">&#9660; Technical Details</div>';
      html += '<div class="collapsible-body" id="collapse-tech-' + t.id + '"><div style="display:flex;align-items:center;gap:8px;font-size:.8125rem"><span style="color:#71717a">Worktree:</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(t.worktreePath) + '</span><span class="copy-btn" data-copy="' + escapeHtml(t.worktreePath) + '">Copy</span></div></div></div>';
    }
    return html;
  }

  function renderModelCallsView() {
    var calls = DATA.calls;
    if (!calls.length) return '<p style="color:#71717a">No model calls recorded</p>';
    var html = '';
    for (var i = 0; i < calls.length; i++) {
      var c = calls[i];
      var provider = (c.model && /claude|anthropic/i.test(c.model)) ? "Bedrock" : "oMLX";
      html += '<div class="mc-row" data-mc-idx="' + i + '"><span class="mc-type mono">' + escapeHtml(c.taskType || "-") + '</span><span class="mc-model mono">' + escapeHtml(c.model || "-") + '</span><span class="mc-provider">' + provider + '</span><span class="mc-latency">' + (c.latencyMs != null ? c.latencyMs + "ms" : "-") + '</span><span class="mc-time">' + elapsed(c.createdAt) + ' ago</span></div>';
      html += '<div class="mc-expand" id="mc-expand-' + i + '"><div style="display:flex;align-items:center;gap:8px"><span class="mc-expand-label">Prompt</span><span class="mc-copy-btn" data-copy-field="prompt" data-mc-copy="' + i + '">Copy</span></div><pre>' + escapeHtml(c.prompt || "(empty)") + '</pre><div style="margin-top:12px;display:flex;align-items:center;gap:8px"><span class="mc-expand-label">Response</span><span class="mc-copy-btn" data-copy-field="response" data-mc-copy="' + i + '">Copy</span></div><pre>' + escapeHtml(c.response || "(empty)") + '</pre></div>';
    }
    return html;
  }

  function renderJobsView() {
    var jobs = DATA.jobs;
    if (!jobs.length) return '<p style="color:#71717a">No jobs</p>';
    var html = '';
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      html += '<div class="job-card"><div class="job-top"><span class="' + badgeClass(j.state) + '">' + j.state + '</span><span class="job-title">' + escapeHtml(j.title) + '</span></div><div class="job-meta"><span class="mono">' + escapeHtml(j.owner) + '/' + escapeHtml(j.repo) + '#' + j.issueNumber + '</span>' + (j.branch ? '<span class="mono">' + escapeHtml(j.branch) + '</span>' : '') + (j.prNumber ? '<a href="https://github.com/' + escapeHtml(j.owner) + '/' + escapeHtml(j.repo) + '/pull/' + j.prNumber + '" target="_blank" rel="noopener" class="job-pr">PR #' + j.prNumber + '</a>' : '') + (j.retryCount > 0 ? '<span class="job-retry">Retries: ' + j.retryCount + '</span>' : '') + '<span>' + elapsed(j.updatedAt) + ' ago</span></div>' + (j.lastError ? '<div class="job-error mono">' + truncate(j.lastError, 200) + '</div>' : '') + '</div>';
    }
    return html;
  }

  function renderHealthView() {
    var h = DATA.health;
    var o = DATA.omlx;
    var html = '<section class="section"><h2 class="section-title">System Status</h2><div class="health-row" style="flex-direction:column;align-items:stretch;gap:12px">';
    html += '<div class="health-item"><span class="health-dot health-ok"></span><span>ai-dev orchestrator</span><span style="margin-left:auto;color:#71717a;font-size:.75rem">' + (h && h.aiDev ? elapsed(new Date(Date.now() - h.aiDev.uptime * 1000).toISOString()) + ' uptime' : 'Running') + '</span></div>';
    var omlxDot = "health-unknown", omlxLabel = "Checking...";
    if (h && h.omlx) { omlxDot = h.omlx.reachable ? "health-ok" : "health-err"; omlxLabel = h.omlx.reachable ? "Connected" : "Unreachable"; }
    html += '<div class="health-item"><span class="health-dot ' + omlxDot + '"></span><span>oMLX inference server</span><span style="margin-left:auto;color:#71717a;font-size:.75rem">' + omlxLabel + '</span></div>';
    var ghDot = "health-unknown", ghLabel = "Checking...";
    if (h && h.github) { ghDot = h.github.configured ? "health-ok" : "health-warn"; ghLabel = h.github.configured ? "Configured" : "Not configured"; }
    html += '<div class="health-item"><span class="health-dot ' + ghDot + '"></span><span>GitHub API</span><span style="margin-left:auto;color:#71717a;font-size:.75rem">' + ghLabel + '</span></div>';
    html += '<div class="health-item"><span class="health-dot health-ok"></span><span>SQLite database</span><span style="margin-left:auto;color:#71717a;font-size:.75rem">Connected</span></div>';
    html += '</div></section>';
    // Models
    html += '<section class="section"><h2 class="section-title">Models</h2><div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px">';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:.8125rem;color:#71717a">Coding model</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(codingModel) + '</span></div>';
    html += '<div style="display:flex;justify-content:space-between;margin-bottom:8px"><span style="font-size:.8125rem;color:#71717a">Planning model</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(planningModel) + '</span></div>';
    if (o && o.stats && o.stats.activeModel) html += '<div style="display:flex;justify-content:space-between"><span style="font-size:.8125rem;color:#71717a">Active (loaded)</span><span class="mono" style="color:#d4d4d8">' + escapeHtml(o.stats.activeModel) + '</span></div>';
    html += '</div></section>';
    // oMLX details
    if (o && o.stats) {
      var s = o.stats;
      html += '<section class="section"><h2 class="section-title">oMLX Details</h2><div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px">';
      function omlxRow(label, value, color) { return '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:.8125rem"><span style="color:#71717a">' + label + '</span><span style="color:' + (color || "#d4d4d8") + '">' + value + '</span></div>'; }
      html += omlxRow("Status", s.reachable ? "Connected" : "Unreachable", s.reachable ? "#4ade80" : "#f87171");
      if (s.activeModel) html += omlxRow("Active Model", s.activeModel, "#e4e4e7");
      if (s.activeRequests != null) html += omlxRow("Active Requests", s.activeRequests + (s.waitingRequests ? " (" + s.waitingRequests + " waiting)" : ""), s.activeRequests > 0 ? "#60a5fa" : "#d4d4d8");
      if (s.avgGenerationTps != null) html += omlxRow("Generation", s.avgGenerationTps.toFixed(1) + " tok/s", "#4ade80");
      if (s.avgPrefillTps != null) html += omlxRow("Prefill", s.avgPrefillTps.toFixed(0) + " tok/s", "#4ade80");
      if (s.currentGenerationTps != null) html += omlxRow("Current Gen", s.currentGenerationTps.toFixed(1) + " tok/s", "#60a5fa");
      if (s.cacheEfficiency != null) html += omlxRow("Cache Efficiency", s.cacheEfficiency.toFixed(1) + "%", "#4ade80");
      if (s.memoryPressure) {
        var mp = s.memoryPressure;
        var memStr = (mp.currentBytes / 1073741824).toFixed(1) + " GB / " + (mp.softBytes / 1073741824).toFixed(1) + " GB soft / " + (mp.hardBytes / 1073741824).toFixed(1) + " GB hard";
        var memColor = mp.level === "ok" ? "#4ade80" : (mp.level === "warning" ? "#facc15" : "#f87171");
        html += omlxRow("Memory", memStr, memColor);
        html += omlxRow("Pressure Level", mp.level.toUpperCase(), memColor);
      } else if (s.modelMemoryBytes) {
        html += omlxRow("Model Memory", (s.modelMemoryBytes / 1073741824).toFixed(1) + " GB", "#d4d4d8");
      }
      if (s.modelActualSizeBytes) html += omlxRow("Model Actual Size", (s.modelActualSizeBytes / 1073741824).toFixed(2) + " GB", "#d4d4d8");
      if (s.idleSeconds != null) html += omlxRow("Idle", s.idleSeconds < 1 ? "Active now" : s.idleSeconds.toFixed(0) + "s", s.idleSeconds < 5 ? "#60a5fa" : "#71717a");
      if (s.totalRequests != null) html += omlxRow("Total Requests", s.totalRequests.toString(), "#71717a");
      if (s.uptimeSeconds != null) html += omlxRow("Uptime", (s.uptimeSeconds / 3600).toFixed(1) + " hours", "#71717a");
      if (s.sampledAt) html += omlxRow("Last Sampled", elapsed(s.sampledAt) + " ago", "#71717a");
      html += '</div></section>';
    }
    // SSE clients
    if (h && typeof h.sseClients === "number") {
      html += '<section class="section"><h2 class="section-title">Connections</h2><div style="background:#18181b;border:1px solid #27272a;border-radius:10px;padding:14px 16px;font-size:.8125rem"><span style="color:#71717a">SSE Clients: </span><span style="color:#d4d4d8">' + h.sseClients + '</span></div></section>';
    }
    return html;
  }

  function render() {
    var route = getRoute();
    var html = "";
    if (route.view === "home") html = renderHome();
    else if (route.view === "project") html = renderProjectDetail(route.id);
    else if (route.view === "task") html = renderTaskDetail(route.id);
    else if (route.view === "model-calls") html = renderModelCallsView();
    else if (route.view === "jobs") html = renderJobsView();
    else if (route.view === "health") html = renderHealthView();
    else html = renderHome();
    document.getElementById("app").innerHTML = html;
    renderTabs();
    renderBottomNav();
    // Title stall detection
    var hasStall = false;
    for (var i = 0; i < DATA.projects.length && !hasStall; i++) {
      for (var j = 0; j < DATA.projects[i].tasks.length; j++) {
        if (DATA.projects[i].tasks[j].state === "RUNNING" && (Date.now() - new Date(DATA.projects[i].tasks[j].updatedAt).getTime() > 600000)) { hasStall = true; break; }
      }
    }
    document.title = hasStall ? "ai-dev [STALLED]" : "ai-dev";
  }

  // Event delegation
  document.addEventListener("click", function(e) {
    var el = e.target;
    // Copy buttons
    if (el.getAttribute && el.getAttribute("data-copy")) {
      var text = el.getAttribute("data-copy");
      if (navigator.clipboard) navigator.clipboard.writeText(text);
      el.textContent = "Copied!";
      setTimeout(function() { el.textContent = "Copy"; }, 1500);
      e.stopPropagation();
      return;
    }
    // MC copy buttons
    if (el.getAttribute && el.getAttribute("data-mc-copy") !== null && el.getAttribute("data-mc-copy") !== "") {
      var idx = parseInt(el.getAttribute("data-mc-copy"), 10);
      var field = el.getAttribute("data-copy-field");
      if (DATA.calls[idx]) {
        var val = field === "prompt" ? (DATA.calls[idx].prompt || "") : (DATA.calls[idx].response || "");
        if (navigator.clipboard) navigator.clipboard.writeText(val);
        el.textContent = "Copied!";
        setTimeout(function() { el.textContent = "Copy"; }, 1500);
      }
      e.stopPropagation();
      return;
    }
    // Collapsible
    var coll = el;
    while (coll && !(coll.getAttribute && coll.getAttribute("data-collapse"))) { coll = coll.parentElement; }
    if (coll) {
      var tgt = document.getElementById("collapse-" + coll.getAttribute("data-collapse"));
      if (tgt) tgt.classList.toggle("open");
      e.stopPropagation();
      return;
    }
    // MC expand
    var mcRow = el;
    while (mcRow && !(mcRow.getAttribute && mcRow.getAttribute("data-mc-idx") !== null && mcRow.getAttribute("data-mc-idx") !== "")) { mcRow = mcRow.parentElement; }
    if (mcRow && mcRow.classList.contains("mc-row")) {
      var expandEl = document.getElementById("mc-expand-" + mcRow.getAttribute("data-mc-idx"));
      if (expandEl) expandEl.classList.toggle("open");
      return;
    }
    // Project actions
    var actBtn = el;
    while (actBtn && !(actBtn.getAttribute && actBtn.getAttribute("data-action"))) { actBtn = actBtn.parentElement; }
    if (actBtn) {
      var action = actBtn.getAttribute("data-action");
      var pid = actBtn.getAttribute("data-pid");
      if (confirm("Are you sure you want to " + action + " this project?")) {
        fetch("/api/dashboard/projects/" + pid + "/" + action, { method: "POST" }).then(function() { refreshData(); });
      }
      return;
    }
    // Task actions
    var taskBtn = el;
    while (taskBtn && !(taskBtn.getAttribute && taskBtn.getAttribute("data-task-action"))) { taskBtn = taskBtn.parentElement; }
    if (taskBtn) {
      var tAction = taskBtn.getAttribute("data-task-action");
      var tid = taskBtn.getAttribute("data-tid");
      if (confirm("Are you sure you want to " + tAction + " this task?")) {
        fetch("/api/dashboard/tasks/" + tid + "/" + tAction, { method: "POST" }).then(function() { refreshData(); });
      }
      return;
    }
    // Navigation
    var navEl = el;
    while (navEl && !(navEl.getAttribute && navEl.getAttribute("data-nav"))) { navEl = navEl.parentElement; }
    if (navEl) { nav(navEl.getAttribute("data-nav")); return; }
    // Tab navigation
    var tabEl = el;
    while (tabEl && !(tabEl.getAttribute && tabEl.getAttribute("data-hash"))) { tabEl = tabEl.parentElement; }
    if (tabEl) { nav(tabEl.getAttribute("data-hash")); return; }
  });

  window.addEventListener("hashchange", render);

  function updateHeader() {
    var s = Math.floor((Date.now() - lastRefreshTime) / 1000);
    var hdr = document.getElementById("hdr-status");
    if (connected && hdr) hdr.textContent = "Live \\xB7 Updated " + s + "s ago";
  }
  setInterval(updateHeader, 1000);

  function refreshData() {
    var p1 = fetch("/api/dashboard/projects").then(function(r) { return r.json(); });
    var p2 = fetch("/api/dashboard/model-calls?limit=50").then(function(r) { return r.json(); });
    var p3 = fetch("/api/dashboard/jobs").then(function(r) { return r.json(); });
    var p4 = fetch("/api/dashboard/health").then(function(r) { return r.json(); }).catch(function() { return null; });
    var p5 = fetch("/api/dashboard/omlx").then(function(r) { return r.json(); }).catch(function() { return null; });
    Promise.all([p1, p2, p3, p4, p5]).then(function(results) {
      DATA.projects = results[0];
      DATA.calls = results[1];
      DATA.jobs = results[2];
      DATA.health = results[3];
      DATA.omlx = results[4];
      lastRefreshTime = Date.now();
      connected = true;
      document.getElementById("conn-lost").classList.remove("visible");
      render();
    }).catch(function() {
      connected = false;
      document.getElementById("conn-lost").classList.add("visible");
      var hdr = document.getElementById("hdr-status");
      if (hdr) hdr.textContent = "Disconnected";
    });
  }

  refreshData();
  setInterval(refreshData, 10000);
})();
</script>
</body>
</html>`;

  res.type("html").send(html);
}
