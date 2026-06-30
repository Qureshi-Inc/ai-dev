import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { broadcastEvent, getClientCount } from "../sse.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OmlxStats {
  reachable: boolean;
  version: string | null;
  availableModels: string[];
  loadedModels: string[];
  activeModel: string | null;
  processMemoryBytes: number | null;
  modelMemoryBytes: number | null;
  sampledAt: string;
  isStale: boolean;
  sourceCapabilities: {
    healthEndpoint: boolean;
    modelsEndpoint: boolean;
    adminStatsEndpoint: boolean;
  };
  // Extended stats from admin API
  activeRequests: number | null;
  waitingRequests: number | null;
  generatingRequests: number | null;
  prefillingRequests: number | null;
  avgPrefillTps: number | null;
  avgGenerationTps: number | null;
  cacheEfficiency: number | null;
  totalRequests: number | null;
  uptimeSeconds: number | null;
  memoryPressure: {
    currentBytes: number;
    softBytes: number;
    hardBytes: number;
    level: string;
  } | null;
  modelActualSizeBytes: number | null;
  modelEstimatedSizeBytes: number | null;
  idleSeconds: number | null;
  currentGeneratingTokens: number | null;
  currentGenerationTps: number | null;
}

interface HealthResponse {
  status?: string;
  default_model?: string;
  engine_pool?: {
    model_count?: number;
    loaded_count?: number;
    current_model_memory?: number;
    final_ceiling?: number;
  };
}

interface ModelEntry {
  id?: string;
}

interface ModelsResponse {
  data?: ModelEntry[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let latestStats: OmlxStats | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let consecutiveErrors = 0;
const MAX_BACKOFF_MS = 60_000;
const STALE_THRESHOLD_MS = 30_000;

// Feature detection for admin stats
let adminStatsAvailable: boolean | null = null;
// Session cookie from admin login
let adminSessionCookie: string | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  // config.llm.baseUrl is "http://192.168.4.38:1234/v1", we need base without /v1
  const url = config.llm.baseUrl;
  if (url.endsWith("/v1")) {
    return url.slice(0, -3);
  }
  return url;
}

async function fetchWithTimeout(url: string, timeoutMs: number, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const init: RequestInit = { signal: controller.signal };
    if (headers && Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    return await fetch(url, init);
  } finally {
    clearTimeout(timer);
  }
}

async function ensureAdminSession(): Promise<string | null> {
  if (adminSessionCookie) return adminSessionCookie;
  const baseUrl = getBaseUrl();
  const apiKey = config.llm.apiKey;
  if (!apiKey) return null;
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/admin/api/login`, config.dashboard.omlxRequestTimeoutMs, {
      "Content-Type": "application/json",
    });
    // We need POST, fetchWithTimeout only does GET. Do it manually.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.dashboard.omlxRequestTimeoutMs);
    try {
      const loginResp = await fetch(`${baseUrl}/admin/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (loginResp.ok) {
        const setCookie = loginResp.headers.get("set-cookie");
        if (setCookie) {
          adminSessionCookie = setCookie.split(";")[0];
          return adminSessionCookie;
        }
      }
    } catch {
      clearTimeout(timer);
    }
  } catch {
    // ignore
  }
  return null;
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (adminSessionCookie) {
    headers["Cookie"] = adminSessionCookie;
  } else if (config.dashboard.omlxAdminAuthHeader) {
    headers["Authorization"] = config.dashboard.omlxAdminAuthHeader;
  } else if (config.dashboard.omlxAdminAuthCookie) {
    headers["Cookie"] = config.dashboard.omlxAdminAuthCookie;
  }
  return headers;
}

