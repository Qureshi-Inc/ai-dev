"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useProject } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StateBadge } from "@/components/StateBadge";
import { TaskRow } from "@/components/TaskRow";
import { EventItem } from "@/components/EventItem";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";

export default function ProjectDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: project, isLoading, error } = useProject(id);
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["project", id] });
  };

  const approve = useMutation({ mutationFn: () => api.approveProject(id), onSuccess: invalidate });
  const pause = useMutation({ mutationFn: () => api.pauseProject(id), onSuccess: invalidate });
  const resume = useMutation({ mutationFn: () => api.resumeProject(id), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => api.cancelProject(id), onSuccess: invalidate });

  const [confirmAction, setConfirmAction] = useState<{
    type: "approve" | "pause" | "resume" | "cancel";
    title: string;
    description: string;
    variant?: "default" | "destructive";
  } | null>(null);

  const handleConfirm = useCallback(() => {
    if (!confirmAction) return;
    switch (confirmAction.type) {
      case "approve":
        approve.mutate();
        break;
      case "pause":
        pause.mutate();
        break;
      case "resume":
        resume.mutate();
        break;
      case "cancel":
        cancel.mutate();
        break;
    }
    setConfirmAction(null);
  }, [confirmAction, approve, pause, resume, cancel]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-4 text-sm text-red-400">
          Failed to load project.
        </div>
      </div>
    );
  }

  const tasks = project.tasks ?? [];
  const tasksCompleted = tasks.filter((t) => t.state === "completed").length;
  const tasksTotal = tasks.length;
  const progress = tasksTotal > 0 ? Math.round((tasksCompleted / tasksTotal) * 100) : 0;

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Back link */}
      <Link
        href="/projects"
        className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Projects
      </Link>

      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-100">{project.title}</h1>
          <StateBadge state={project.state} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-zinc-400">
          {project.issueNumber && (
            <span className="font-mono text-xs">
              {project.owner}/{project.repo}#{project.issueNumber}
            </span>
          )}
          {project.createdBy && <span>by {project.createdBy}</span>}
        </div>

        {/* Progress bar */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>
              {tasksCompleted}/{tasksTotal} tasks completed
            </span>
            <span>{progress}%</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full rounded-full bg-blue-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex flex-wrap gap-2">
        {project.state === "waiting_approval" && (
          <Button
            size="sm"
            className="min-h-[44px]"
            onClick={() =>
              setConfirmAction({
                type: "approve",
                title: "Approve Project",
                description: "This will start executing the project tasks.",
              })
            }
          >
            Approve
          </Button>
        )}
        {(project.state === "running" || project.state === "waiting_approval") && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-[44px]"
            onClick={() =>
              setConfirmAction({
                type: "pause",
                title: "Pause Project",
                description: "This will pause all running tasks. You can resume later.",
              })
            }
          >
            Pause
          </Button>
        )}
        {project.state === "pending" && (
          <Button
            size="sm"
            className="min-h-[44px]"
            onClick={() =>
              setConfirmAction({
                type: "resume",
                title: "Resume Project",
                description: "This will resume executing tasks from where it stopped.",
              })
            }
          >
            Resume
          </Button>
        )}
        {project.state !== "completed" &&
          project.state !== "failed" &&
          project.state !== "cancelled" && (
            <Button
              variant="destructive"
              size="sm"
              className="min-h-[44px]"
              onClick={() =>
                setConfirmAction({
                  type: "cancel",
                  title: "Cancel Project",
                  description:
                    "This will cancel the project and all remaining tasks. This cannot be undone.",
                  variant: "destructive",
                })
              }
            >
              Cancel
            </Button>
          )}
      </div>

      {/* Tasks */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Tasks ({tasks.length})
        </h2>
        <div className="space-y-2">
          {tasks.length === 0 ? (
            <p className="p-4 text-center text-sm text-zinc-500">No tasks</p>
          ) : (
            tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))
          )}
        </div>
      </section>

      {/* Confirm Sheet */}
      <ConfirmSheet
        open={!!confirmAction}
        title={confirmAction?.title || ""}
        description={confirmAction?.description || ""}
        confirmLabel={confirmAction?.type === "cancel" ? "Cancel Project" : "Confirm"}
        confirmVariant={confirmAction?.variant || "default"}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
}
