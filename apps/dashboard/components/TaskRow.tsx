"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { StateBadge } from "./StateBadge";
import { useElapsedTime } from "@/lib/hooks";
import type { ProjectTask } from "@/lib/api";

interface TaskRowProps {
  task: ProjectTask;
  className?: string;
}

export function TaskRow({ task, className }: TaskRowProps) {
  const elapsed = useElapsedTime(task.createdAt);

  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "flex items-center gap-3 rounded-lg border border-zinc-800/50 bg-zinc-900/30 p-3 transition-colors hover:border-zinc-700 hover:bg-zinc-900/60",
        "min-h-[44px]",
        className
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <StateBadge state={task.state} />
          <span className="truncate text-sm font-medium text-zinc-200">
            {task.title}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          {task.prNumber && (
            <span className="text-blue-400">PR #{task.prNumber}</span>
          )}
          {task.retryCount > 0 && (
            <span className="text-yellow-400">
              retry {task.retryCount}
            </span>
          )}
          <span>{elapsed}</span>
        </div>
      </div>
      <svg className="h-4 w-4 shrink-0 text-zinc-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}