async function sampleHealth(): Promise<Partial<OmlxStats>> {
  const baseUrl = getBaseUrl();
  const timeout = config.dashboard.omlxRequestTimeoutMs;
  const result: Partial<OmlxStats> = {
    reachable: false,
    sourceCapabilities: {
      healthEndpoint: false,
      modelsEndpoint: false,
      adminStatsEndpoint: false,
    },
  };

  // 1. Poll /health
  try {
    const resp = await fetchWithTimeout(`${baseUrl}/health`, timeout);
    if (resp.ok) {
      const data = (await resp.json()) as HealthResponse;
      result.reachable = true;
      result.sourceCapabilities!.healthEndpoint = true;
      result.activeModel = data.default_model ?? null;

      if (data.engine_pool) {
        result.modelMemoryBytes = data.engine_pool.current_model_memory ?? null;
        // loaded_count tells us how many models are loaded
        const loadedCount = data.engine_pool.loaded_count ?? 0;
        if (loadedCount > 0 && data.default_model) {
          result.loadedModels = [data.default_model];
        }
      }
    }
  } catch {
    // Not reachable
    return result;
  }

  // 2. Poll /v1/models for available models list
  try {
    const authHeader: Record<string, string> = config.llm.apiKey
      ? { Authorization: `Bearer ${config.llm.apiKey}` }
      : {};
    const resp = await fetchWithTimeout(`${baseUrl}/v1/models`, timeout, authHeader);
    if (resp.ok) {
      const data = (await resp.json()) as ModelsResponse;
      result.sourceCapabilities!.modelsEndpoint = true;
      if (data.data && Array.isArray(data.data)) {
        result.availableModels = data.data
          .map((m) => m.id)
          .filter((id): id is string => !!id);
      }
    }
  } catch {
    // Non-fatal
  }

  // 3. Admin API stats (login with API key, parse rich data)
  if (config.dashboard.omlxAdminStatsEnabled || adminStatsAvailable === null) {
    try {
      // Ensure we have a session cookie
      if (!adminSessionCookie) {
        await ensureAdminSession();
      }
      const headers = buildAuthHeaders();
      if (Object.keys(headers).length > 0) {
        const resp = await fetchWithTimeout(`${baseUrl}/admin/api/stats`, timeout, headers);
        if (resp.ok) {
          adminStatsAvailable = true;
          result.sourceCapabilities!.adminStatsEndpoint = true;
          const data = (await resp.json()) as Record<string, unknown>;

          // Top-level stats
          if (typeof data.avg_prefill_tps === "number") (result as Record<string, unknown>).avgPrefillTps = data.avg_prefill_tps;
          if (typeof data.avg_generation_tps === "number") (result as Record<string, unknown>).avgGenerationTps = data.avg_generation_tps;
          if (typeof data.cache_efficiency === "number") (result as Record<string, unknown>).cacheEfficiency = data.cache_efficiency;
          if (typeof data.total_requests === "number") (result as Record<string, unknown>).totalRequests = data.total_requests;
          if (typeof data.uptime_seconds === "number") (result as Record<string, unknown>).uptimeSeconds = data.uptime_seconds;

          // Active models
          const am = data.active_models as Record<string, unknown> | undefined;
          if (am) {
            if (typeof am.total_active_requests === "number") (result as Record<string, unknown>).activeRequests = am.total_active_requests;
            if (typeof am.total_waiting_requests === "number") (result as Record<string, unknown>).waitingRequests = am.total_waiting_requests;

            const pressure = am.memory_pressure as Record<string, unknown> | undefined;
            if (pressure) {
              (result as Record<string, unknown>).memoryPressure = {
                currentBytes: pressure.current_bytes as number || 0,
                softBytes: pressure.soft_bytes as number || 0,
                hardBytes: pressure.hard_bytes as number || 0,
                level: (pressure.pressure_level as string) || "unknown",
              };
            }

            const models = am.models as Array<Record<string, unknown>> | undefined;
            if (models && models.length > 0) {
              const m = models[0];
              if (typeof m.actual_size === "number") (result as Record<string, unknown>).modelActualSizeBytes = m.actual_size;
              if (typeof m.estimated_size === "number") (result as Record<string, unknown>).modelEstimatedSizeBytes = m.estimated_size;
              if (typeof m.idle_seconds === "number") (result as Record<string, unknown>).idleSeconds = m.idle_seconds;
              if (typeof m.active_requests === "number") (result as Record<string, unknown>).activeRequests = m.active_requests;
              const generating = m.generating as Array<Record<string, unknown>> | undefined;
              if (generating && generating.length > 0) {
                (result as Record<string, unknown>).generatingRequests = generating.length;
                if (typeof generating[0].tokens === "number") (result as Record<string, unknown>).currentGeneratingTokens = generating[0].tokens;
                if (typeof generating[0].tps === "number") (result as Record<string, unknown>).currentGenerationTps = generating[0].tps;
              }
              const prefilling = m.prefilling as Array<unknown> | undefined;
              if (prefilling) (result as Record<string, unknown>).prefillingRequests = prefilling.length;

              if (m.id && typeof m.id === "string") {
                result.loadedModels = [m.id];
                result.activeModel = m.id;
              }
            }
          }
        } else if (resp.status === 403) {
          // Session expired, clear cookie and retry next cycle
          adminSessionCookie = null;
          adminStatsAvailable = null;
        } else {
          adminStatsAvailable = false;
        }
      }
    } catch {
      // Non-fatal — fall back to basic health
    }
  }

  return result;
}

