// ---------------------------------------------------------------------------
// Workflow Engine — orchestrates the full task execution lifecycle
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import type { Project, ProjectTask, ProjectPhase } from "../types.js";
import { TaskRunStatus } from "./stateMachine.js";
import { classifyFailure, type ClassifiedFailure } from "./failureClassifier.js";
import { WorktreeManager, type WorktreeInfo } from "./worktreeManager.js";
import { ContextBuilder, type ContextManifest } from "./contextBuilder.js";
import { CodingAgentClient } from "./codingAgent.js";
import { VerificationRunner, type VerificationResult } from "./verifier.js";
import type * as TaskRunState from "../storage/taskRunState.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ExecuteTaskParams {
  project: Project;
  task: ProjectTask;
  phase?: ProjectPhase;
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

interface ExecuteTaskResult {
  success: boolean;
  commitSha?: string;
  prNumber?: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private log = logger.child({ component: "WorkflowEngine" });

  constructor(
    private taskRunState: typeof TaskRunState,
    private worktreeManager: WorktreeManager,
    private contextBuilder: ContextBuilder,
    private codingAgent: CodingAgentClient,
    private verifier: VerificationRunner,
  ) {}

  /**
   * Execute a single task through the full workflow.
   */
  async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
    const { project, task, phase, token, owner, repo, baseBranch } = params;
    const log = this.log.child({ projectId: project.id, taskId: task.id });

    // 1. Check for existing active run (prevent duplicates)
    const existingRun = this.taskRunState.getActiveRunForTask(task.id);
    if (existingRun) {
      log.warn({ existingRunId: existingRun.id }, "active run already exists for task");
      return { success: false };
    }

    // 2. Create TaskRun record
    const workflowId = randomUUID();
    const taskRun = this.taskRunState.createTaskRun({
      projectId: project.id,
      phaseId: phase?.id ?? null,
      taskId: task.id,
      workflowId,
      workerId: `worker-${process.pid}`,
    });
    log.info({ taskRunId: taskRun.id, workflowId }, "task run created");

    let lastFailure: ClassifiedFailure | undefined;
    let worktreeInfo: WorktreeInfo | undefined;

