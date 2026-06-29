"use client";

import { useState, useMemo } from "react";
import { useProjects } from "@/lib/hooks";
import { ProjectCard } from "@/components/ProjectCard";
import type { Project } from "@/lib/api";

type FilterTab = "all" | "active" | "completed" | "failed";

const filterTabs: { label: string; value: FilterTab }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Completed", value: "completed" },
  { label: "Failed", value: "failed" },
];

function filterProjects(projects: Project[], filter: FilterTab): Project[] {
  switch (filter) {
    case "active":
      return projects.filter(
        (p) => p.state === "running" || p.state === "waiting_approval" || p.state === "pending"
      );
    case "completed":
      return projects.filter((p) => p.state === "completed");
    case "failed":
      return projects.filter((p) => p.state === "failed" || p.state === "cancelled");
    default:
      return projects;
  }
}

export default function ProjectsPage() {
  const [filter, setFilter] = useState<FilterTab>("all");
  const { data: projects, isLoading, error } = useProjects();

  const filtered = useMemo(
    () => filterProjects(projects || [], filter),
    [projects, filter]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-4 text-sm text-red-400">
          Failed to load projects.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-zinc-100">Projects</h1>
        <span className="text-xs text-zinc-500">{filtered.length} total</span>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
        {filterTabs.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setFilter(tab.value)}
            className={`min-h-[36px] flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === tab.value
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-400 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Project list */}
      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-8 text-center">
            <p className="text-sm text-zinc-500">No projects found</p>
          </div>
        ) : (
          filtered.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))
        )}
      </div>
    </div>
  );
}