async function pollOnce(): Promise<void> {
  try {
    const partial = await sampleHealth();

    const now = new Date().toISOString();
    const p = partial as Record<string, unknown>;
    latestStats = {
      reachable: partial.reachable ?? false,
      version: (p.version as string) ?? (latestStats?.version ?? null),
      availableModels: partial.availableModels ?? (latestStats?.availableModels ?? []),
      loadedModels: partial.loadedModels ?? (latestStats?.loadedModels ?? []),
      activeModel: partial.activeModel ?? null,
      processMemoryBytes: partial.processMemoryBytes ?? null,
      modelMemoryBytes: partial.modelMemoryBytes ?? null,
      sampledAt: now,
      isStale: false,
      sourceCapabilities: partial.sourceCapabilities ?? {
        healthEndpoint: false,
        modelsEndpoint: false,
        adminStatsEndpoint: false,
      },
      activeRequests: (p.activeRequests as number) ?? null,
      waitingRequests: (p.waitingRequests as number) ?? null,
      generatingRequests: (p.generatingRequests as number) ?? null,
      prefillingRequests: (p.prefillingRequests as number) ?? null,
      avgPrefillTps: (p.avgPrefillTps as number) ?? null,
      avgGenerationTps: (p.avgGenerationTps as number) ?? null,
      cacheEfficiency: (p.cacheEfficiency as number) ?? null,
      totalRequests: (p.totalRequests as number) ?? null,
      uptimeSeconds: (p.uptimeSeconds as number) ?? null,
      memoryPressure: (p.memoryPressure as OmlxStats["memoryPressure"]) ?? null,
      modelActualSizeBytes: (p.modelActualSizeBytes as number) ?? null,
      modelEstimatedSizeBytes: (p.modelEstimatedSizeBytes as number) ?? null,
      idleSeconds: (p.idleSeconds as number) ?? null,
      currentGeneratingTokens: (p.currentGeneratingTokens as number) ?? null,
      currentGenerationTps: (p.currentGenerationTps as number) ?? null,
    };

    consecutiveErrors = 0;

    // Fan out to SSE clients
    broadcastEvent("omlx_stats", latestStats);
  } catch (err) {
    consecutiveErrors++;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message, consecutiveErrors }, "oMLX monitor poll failed");

    // Mark existing stats as stale
    if (latestStats) {
      latestStats.isStale = true;
      latestStats.reachable = false;
    }
  }
}

function getInterval(): number {
  // If there are dashboard clients connected, use fast interval; otherwise idle
  const hasClients = getClientCount() > 0;
  const baseInterval = hasClients
    ? config.dashboard.omlxStatsIntervalMs
    : config.dashboard.omlxIdleHealthIntervalMs;

  // Apply exponential backoff on errors
  if (consecutiveErrors > 0) {
    const backoff = Math.min(
      baseInterval * Math.pow(2, consecutiveErrors),
      MAX_BACKOFF_MS,
    );
    return backoff;
  }

  return baseInterval;
}

