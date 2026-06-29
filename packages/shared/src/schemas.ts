import { z } from "zod";

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  repoFullName: z.string(),
  defaultBranch: z.string().default("main"),
  status: z.enum(["active", "paused", "completed", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  metadata: z.record(z.unknown()).optional(),
});

export const ProjectTaskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled"]),
  priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  assignedAgent: z.string().optional(),
  branch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  errorMessage: z.string().optional(),
});

export const IssueJobSchema = z.object({
  id: z.string().uuid(),
  issueNumber: z.number().int().positive(),
  repoFullName: z.string(),
  title: z.string(),
  body: z.string().optional(),
  status: z.enum(["pending", "assigned", "working", "review", "done", "errored"]),
  agentSessionId: z.string().optional(),
  branch: z.string().optional(),
  prNumber: z.number().int().positive().optional(),
  attempts: z.number().int().nonnegative().default(0),
  lastError: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ModelCallSchema = z.object({
  id: z.string().uuid(),
  model: z.string(),
  provider: z.string(),
  taskId: z.string().uuid().optional(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
  status: z.enum(["success", "error", "timeout"]),
  errorMessage: z.string().optional(),
  createdAt: z.string().datetime(),
});

export const OmlxStatsSchema = z.object({
  modelId: z.string(),
  modelName: z.string(),
  loaded: z.boolean(),
  vramUsageMb: z.number().nonnegative(),
  totalVramMb: z.number().nonnegative(),
  tokensPerSecond: z.number().nonnegative().optional(),
  activeRequests: z.number().int().nonnegative(),
  totalRequests: z.number().int().nonnegative(),
  uptime: z.number().nonnegative(),
  lastRequestAt: z.string().datetime().optional(),
});

export const DashboardEventSchema = z.object({
  id: z.string(),
  type: z.enum([
    "task.started",
    "task.completed",
    "task.failed",
    "issue.assigned",
    "issue.completed",
    "model.loaded",
    "model.unloaded",
    "agent.spawned",
    "agent.finished",
    "pr.created",
    "pr.merged",
    "health.changed",
  ]),
  payload: z.record(z.unknown()),
  timestamp: z.string().datetime(),
});

export const HealthStatusSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  version: z.string(),
  uptime: z.number().nonnegative(),
  checks: z.object({
    database: z.enum(["ok", "error"]),
    llmBackend: z.enum(["ok", "error", "unreachable"]),
    github: z.enum(["ok", "error", "rate_limited"]),
    diskSpace: z.enum(["ok", "warning", "critical"]),
  }),
  activeAgents: z.number().int().nonnegative(),
  queuedTasks: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
});
