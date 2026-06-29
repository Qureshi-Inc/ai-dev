"use client";

export type SSEEventType =
  | "project_update"
  | "task_update"
  | "job_update"
  | "log_entry"
  | "omlx_stats"
  | "health_update";

export type SSEMode = "auto" | "on" | "paused";

export interface SSEEvent {
  id?: string;
  type: SSEEventType;
  data: unknown;
}

type SSEListener = (event: SSEEvent) => void;

const SSE_URL = "/events/stream";
const INITIAL_RETRY_MS = 1000;
const MAX_RETRY_MS = 30000;

class SSEClient {
  private eventSource: EventSource | null = null;
  private listeners: Set<SSEListener> = new Set();
  private lastEventId: string | null = null;
  private retryMs = INITIAL_RETRY_MS;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private _mode: SSEMode = "auto";
  private _connected = false;
  private visibilityHandler: (() => void) | null = null;

  get mode(): SSEMode {
    return this._mode;
  }

  get connected(): boolean {
    return this._connected;
  }

  setMode(mode: SSEMode) {
    this._mode = mode;
    if (mode === "paused") {
      this.disconnect();
    } else if (mode === "on") {
      if (!this._connected) this.connect();
    } else {
      // auto mode: connect if tab is visible
      if (typeof document !== "undefined" && !document.hidden) {
        if (!this._connected) this.connect();
      } else {
        this.disconnect();
      }
    }
  }

  subscribe(listener: SSEListener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && this._mode !== "paused") {
      this.connect();
      this.setupVisibilityHandler();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.disconnect();
        this.teardownVisibilityHandler();
      }
    };
  }

  private setupVisibilityHandler() {
    if (typeof document === "undefined") return;
    this.visibilityHandler = () => {
      if (this._mode !== "auto") return;
      if (document.hidden) {
        this.disconnect();
      } else {
        this.connect();
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler);
  }

  private teardownVisibilityHandler() {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
  }

  private connect() {
    if (this.eventSource) return;
    if (typeof window === "undefined") return;

    const url = new URL(SSE_URL, window.location.origin);
    if (this.lastEventId) {
      url.searchParams.set("lastEventId", this.lastEventId);
    }

    const es = new EventSource(url.toString());

    es.onopen = () => {
      this._connected = true;
      this.retryMs = INITIAL_RETRY_MS;
      this.emit({ type: "health_update" as SSEEventType, data: { connected: true } });
    };

    es.onerror = () => {
      this._connected = false;
      this.emit({ type: "health_update" as SSEEventType, data: { connected: false } });
      es.close();
      this.eventSource = null;
      this.scheduleRetry();
    };

    const eventTypes: SSEEventType[] = [
      "project_update",
      "task_update",
      "job_update",
      "log_entry",
      "omlx_stats",
      "health_update",
    ];

    for (const type of eventTypes) {
      es.addEventListener(type, (e: MessageEvent) => {
        const messageEvent = e as MessageEvent;
        if (messageEvent.lastEventId) {
          this.lastEventId = messageEvent.lastEventId;
        }
        try {
          const data = JSON.parse(messageEvent.data);
          this.emit({ id: messageEvent.lastEventId, type, data });
        } catch {
          this.emit({ id: messageEvent.lastEventId, type, data: messageEvent.data });
        }
      });
    }

    // Fallback for unnamed messages
    es.onmessage = (e: MessageEvent) => {
      if (e.lastEventId) {
        this.lastEventId = e.lastEventId;
      }
      try {
        const data = JSON.parse(e.data);
        const type = data.type || "log_entry";
        this.emit({ id: e.lastEventId, type, data });
      } catch {
        // ignore unparseable messages
      }
    };

    this.eventSource = es;
  }

  private disconnect() {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
      this._connected = false;
    }
  }

  private scheduleRetry() {
    if (this._mode === "paused") return;
    if (this.retryTimeout) return;

    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null;
      if (this._mode === "paused") return;
      if (this._mode === "auto" && typeof document !== "undefined" && document.hidden) return;
      this.connect();
    }, this.retryMs);

    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private emit(event: SSEEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // listener error should not break others
      }
    }
  }

  destroy() {
    this.disconnect();
    this.teardownVisibilityHandler();
    this.listeners.clear();
  }
}

export const sseClient = new SSEClient();