    try {
      // Transition: QUEUED -> VALIDATING -> PREPARING_WORKTREE
      this.transitionStep(taskRun.id, TaskRunStatus.VALIDATING, "validate");
      this.transitionStep(taskRun.id, TaskRunStatus.PREPARING_WORKTREE, "prepare_worktree");

      // Create worktree once, reuse across retries
      worktreeInfo = await this.worktreeManager.create(taskRun.id, task.id, baseBranch, token, owner, repo);

      this.taskRunState.appendEvent(taskRun.id, {
        eventType: "step_complete",
        step: "prepare_worktree",
        message: `Worktree created at ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`,
        metadata: { baseSha: worktreeInfo.baseSha },
      });

      // Step through the workflow with retry loop
      for (let attempt = 1; attempt <= config.claudeCode.maxRetries + 1; attempt++) {
        const attemptRecord = this.taskRunState.createAttempt(taskRun.id, attempt, {
          modelProvider: "omlx",
          modelName: config.llm.modelPro,
        });

        try {
          const result = await this.executeAttempt({
            taskRun,
            attempt,
            attemptRecord,
            params,
            worktreeInfo,
            lastFailure,
          });

          if (result.success) {
            // Mark attempt succeeded
            this.taskRunState.completeAttempt(attemptRecord.id, "succeeded");

            // Mark run completed
            this.taskRunState.updateTaskRunStatus(taskRun.id, TaskRunStatus.COMPLETED, {
              resultingCommitSha: result.commitSha ?? null,
            });

            this.taskRunState.appendEvent(taskRun.id, {
              attemptId: attemptRecord.id,
              eventType: "completed",
              message: `Task completed successfully${result.commitSha ? ` (commit: ${result.commitSha.slice(0, 8)})` : ""}`,
            });

            // Clean up worktree on success
            await this.worktreeManager.cleanup(worktreeInfo, false);
            return result;
          }

          // Attempt produced no success but didn't throw (no changes case)
          this.taskRunState.completeAttempt(attemptRecord.id, "failed", {
            type: "AGENT_NO_CHANGES",
            message: "Agent produced no changes",
            retryable: attempt < config.claudeCode.maxRetries + 1,
          });

          lastFailure = {
            type: classifyFailure("Agent produced no changes").type,
            message: "Agent produced no changes",
            retryable: true,
            requiresContextReduction: false,
          };
        } catch (err) {
          // Classify the failure
          const classified = classifyFailure(err, { step: taskRun.currentStep ?? undefined });
          lastFailure = classified;

          log.warn(
            { attempt, failureType: classified.type, retryable: classified.retryable },
            "attempt failed",
          );

          // Mark attempt failed
          this.taskRunState.completeAttempt(attemptRecord.id, "failed", {
            type: classified.type,
            message: classified.message,
            retryable: classified.retryable,
          });

          this.taskRunState.appendEvent(taskRun.id, {
            attemptId: attemptRecord.id,
            eventType: "failure",
            step: taskRun.currentStep,
            message: classified.message,
            metadata: { type: classified.type, retryable: classified.retryable },
          });

          // Decide: retry or block
          if (!classified.retryable || attempt > config.claudeCode.maxRetries) {
            // Non-retryable or exhausted retries -> FAILED
            this.taskRunState.updateTaskRunStatus(taskRun.id, TaskRunStatus.FAILED, {
              failureType: classified.type,
              failureMessage: classified.message,
              retryable: false,
            });

            // Clean up worktree
            await this.worktreeManager.cleanup(
              worktreeInfo,
              config.claudeCode.preserveFailedWorktrees,
            );

            return { success: false };
          }

          // Retryable: transition to REPAIRING, then reset worktree for next attempt
          this.transitionStep(taskRun.id, TaskRunStatus.REPAIRING, "repairing");

          const { run: execRun } = await import("../utils/exec.js");
          await execRun("git", ["-C", worktreeInfo.path, "reset", "--hard", worktreeInfo.baseSha], {
            allowFailure: true,
          });
          await execRun("git", ["-C", worktreeInfo.path, "clean", "-fd"], {
            allowFailure: true,
          });
        }
      }

      // All attempts exhausted
      this.taskRunState.updateTaskRunStatus(taskRun.id, TaskRunStatus.FAILED, {
        failureType: lastFailure?.type ?? "UNKNOWN",
        failureMessage: lastFailure?.message ?? "All attempts exhausted",
        retryable: false,
      });

      await this.worktreeManager.cleanup(worktreeInfo, config.claudeCode.preserveFailedWorktrees);

      return { success: false };
    } catch (err) {
      // Unexpected top-level error
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "unexpected workflow engine error");

      try {
        this.taskRunState.updateTaskRunStatus(taskRun.id, TaskRunStatus.FAILED, {
          failureType: "UNKNOWN",
          failureMessage: message,
          retryable: false,
        });
      } catch {
        // DB might be in bad state
      }

      if (worktreeInfo) {
        await this.worktreeManager.cleanup(worktreeInfo, config.claudeCode.preserveFailedWorktrees);
      }

