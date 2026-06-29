"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import { useState, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTask, formatDuration, useElapsedTime } from "@/lib/hooks";
import { api } from "@/lib/api";
import { StateBadge } from "@/components/StateBadge";
import { ConfirmSheet } from "@/components/ConfirmSheet";
import { Button } from "@/components/ui/button";

export default function TaskDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const { data: task, isLoading, error } = useTask(id);
  const queryClient = useQueryClient();

  const retryMutation = useMutation({
    mutationFn: () => api.retryTask(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["task", id] }),
  });

  const [showRetryConfirm, setShowRetryConfirm] = useState(false);

  const elapsed = useElapsedTime(task?.createdAt);

  const handleRetry = useCallback(() => {
    retryMutation.mutate();
    setShowRetryConfirm(false);
  }, [retryMutation]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
      </div>
    );
  }

  if (error || !task) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-800/50 bg-red-950/20 p-4 text-sm text-red-400">
          Failed to load task.
        </div>
      </div>
    );
  }

  const subtasks: string[] = task.subtasks ? JSON.parse(task.subtasks) : [];

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Back link */}
      <Link
        href={`/projects/${task.projectId}`}
        className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"
      >
        <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Project
      </Link>

      {/* Header */}
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-zinc-100">{task.title}</h1>
          <StateBadge state={task.state} />
        </div>
        {task.description && (
          <p className="mt-2 text-sm text-zinc-400">{task.description}</p>
        )}
        <p className="mt-2 font-mono text-xs text-zinc-500">
          Duration: {elapsed}
        </p>
      </div>

      {/* Subtasks */}
      {subtasks.length > 0 && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Subtasks
          </h2>
          <ul className="space-y-1">
            {subtasks.map((subtask, i) => (
              <li
                key={i}
                className="flex items-center gap-2 rounded bg-zinc-900/50 px-3 py-2 text-sm text-zinc-300"
              >
                <span className="text-zinc-600">{i + 1}.</span>
                {subtask}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Execution details */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Execution
        </h2>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {task.branch && (
              <DetailItem label="Branch" value={task.branch} mono />
            )}
            {task.worktreePath && (
              <DetailItem label="Worktree" value={task.worktreePath} mono />
            )}
            {task.prNumber && (
              <DetailItem label="Pull Request" value={`PR #${task.prNumber}`} />
            )}
            {task.headSha && (
              <DetailItem label="HEAD SHA" value={task.headSha.slice(0, 8)} mono />
            )}
            <DetailItem
              label="Retries"
              value={`${task.retryCount}`}
            />
          </dl>
        </div>
      </section>

      {/* Last error */}
      {task.lastError && (
        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Last Error
          </h2>
          <div className="rounded-lg border border-red-800/30 bg-red-950/10 p-4">
            <p className="font-mono text-xs text-red-400 whitespace-pre-wrap">
              {task.lastError}
            </p>
          </div>
        </section>
      )}

      {/* Retry button */}
      {task.state === "failed" && (
        <div>
          <Button
            className="min-h-[44px]"
            onClick={() => setShowRetryConfirm(true)}
            disabled={retryMutation.isPending}
          >
            {retryMutation.isPending ? "Retrying..." : "Retry Task"}
          </Button>
        </div>
      )}

      <ConfirmSheet
        open={showRetryConfirm}
        title="Retry Task"
        description="This will create a new attempt to execute this task. Previous attempt data will be preserved."
        confirmLabel="Retry"
        onConfirm={handleRetry}
        onCancel={() => setShowRetryConfirm(false)}
      />
    </div>
  );
}

function DetailItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
        {label}
      </dt>
      <dd className={`mt-0.5 text-sm text-zinc-200 ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
