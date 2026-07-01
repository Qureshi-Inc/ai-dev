# Durable Execution Plan

## Current Architecture

ai-dev is a Node.js/TypeScript Express server using:
- **SQLite** (better-sqlite3) for all state
- **Custom SerialQueue** (in-memory FIFO, concurrency 1)
- **Claude Code CLI** for coding (routed to oMLX/Qwen via ANTHROPIC_BASE_URL)
- **Bedrock SDK** for planning (Claude Opus direct API)
- **GitHub App** for webhooks, PRs, CI monitoring
- **Docker** deployment on Ubuntu server

### Current Execution Flow

1. Webhook triggers → queue enqueues → `runIssue` or `advanceProject`
2. Planning: Bedrock SDK → tasks stored in `project_tasks`
3. Execution: `claudeCodeExecutor.executeTask()` runs Claude Code in a worktree
4. Merge: push → open PR → monitor CI → merge
5. Advance: next task or next phase

### Identified Failure Points

1. **No TaskRun persistence** — when the process dies mid-execution, all context is lost
2. **No step tracking** — can't determine which sub-step (worktree, coding, validation, push) completed
3. **No attempt history** — retries overwrite state instead of appending
4. **No heartbeat** — can't distinguish "still working" from "crashed"
5. **No failure classification** — all errors treated the same
6. **No verification pipeline** — trusts Claude Code's exit code
7. **Worktree state not durable** — stale worktrees from crashes collide with new runs
8. **Context not bounded** — no token estimation or budget
9. **No idempotency** — restarting can create duplicate branches/PRs
10. **No event log** — can't reconstruct what happened

## Implementation Strategy

### Why NOT Temporal

Temporal requires:
- A separate server process (temporal-server)
- PostgreSQL or Cassandra for its persistence
- A separate UI service
- SDK integration that fundamentally changes the codebase

For a single-server SQLite project, this is massive overkill. We get equivalent durability by:
- Persisting every step transition in SQLite
- Using WAL mode for crash safety
- Implementing idempotent activities with checksums
- Adding heartbeats to detect worker death

### What We Build Instead

A **SQLite-backed durable workflow engine** that provides:
- Persisted state machine with step-level granularity
- Append-only event log per task run
- Attempt tracking with failure classification
- Heartbeat-based worker health detection
- Idempotent activity replay
- Bounded context builder with token estimation
- Deterministic verification pipeline
- Observable execution via API and dashboard

### Files to Create

```
src/
  workflow/
    engine.ts           — Workflow orchestrator (replaces ad-hoc execution)
    stateMachine.ts     — Validated state transitions
    taskRun.ts          — TaskRun, TaskAttempt, TaskRunEvent persistence
    worktreeManager.ts  — Isolated worktree lifecycle
    contextBuilder.ts   — Bounded context with token budget
    codingAgent.ts      — oMLX Claude Code client with concurrency control
    verifier.ts         — Deterministic verification pipeline
    failureClassifier.ts — Structured error classification
    artifacts.ts        — Artifact storage
    contracts.ts        — Task contract validation
    heartbeat.ts        — Worker heartbeat and stale detection
  storage/
    taskRunDb.ts        — Migrations for new tables
    taskRunState.ts     — CRUD for TaskRun, Attempt, Event, Artifact
```

### Files to Modify

- `src/agent/projectOrchestrator.ts` — delegate to workflow engine
- `src/agent/claudeCodeExecutor.ts` — replace with workflow-managed execution
- `src/config.ts` — add workflow engine config
- `src/index.ts` — boot workflow engine
- `src/dashboard.ts` — show TaskRun state
- `src/dashboardApi.ts` — expose TaskRun API

### Database Migrations

Add tables: `task_runs`, `task_attempts`, `task_run_events`, `task_artifacts`

### Implementation Milestones

1. Data model + state machine (persistence layer)
2. Workflow engine (orchestration)
3. Worktree manager (isolation)
4. Context builder (bounded input)
5. Coding agent client (oMLX concurrency)
6. Verification pipeline (deterministic checks)
7. Failure classifier (structured errors)
8. API + Dashboard (observability)
9. Tests (reliability coverage)
10. Documentation + deployment
