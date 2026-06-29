"use client";

import { cn } from "@/lib/utils";

type StateType =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "blocked"
  | "skipped"
  | "success";

const stateStyles: Record<StateType, string> = {
  pending: "bg-zinc-700 text-zinc-200",
  running: "bg-blue-600/20 text-blue-400 border-blue-500/30",
  waiting_approval: "bg-yellow-600/20 text-yellow-400 border-yellow-500/30",
  completed: "bg-green-600/20 text-green-400 border-green-500/30",
  success: "bg-green-600/20 text-green-400 border-green-500/30",
  failed: "bg-red-600/20 text-red-400 border-red-500/30",
  cancelled: "bg-zinc-600/20 text-zinc-400 border-zinc-500/30",
  blocked: "bg-zinc-600/20 text-zinc-400 border-zinc-500/30",
  skipped: "bg-zinc-600/20 text-zinc-400 border-zinc-500/30",
};

const stateLabels: Record<StateType, string> = {
  pending: "Pending",
  running: "Running",
  waiting_approval: "Waiting",
  completed: "Completed",
  success: "Success",
  failed: "Failed",
  cancelled: "Cancelled",
  blocked: "Blocked",
  skipped: "Skipped",
};

interface StateBadgeProps {
  state: string;
  className?: string;
  pulse?: boolean;
}

export function StateBadge({ state, className, pulse }: StateBadgeProps) {
  const normalizedState = (state as StateType) || "pending";
  const styles = stateStyles[normalizedState] || stateStyles.pending;
  const label = stateLabels[normalizedState] || state;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold",
        styles,
        className
      )}
    >
      {(normalizedState === "running" || pulse) && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
        </span>
      )}
      {label}
    </span>
  );
}
