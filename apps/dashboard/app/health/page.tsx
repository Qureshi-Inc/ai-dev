"use client";

import { useHealth, useOmlx } from "@/lib/hooks";
import type { HealthStatus } from "@/lib/api";

function formatRelativeTime(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function HealthPage() {
  const { data: health, isLoading: healthLoading, error: healthError } = useHealth();
  const { data: omlx, isLoading: omlxLoading } = useOmlx();

  const isLoading = healthLoading || omlxLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
      </div>
    );
  }

  if (healthError || !health) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-4 text-sm text-red-400">
          Failed to load health data.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <h1 className="text-lg font-semibold text-zinc-100">System Health</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* ai-dev card */}
        <HealthCard
          title="ai-dev"
          ok={health.aiDev.ok}
          metrics={[
            { label: "Status", value: health.aiDev.ok ? "Healthy" : "Down" },
            { label: "Uptime", value: formatUptime(health.aiDev.uptime) },
          ]}
        />

        {/* oMLX card */}
        <HealthCard
          title="oMLX"
          ok={health.omlx.reachable}
          metrics={[
            { label: "Reachable", value: health.omlx.reachable ? "Yes" : "No" },
            { label: "Monitoring", value: health.omlx.monitoring ? "Yes" : "No" },
            ...(health.omlx.activeModel
              ? [{ label: "Model", value: health.omlx.activeModel }]
              : []),
            ...(omlx?.stats?.activeModel && !health.omlx.activeModel
              ? [{ label: "Model", value: omlx.stats.activeModel }]
              : []),
            ...(health.omlx.sampledAt
              ? [{ label: "Sampled", value: formatRelativeTime(health.omlx.sampledAt) }]
              : []),
          ]}
          warning={health.omlx.isStale ? "Data is stale" : undefined}
        />

        {/* GitHub card */}
        <HealthCard
          title="GitHub"
          ok={health.github.configured}
          metrics={[
            { label: "Configured", value: health.github.configured ? "Yes" : "No" },
          ]}
        />

        {/* SQLite card */}
        <HealthCard
          title="SQLite"
          ok={health.sqlite.ok}
          metrics={[
            { label: "Status", value: health.sqlite.ok ? "Healthy" : "Down" },
          ]}
        />
      </div>

      {/* SSE Clients */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-sm font-semibold text-zinc-100">SSE Clients</h3>
        <p className="mt-1 font-mono text-lg text-zinc-200">{health.sseClients}</p>
      </div>
    </div>
  );
}

interface HealthCardProps {
  title: string;
  ok: boolean;
  metrics: { label: string; value: string }[];
  warning?: string;
}

function HealthCard({ title, ok, metrics, warning }: HealthCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
          />
          <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        </div>
      </div>

      <dl className="mt-3 space-y-2">
        {metrics.map((metric) => (
          <div key={metric.label} className="flex items-center justify-between">
            <dt className="text-xs text-zinc-500">{metric.label}</dt>
            <dd className="font-mono text-xs text-zinc-300">{metric.value}</dd>
          </div>
        ))}
      </dl>

      {warning && (
        <p className="mt-3 rounded bg-yellow-950/20 px-2 py-1 text-xs text-yellow-400">
          {warning}
        </p>
      )}
    </div>
  );
}

function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