function scheduleNext(): void {
  if (!running) return;
  const interval = getInterval();
  pollTimer = setTimeout(async () => {
    await pollOnce();
    scheduleNext();
  }, interval);
}

// ---------------------------------------------------------------------------
// Staleness checker
// ---------------------------------------------------------------------------

let stalenessTimer: ReturnType<typeof setInterval> | null = null;

function checkStaleness(): void {
  if (!latestStats || latestStats.isStale) return;
  const elapsed = Date.now() - new Date(latestStats.sampledAt).getTime();
  if (elapsed > STALE_THRESHOLD_MS) {
    latestStats.isStale = true;
    broadcastEvent("omlx_stats", latestStats);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the latest cached oMLX stats sample.
 */
export function getLatestOmlxStats(): OmlxStats | null {
  return latestStats;
}

/**
 * Start the oMLX monitor. Safe to call multiple times (no-op if already running).
 */
export function startOmlxMonitor(): void {
  if (!config.dashboard.omlxMonitoringEnabled) {
    logger.info("oMLX monitoring disabled");
    return;
  }

  if (running) return;
  running = true;

  logger.info(
    {
      interval: config.dashboard.omlxStatsIntervalMs,
      idleInterval: config.dashboard.omlxIdleHealthIntervalMs,
    },
    "oMLX monitor starting",
  );

  // Initial poll
  pollOnce().then(() => scheduleNext()).catch(() => scheduleNext());

  // Staleness check every 10s
  stalenessTimer = setInterval(checkStaleness, 10_000);
}

/**
 * Clear oMLX SSD and hot caches to reclaim memory.
 * Call this between phases or when memory pressure is high.
 */
export async function clearOmlxCaches(): Promise<{ ssdCleared: number; hotReclaimed: number }> {
  const baseUrl = getBaseUrl();
  const timeout = config.dashboard.omlxRequestTimeoutMs;
  let ssdCleared = 0;
  let hotReclaimed = 0;

  // Ensure admin session
  if (!adminSessionCookie) await ensureAdminSession();
  const headers = buildAuthHeaders();
  if (Object.keys(headers).length === 0) {
    logger.warn("oMLX maintenance: no admin auth available, cannot clear caches");
    return { ssdCleared, hotReclaimed };
  }

  try {
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), timeout);
    const r1 = await fetch(`${baseUrl}/admin/api/ssd-cache/clear`, {
      method: "POST", headers, signal: ctrl1.signal,
    });
    clearTimeout(t1);
    if (r1.ok) {
      const d = await r1.json() as { total_deleted?: number };
      ssdCleared = d.total_deleted ?? 0;
    }
  } catch { /* best-effort */ }

  try {
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), timeout);
    const r2 = await fetch(`${baseUrl}/admin/api/hot-cache/clear`, {
      method: "POST", headers, signal: ctrl2.signal,
    });
    clearTimeout(t2);
    if (r2.ok) {
      const d = await r2.json() as { bytes_reclaimed?: number };
      hotReclaimed = d.bytes_reclaimed ?? 0;
    }
  } catch { /* best-effort */ }

  logger.info({ ssdCleared, hotReclaimed: hotReclaimed / (1024 ** 3) }, "oMLX caches cleared");
  return { ssdCleared, hotReclaimed };
}

/**
 * Check memory pressure and auto-clear caches if above soft limit.
 * Call this before starting a new task to ensure headroom.
 */
export async function ensureOmlxHeadroom(): Promise<void> {
  if (!latestStats?.memoryPressure) return;
  const { level } = latestStats.memoryPressure;
  if (level === "soft" || level === "hard" || level === "critical") {
    logger.warn({ level }, "oMLX memory pressure detected; clearing caches");
    await clearOmlxCaches();
    // Re-poll to get fresh stats
    await pollOnce();
  }
}

/**
 * Stop the oMLX monitor (for graceful shutdown).
 */
export function stopOmlxMonitor(): void {
  running = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (stalenessTimer) {
    clearInterval(stalenessTimer);
    stalenessTimer = null;
  }
}
