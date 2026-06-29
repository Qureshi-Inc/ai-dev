"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { StateBadge } from "./StateBadge";
import { useElapsedTime } from "@/lib/hooks";
import type { Project } from "@/lib/api";

interface ProjectCardProps {
  project: Project;
  className?: string;
}

export function ProjectCard({ project, className }: ProjectCardProps) {
  const elapsed = useElapsedTime(project.createdAt);

  const tasks = project.tasks ?? [];
  const tasksCompleted = tasks.filter((t) => t.state === "completed").length;
  const tasksTotal = tasks.length;

  return (
    <Link
      href={`/projects/${project.id}`}
      className={cn(
        "block rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 transition-colors hover:border-zinc-700 hover:bg-zinc-900",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-zinc-100">
              {project.title}
            </h3>
            <StateBadge state={project.state} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
            {tasksTotal > 0 && (
              <span>
                {tasksCompleted}/{tasksTotal} tasks
              </span>
            )}
            {project.repo && (
              <span className="truncate font-mono">
                {project.owner}/{project.repo}
              </span>
            )}
            {project.issueNumber > 0 && (
              <span className="text-blue-400">
                #{project.issueNumber}
              </span>
            )}
          </div>
          <div className="mt-1 text-[11px] text-zinc-500">
            {elapsed}
          </div>
        </div>
      </div>
    </Link>
  );
}
