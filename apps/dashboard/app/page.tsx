import type { Metadata } from "next";

export const metadata: Metadata = { title: "ai-dev Dashboard" };
export const dynamic = "force-dynamic";

const BACKEND = process.env.AI_DEV_BACKEND_URL || "http://localhost:8088";

async function fetchJSON<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BACKEND}${path}`, { cache: "no-store" });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function StateBadge({ state }: { state: string }) {
  const colors: Record<string, string> = {
    RUNNING: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    COMPLETED: "bg-green-500/20 text-green-400 border-green-500/30",
    FAILED: "bg-red-500/20 text-red-400 border-red-500/30",
    PLANNING: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    AWAITING_APPROVAL: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
    PAUSED: "bg-orange-500/20 text-orange-400 border-orange-500/30",
    CANCELLED: "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
    READY: "bg-cyan-500/20 text-cyan-400 border-cyan-500/30",
    BLOCKED: "bg-zinc-600/20 text-zinc-500 border-zinc-600/30",
  };
  const c = colors[state] || "bg-zinc-500/20 text-zinc-400 border-zinc-500/30";
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${c}`}>
      {state}
    </span>
  );
}

function formatElapsed(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return "—";
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(1)} GB`;
}

interface TaskData {
  id: number;
  taskIndex: number;
  title: string;
  state: string;
  branch: string | null;
}

interface ProjectData {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  state: string;
  createdAt: string;
  tasks?: TaskData[];
}

interface OverviewData {
  activeJobCount: number;
  totalProjects: number;
  activeProjects: number;
  taskStats: Record<string, number>;
  queueDepth: number;
  sseClients: number;
  omlxReachable: boolean;
}

interface HealthData {
  aiDev: { ok: boolean; uptime: number };
  sqlite: { ok: boolean };
  github: { configured: boolean };
  omlx: { reachable: boolean; activeModel: string | null; monitoring: boolean };
}

interface OmlxData {
  available: boolean;
  stats: { activeModel: string | null; modelMemoryBytes: number | null };
}

export default async function HomePage() {
  const [overview, projects, health, omlx] = await Promise.all([
    fetchJSON<OverviewData>("/api/dashboard/overview"),
    fetchJSON<ProjectData[]>("/api/dashboard/projects"),
    fetchJSON<HealthData>("/api/dashboard/health"),
    fetchJSON<OmlxData>("/api/dashboard/omlx"),
  ]);

  const activeProjects = projects?.filter(p => !["COMPLETED", "CANCELLED", "FAILED"].includes(p.state)) || [];
  const runningTasks = projects?.flatMap(p => p.tasks || []).filter(t => t.state === "RUNNING") || [];

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Overview</h1>
        <p className="text-sm text-zinc-500">ai-dev autonomous coding agent</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Projects</p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">{overview?.activeProjects ?? 0}</p>
          <p className="text-xs text-zinc-500">active</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Tasks</p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">{overview?.taskStats?.COMPLETED ?? 0}</p>
          <p className="text-xs text-zinc-500">completed</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Queue</p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">{overview?.queueDepth ?? 0}</p>
          <p className="text-xs text-zinc-500">depth</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">Jobs</p>
          <p className="mt-1 text-2xl font-bold text-zinc-100">{overview?.activeJobCount ?? 0}</p>
          <p className="text-xs text-zinc-500">active</p>
        </div>
      </div>

      {/* Health */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${health?.aiDev?.ok ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-zinc-400">ai-dev</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${health?.omlx?.reachable ? "bg-green-400" : "bg-red-400"}`} />
          <span className="text-xs text-zinc-400">oMLX</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full ${health?.github?.configured ? "bg-green-400" : "bg-yellow-400"}`} />
          <span className="text-xs text-zinc-400">GitHub</span>
        </div>
        {omlx?.stats?.activeModel && (
          <span className="ml-auto text-xs font-mono text-zinc-500">
            {omlx.stats.activeModel} · {formatBytes(omlx.stats.modelMemoryBytes)}
          </span>
        )}
      </div>

      {/* Running Task */}
      {runningTasks.length > 0 && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-blue-400" />
            <span className="text-xs font-medium text-blue-400">Currently Running</span>
          </div>
          {runningTasks.map(task => (
            <div key={task.id} className="mt-2">
              <a href={`/dashboard/tasks/${task.id}`} className="font-medium text-zinc-100 hover:text-blue-400 transition">
                Task {task.taskIndex + 1}: {task.title}
              </a>
              {task.branch && (
                <p className="mt-1 font-mono text-xs text-zinc-500">{task.branch}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Active Projects */}
      <div>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Active Projects</h2>
        {activeProjects.length === 0 ? (
          <p className="text-sm text-zinc-500">No active projects</p>
        ) : (
          <div className="space-y-3">
            {activeProjects.map(project => {
              const tasks = project.tasks || [];
              const completed = tasks.filter(t => t.state === "COMPLETED").length;
              const total = tasks.length;
              const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
              return (
                <a key={project.id} href={`/dashboard/projects/${project.id}`}
                  className="block rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition hover:border-zinc-700">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-medium text-zinc-100">{project.title}</h3>
                      <p className="mt-0.5 text-xs text-zinc-500">{project.owner}/{project.repo} #{project.issueNumber}</p>
                    </div>
                    <StateBadge state={project.state} />
                  </div>
                  <div className="mt-3 flex items-center gap-3">
                    <div className="flex-1">
                      <div className="h-1.5 rounded-full bg-zinc-800">
                        <div className="h-1.5 rounded-full bg-blue-500 transition-all" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <span className="text-xs text-zinc-500">{completed}/{total}</span>
                    <span className="text-xs text-zinc-600">{formatElapsed(project.createdAt)}</span>
                  </div>
                </a>
              );
            })}
          </div>
        )}
      </div>

      {!overview && (
        <div className="rounded-lg border border-red-800/30 bg-red-950/10 p-4">
          <p className="text-sm text-red-400">Could not connect to ai-dev backend.</p>
          <p className="mt-1 text-xs text-zinc-500">Check that the orchestrator is running.</p>
        </div>
      )}
    </div>
  );
}
