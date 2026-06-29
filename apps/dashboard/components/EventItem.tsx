"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { DashboardEvent } from "@/lib/api";

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

interface EventItemProps {
  event: DashboardEvent;
  className?: string;
}

const severityStyles: Record<string, string> = {
  info: "border-l-blue-500/50",
  warn: "border-l-yellow-500/50",
  error: "border-l-red-500/50",
};

const sourceBadgeStyles: Record<string, string> = {
  github: "bg-purple-600/20 text-purple-400",
  omlx: "bg-cyan-600/20 text-cyan-400",
  agent: "bg-blue-600/20 text-blue-400",
  system: "bg-zinc-600/20 text-zinc-400",
};

// Extract optional fields from the data payload
function extractEventFields(event: DashboardEvent) {
  const d = (event.data ?? {}) as Record<string, unknown>;
  return {
    source: (d.source as string) || event.type.split(".")[0] || "system",
    severity: (d.severity as string) || "info",
    message: (d.message as string) || event.type,
    projectId: (d.projectId as string | number | undefined) ?? undefined,
    taskId: (d.taskId as string | number | undefined) ?? undefined,
  };
}

export function EventItem({ event, className }: EventItemProps) {
  const { source, severity, message, projectId, taskId } = extractEventFields(event);

  const linkHref = projectId
    ? taskId
      ? `/tasks/${taskId}`
      : `/projects/${projectId}`
    : undefined;

  const content = (
    <div
      className={cn(
        "border-l-2 py-2 pl-3 pr-2",
        severityStyles[severity] || severityStyles.info,
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                sourceBadgeStyles[source] || sourceBadgeStyles.system
              )}
            >
              {source}
            </span>
            <span className="truncate text-sm text-zinc-200">
              {message}
            </span>
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-zinc-500">
          {formatRelativeTime(event.timestamp)}
        </span>
      </div>
    </div>
  );

  if (linkHref) {
    return (
      <Link href={linkHref} className="block hover:bg-zinc-900/50 transition-colors rounded">
        {content}
      </Link>
    );
  }

  return content;
}