      return { success: false };
    }
  }

  /**
   * Resume a task run that was interrupted.
   */
  async resumeRun(taskRunId: number): Promise<void> {
    const taskRun = this.taskRunState.getTaskRunById(taskRunId);
    if (!taskRun) {
      this.log.warn({ taskRunId }, "cannot resume: task run not found");
      return;
    }

    if (taskRun.status === TaskRunStatus.COMPLETED ||
        taskRun.status === TaskRunStatus.FAILED ||
        taskRun.status === TaskRunStatus.CANCELLED) {
      this.log.warn({ taskRunId, status: taskRun.status }, "cannot resume: task run is terminal");
      return;
    }

    this.log.info({ taskRunId, status: taskRun.status }, "resuming task run");

    // Mark the run as failed with WORKER_LOST so the orchestrator can re-queue
    this.taskRunState.updateTaskRunStatus(taskRunId, TaskRunStatus.FAILED, {
      failureType: "WORKER_LOST",
      failureMessage: "Worker lost; run was interrupted and requires re-execution",
      retryable: true,
    });
  }

  /**
   * Cancel an active run.
   */
  async cancelRun(taskRunId: number): Promise<void> {
    const taskRun = this.taskRunState.getTaskRunById(taskRunId);
    if (!taskRun) {
      this.log.warn({ taskRunId }, "cannot cancel: task run not found");
      return;
    }

    if (taskRun.status === TaskRunStatus.COMPLETED ||
        taskRun.status === TaskRunStatus.FAILED ||
        taskRun.status === TaskRunStatus.CANCELLED) {
      this.log.warn({ taskRunId, status: taskRun.status }, "cannot cancel: already terminal");
      return;
    }

    this.log.info({ taskRunId }, "cancelling task run");

    this.taskRunState.updateTaskRunStatus(taskRunId, TaskRunStatus.CANCELLED, {
      failureType: "CANCELLED",
      failureMessage: "Run cancelled by request",
      retryable: false,
    });

    this.taskRunState.appendEvent(taskRunId, {
      eventType: "cancelled",
      message: "Task run cancelled",
    });

    // Clean up worktree if present
    if (taskRun.worktreePath) {
      const info: WorktreeInfo = {
        path: taskRun.worktreePath,
        branch: taskRun.branchName ?? "",
        baseSha: taskRun.startingCommitSha ?? "",
      };
      await this.worktreeManager.cleanup(info, false);
    }
  }

  /**
   * Detect and handle stale runs (worker died without proper cleanup).
   */
  async recoverStaleRuns(): Promise<void> {
    const heartbeatTimeout = 5 * 60 * 1000; // 5 minutes without heartbeat = stale
    const staleRuns = this.taskRunState.findStaleRuns(heartbeatTimeout);

    if (staleRuns.length === 0) return;

    this.log.info({ count: staleRuns.length }, "recovering stale runs");

    for (const staleRun of staleRuns) {
      this.log.warn(
        { taskRunId: staleRun.id, workerId: staleRun.workerId, status: staleRun.status },
        "marking stale run as failed (worker lost)",
      );

      try {
        this.taskRunState.updateTaskRunStatus(staleRun.id, TaskRunStatus.FAILED, {
          failureType: "WORKER_LOST",
          failureMessage: "Worker heartbeat timeout — run presumed dead",
          retryable: true,
        });

        this.taskRunState.appendEvent(staleRun.id, {
          eventType: "stale_recovery",
          message: `Stale run recovered (no heartbeat for ${heartbeatTimeout}ms)`,
        });
      } catch (err) {
        this.log.error({ taskRunId: staleRun.id, err }, "failed to recover stale run");
      }
    }

    // Also prune stale worktree directories
    await this.worktreeManager.pruneStale();
  }

  // ---------------------------------------------------------------------------
  // Private: single attempt execution
  // ---------------------------------------------------------------------------

  private async executeAttempt(opts: {
    taskRun: { id: number; currentStep: string | null };
    attempt: number;
    attemptRecord: { id: number };
    params: ExecuteTaskParams;
    worktreeInfo: WorktreeInfo;
    lastFailure?: ClassifiedFailure;
  }): Promise<ExecuteTaskResult> {
    const { taskRun, attempt, attemptRecord, params, worktreeInfo, lastFailure } = opts;
    const { project, task, token, owner, repo } = params;

    // Check agent availability
    if (!this.codingAgent.isAvailable()) {
      throw new Error("Coding agent is not available (concurrency limit or oMLX down)");
    }

    this.taskRunState.appendEvent(taskRun.id, {
      attemptId: attemptRecord.id,
      eventType: "step_start",
      step: "coding",
      message: `Attempt ${attempt}: starting`,
    });

    // --- Step: BUILDING_CONTEXT ---
    this.transitionStep(taskRun.id, TaskRunStatus.BUILDING_CONTEXT, "build_context");

    const contextManifest: ContextManifest = await this.contextBuilder.build({
      task,
      project,
      worktreePath: worktreeInfo.path,
      previousFailure: lastFailure,
      attemptNumber: attempt,
    });

    this.taskRunState.storeArtifact(taskRun.id, {
      attemptId: attemptRecord.id,
      artifactType: "prompt_manifest",
      name: `context-attempt-${attempt}`,
      content: JSON.stringify(contextManifest, null, 2),
    });

    this.taskRunState.appendEvent(taskRun.id, {
      attemptId: attemptRecord.id,
      eventType: "step_complete",
      step: "build_context",
      message: `Context built (${contextManifest.tokenEstimate} estimated tokens, ${contextManifest.relevantFiles.length} files)`,
    });

    // --- Step: CODING ---
    this.transitionStep(taskRun.id, TaskRunStatus.CODING, "coding");

    const prompt = this.buildPrompt(contextManifest, task, project);

    const agentResult = await this.codingAgent.execute({
      worktreePath: worktreeInfo.path,
      prompt,
      modelId: config.llm.modelPro,
      timeoutMs: config.claudeCode.timeoutMs,
      onHeartbeat: () => this.taskRunState.updateHeartbeat(attemptRecord.id),
    });

    this.taskRunState.storeArtifact(taskRun.id, {
      attemptId: attemptRecord.id,
      artifactType: "agent_output",
      name: `agent-output-attempt-${attempt}`,
      content: agentResult.stdout.slice(0, 50_000),
    });

    if (agentResult.exitCode !== 0 && !agentResult.stdout.trim()) {
      throw new Error(
        `Claude Code exited ${agentResult.exitCode}: ${agentResult.stderr.slice(0, 2000)}`,
      );
    }

    // --- Step: INSPECTING_DIFF ---
    this.transitionStep(taskRun.id, TaskRunStatus.INSPECTING_DIFF, "inspect_diff");

    // Stage all changes first
    const { run: execRun } = await import("../utils/exec.js");
    await execRun("git", ["-C", worktreeInfo.path, "add", "-A"]);

    const diffStats = await this.worktreeManager.getDiffStats(worktreeInfo);

    if (diffStats.changedFiles.length === 0) {
      // No changes — this might be OK (no-op task) if agent exited 0
      if (agentResult.exitCode === 0) {
        this.taskRunState.appendEvent(taskRun.id, {
          attemptId: attemptRecord.id,
          eventType: "step_complete",
          step: "inspect_diff",
          message: "No changes produced (agent exited 0 — treating as no-op)",
        });

        // Mark completed with no commit
        return { success: true };
      }
      // Agent errored and produced no changes — signal retry
      return { success: false };
    }

    this.taskRunState.storeArtifact(taskRun.id, {
      attemptId: attemptRecord.id,
      artifactType: "diff_summary",
      name: `diff-stats-attempt-${attempt}`,
      content: JSON.stringify(diffStats),
    });

    // Validate diff limits
    this.validateDiffLimits(diffStats);

    this.taskRunState.appendEvent(taskRun.id, {
      attemptId: attemptRecord.id,
      eventType: "step_complete",
      step: "inspect_diff",
      message: `Diff: ${diffStats.changedFiles.length} files, +${diffStats.additions}/-${diffStats.deletions}`,
    });

    // --- Step: VERIFYING ---
    this.transitionStep(taskRun.id, TaskRunStatus.VERIFYING, "verify");

    // Discover or use provided verification commands
    let verifyCommands = contextManifest.verificationCommands;
    if (verifyCommands.length === 0) {
      verifyCommands = this.verifier.discoverCommands(worktreeInfo.path);
    }

    let verificationResult: VerificationResult;
    if (verifyCommands.length > 0) {
      verificationResult = await this.verifier.run(worktreeInfo.path, verifyCommands);

      this.taskRunState.storeArtifact(taskRun.id, {
        attemptId: attemptRecord.id,
        artifactType: "test_output",
        name: `verification-attempt-${attempt}`,
        content: JSON.stringify(verificationResult, null, 2),
      });

      if (!verificationResult.passed) {
        const failedChecks = verificationResult.checks.filter((c) => !c.passed);
        const failureMsg = failedChecks
          .map((c) => `${c.name}: exit ${c.exitCode}\n${c.stderr.slice(0, 500)}`)
          .join("\n---\n");

        throw new Error(`Verification failed:\n${failureMsg}`);
      }
    } else {
      verificationResult = { passed: true, checks: [] };
    }

    this.taskRunState.appendEvent(taskRun.id, {
      attemptId: attemptRecord.id,
      eventType: "step_complete",
      step: "verify",
      message: `Verification passed (${verificationResult.checks.length} checks)`,
    });

    // --- Step: COMMITTING ---
    this.transitionStep(taskRun.id, TaskRunStatus.COMMITTING, "commit");

    const commitMessage = `ai-dev: ${task.title} [task-${task.id}/run-${taskRun.id}]`;
    const commitSha = await this.worktreeManager.commit(worktreeInfo, commitMessage);

    if (!commitSha) {
      // Should not happen since we already checked diff, but handle gracefully
      return { success: true };
    }

    // Push the branch
    await this.worktreeManager.push(worktreeInfo, owner, repo, token);

    this.taskRunState.storeArtifact(taskRun.id, {
      attemptId: attemptRecord.id,
      artifactType: "commit_sha",
      name: "resulting-commit",
      content: commitSha,
    });

    this.taskRunState.appendEvent(taskRun.id, {
      attemptId: attemptRecord.id,
      eventType: "step_complete",
      step: "commit",
      message: `Committed and pushed: ${commitSha.slice(0, 8)} on branch ${worktreeInfo.branch}`,
    });

    return { success: true, commitSha };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private transitionStep(taskRunId: number, status: TaskRunStatus, step: string): void {
    try {
      this.taskRunState.updateTaskRunStatus(taskRunId, status);
    } catch {
      // If the transition fails (e.g., already in the target state), just update the step
    }
    this.taskRunState.updateTaskRunStep(taskRunId, step);
  }

  private buildPrompt(manifest: ContextManifest, task: ProjectTask, project: Project): string {
    const sections: string[] = [];

    // Objective
    sections.push("## Objective");
    sections.push(manifest.objective);
    sections.push("");

    // Acceptance criteria
    if (manifest.acceptanceCriteria.length > 0) {
      sections.push("## Acceptance Criteria");
      for (const criterion of manifest.acceptanceCriteria) {
        sections.push(`- ${criterion}`);
      }
      sections.push("");
    }

    // Scope constraints
    sections.push("## Scope");
    if (manifest.scope.include.length > 0) {
      sections.push("Focus on:");
      for (const inc of manifest.scope.include) {
        sections.push(`  - ${inc}`);
      }
    }
    sections.push("Do NOT modify:");
    for (const exc of manifest.scope.exclude) {
      sections.push(`  - ${exc}`);
    }
    sections.push("");

    // Previous failure context (for retries)
    if (manifest.previousFailure) {
      sections.push("## Previous Failure (fix this)");
      sections.push(`Type: ${manifest.previousFailure.type}`);
      sections.push(`Message: ${manifest.previousFailure.message}`);
      sections.push(`Attempt: ${manifest.previousFailure.attempt}`);
      sections.push("");
      sections.push("Fix the issue described above. Do not repeat the same mistake.");
      sections.push("");
    }

    // Relevant files
    if (manifest.relevantFiles.length > 0) {
      sections.push("## Relevant Files");
      for (const file of manifest.relevantFiles) {
        sections.push(`- \`${file.path}\` — ${file.reason}`);
      }
      sections.push("");
    }

    // Verification commands
    if (manifest.verificationCommands.length > 0) {
      sections.push("## Verification");
      sections.push("After making changes, ensure these pass:");
      for (const cmd of manifest.verificationCommands) {
        sections.push(`  $ ${cmd}`);
      }
      sections.push("");
    }

    // Rules
    sections.push("## Rules");
    sections.push("- Implement ONLY this task. Do not implement other tasks.");
    sections.push("- Do NOT modify .github/workflows/ files.");
    sections.push("- Do NOT modify deployment files unless the task explicitly requires it.");
    sections.push("- Write tests if a test framework is set up.");
    sections.push("- Make sure the code compiles/builds correctly.");
    sections.push("- Keep changes focused and minimal.");
    sections.push("");

    // Project context
    sections.push(`## Project: ${project.title} (#${project.id})`);

    return sections.join("\n");
  }

  private validateDiffLimits(diffStats: {
    changedFiles: string[];
    additions: number;
    deletions: number;
    diffBytes: number;
  }): void {
    if (diffStats.changedFiles.length > config.claudeCode.maxChangedFiles) {
      throw new Error(
        `Too many changed files: ${diffStats.changedFiles.length} > ${config.claudeCode.maxChangedFiles}`,
      );
    }

    if (diffStats.diffBytes > config.claudeCode.maxDiffBytes) {
      throw new Error(
        `Diff too large: ${diffStats.diffBytes} bytes > ${config.claudeCode.maxDiffBytes}`,
      );
    }

    const netDeletions = diffStats.deletions - diffStats.additions;
    if (config.claudeCode.maxNetDeletions > 0 && netDeletions > config.claudeCode.maxNetDeletions) {
      throw new Error(
        `Net deletions exceed limit: ${netDeletions} > ${config.claudeCode.maxNetDeletions}`,
      );
    }
  }
}
