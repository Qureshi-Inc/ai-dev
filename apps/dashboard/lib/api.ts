const API_BASE = "";

// Types match the actual backend responses

export interface Project {
  id: number;
  owner: string;
  repo: string;
  issueNumber: number;
  title: string;
  state: string;
  statusCommentId: number | null;
  plan: string | null;
  createdBy: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  tasks?: ProjectTask[];
}

export interface ProjectTask {
  id: number;
  projectId: number;
  taskIndex: number;
  title: string;
  description: string;
  state: string;
  dependencies: string | null;
  subtasks: string | null;
  jobId: number | null;
  lastError: string | null;
  branch: string | null;
  prNumber: number | null;
  headSha: string | null;
  retryCount: number;
  ciRetryCount: number;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardOverview {
  activeJobCount: number;
  totalProjects: number;
  activeProjects: number;
  taskStats: Record<string, number>;
  queueDepth: number;
  sseClients: number;
  omlxReachable: boolean;
}

export interface HealthStatus {
  aiDev: { ok: boolean; uptime: number };
  sqlite: { ok: boolean };
  github: { configured: boolean };
  omlx: {
    monitoring: boolean;
    reachable: boolean;
    activeModel: string | null;
    isStale: boolean;
    sampledAt: string | null;
  };
  sseClients: number;
}

export interface OmlxStats {
  available: boolean;
  stats: {
    reachable: boolean;
    version: string | null;
    availableModels: string[];
    loadedModels: string[];
    activeModel: string | null;
    processMemoryBytes: number | null;
    modelMemoryBytes: number | null;
    sampledAt: string | null;
    isStale: boolean;
    sourceCapabilities: {
      healthEndpoint: boolean;
      modelsEndpoint: boolean;
      adminStatsEndpoint: boolean;
    };
  };
}

export interface DashboardEvent {
  id: number;
  type: string;
  data: unknown;
  timestamp: string;
}

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!res.ok) {
      throw new ApiError(res.status, res.statusText);
    }

    return res.json();
  }

  async getOverview(): Promise<DashboardOverview> {
    return this.request("/api/dashboard/overview");
  }

  async getProjects(): Promise<Project[]> {
    return this.request("/api/dashboard/projects");
  }

  async getProject(id: string): Promise<Project> {
    return this.request(`/api/dashboard/projects/${id}`);
  }

  async getTask(id: string): Promise<ProjectTask> {
    return this.request(`/api/dashboard/tasks/${id}`);
  }

  async getHealth(): Promise<HealthStatus> {
    return this.request("/api/dashboard/health");
  }

  async getOmlx(): Promise<OmlxStats> {
    return this.request("/api/dashboard/omlx");
  }

  async getEvents(params?: { since?: string; limit?: number }): Promise<DashboardEvent[]> {
    const searchParams = new URLSearchParams();
    if (params?.since) searchParams.set("since", params.since);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return this.request(`/api/dashboard/events${qs ? `?${qs}` : ""}`);
  }

  async approveProject(id: string): Promise<void> {
    await this.request(`/api/dashboard/projects/${id}/approve`, { method: "POST" });
  }

  async pauseProject(id: string): Promise<void> {
    await this.request(`/api/dashboard/projects/${id}/pause`, { method: "POST" });
  }

  async resumeProject(id: string): Promise<void> {
    await this.request(`/api/dashboard/projects/${id}/resume`, { method: "POST" });
  }

  async cancelProject(id: string): Promise<void> {
    await this.request(`/api/dashboard/projects/${id}/cancel`, { method: "POST" });
  }

  async retryTask(id: string): Promise<void> {
    await this.request(`/api/dashboard/tasks/${id}/retry`, { method: "POST" });
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
  ) {
    super(`API Error: ${status} ${statusText}`);
  }
}

export const api = new ApiClient();
