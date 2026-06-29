import type { Request, Response } from "express";
import { logger } from "./utils/logger.js";
import { config } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SSEEventType =
  | "project_update"
  | "task_update"
  | "job_update"
  | "log_entry"
  | "omlx_stats"
  | "health_update";

export interface SSEEvent {
  id: number;
  type: SSEEventType;
  data: unknown;
  timestamp: string;
}

interface SSEClient {
  id: number;
  res: Response;
  connectedAt: number;
  lastEventId: number;
  /** Token bucket for rate limiting: tokens available */
  tokens: number;
  /** Token bucket: last refill timestamp */
  lastRefill: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let eventIdCounter = 0;
const clients: Map<number, SSEClient> = new Map();
let clientIdCounter = 0;

/** Ring buffer of last 100 events for replay on reconnect. */
const EVENT_BUFFER_SIZE = 100;
const eventBuffer: SSEEvent[] = [];

/** Heartbeat interval handle. */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

// Rate limiting constants
const RATE_LIMIT_TOKENS_MAX = 10;
const RATE_LIMIT_REFILL_PER_SEC = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refillTokens(client: SSEClient): void {
  const now = Date.now();
  const elapsed = (now - client.lastRefill) / 1000;
  client.tokens = Math.min(RATE_LIMIT_TOKENS_MAX, client.tokens + elapsed * RATE_LIMIT_REFILL_PER_SEC);
  client.lastRefill = now;
}

function sendToClient(client: SSEClient, event: SSEEvent): boolean {
  refillTokens(client);
  if (client.tokens < 1) {
    // Rate limited — skip this event for this client
    return false;
  }
  client.tokens -= 1;

  try {
    client.res.write(`id: ${event.id}\n`);
    client.res.write(`event: ${event.type}\n`);
    client.res.write(`data: ${JSON.stringify(event.data)}\n\n`);
    client.lastEventId = event.id;
    return true;
  } catch {
    // Client disconnected
    return false;
  }
}

function addToBuffer(event: SSEEvent): void {
  if (eventBuffer.length >= EVENT_BUFFER_SIZE) {
    eventBuffer.shift();
  }
  eventBuffer.push(event);
}

function removeClient(clientId: number): void {
  const client = clients.get(clientId);
  if (client) {
    clients.delete(clientId);
    try {
      client.res.end();
    } catch {
      // Already closed
    }
    logger.debug({ clientId, remaining: clients.size }, "SSE client disconnected");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Broadcast an event to all connected SSE clients.
 */
export function broadcastEvent(type: SSEEventType, data: unknown): void {
  const event: SSEEvent = {
    id: ++eventIdCounter,
    type,
    data,
    timestamp: new Date().toISOString(),
  };

  addToBuffer(event);

  for (const [clientId, client] of clients) {
    const ok = sendToClient(client, event);
    if (!ok) {
      // If write failed, client is dead — clean up
      // (rate-limited events are just skipped, not removed)
    }
  }
}

/**
 * Get the number of connected SSE clients.
 */
export function getClientCount(): number {
  return clients.size;
}

/**
 * Get events from the ring buffer since a given event ID.
 */
export function getBufferedEvents(sinceId: number, limit: number = 50): SSEEvent[] {
  const result: SSEEvent[] = [];
  for (const event of eventBuffer) {
    if (event.id > sinceId) {
      result.push(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

/**
 * Express route handler for GET /events/stream
 */
export function handleSSEStream(req: Request, res: Response): void {
  const maxClients = config.dashboard.maxClients;
  if (clients.size >= maxClients) {
    res.status(503).json({ error: "Too many SSE clients", max: maxClients });
    return;
  }

  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  const clientId = ++clientIdCounter;
  const client: SSEClient = {
    id: clientId,
    res,
    connectedAt: Date.now(),
    lastEventId: 0,
    tokens: RATE_LIMIT_TOKENS_MAX,
    lastRefill: Date.now(),
  };

  clients.set(clientId, client);
  logger.debug({ clientId, total: clients.size }, "SSE client connected");

  // Send initial comment to keep connection alive
  res.write(`:connected\n\n`);

  // Replay missed events if Last-Event-ID is provided
  const lastEventIdHeader = req.header("Last-Event-ID");
  if (lastEventIdHeader) {
    const lastId = parseInt(lastEventIdHeader, 10);
    if (!isNaN(lastId) && lastId > 0) {
      client.lastEventId = lastId;
      const missed = getBufferedEvents(lastId);
      for (const event of missed) {
        sendToClient(client, event);
      }
    }
  }

  // Clean up on disconnect
  req.on("close", () => {
    removeClient(clientId);
  });

  req.on("error", () => {
    removeClient(clientId);
  });
}

/**
 * Start the heartbeat interval (call once on boot).
 */
export function startSSEHeartbeat(): void {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const deadClients: number[] = [];
    for (const [clientId, client] of clients) {
      try {
        client.res.write(`:heartbeat ${Date.now()}\n\n`);
      } catch {
        deadClients.push(clientId);
      }
    }
    for (const id of deadClients) {
      removeClient(id);
    }
  }, 15_000);
}

/**
 * Stop the heartbeat (for graceful shutdown).
 */
export function stopSSEHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
