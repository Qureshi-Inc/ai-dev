# ai-dev — Autonomous Coding Agent

A self-hosted autonomous coding agent that turns GitHub issues into merged pull requests.
Combines **Claude Opus** (via Amazon Bedrock) for intelligent planning with **Qwen 3.6 35B**
(via local oMLX on Apple Silicon) for code generation. Runs overnight, builds entire features
while you sleep.

## How it works

```
You create a GitHub issue
         │
         ▼  (add "ai-dev-project" label)
┌─────────────────────────────────────────────────────┐
│              ai-dev orchestrator                      │
│                                                       │
│  1. PLANNING (Bedrock → Claude Opus 4.6)             │
│     Large issues → Epic Planner splits into phases    │
│     Each phase → Task planner generates tasks         │
│                                                       │
│  2. APPROVAL                                          │
│     Posts plan on the issue → waits for /ai-dev       │
│     approve                                           │
│                                                       │
│  3. EXECUTION (oMLX → Qwen 3.6 35B)                 │
│     For each task:                                    │
│       • Create isolated git worktree                  │
│       • Run Claude Code headlessly via oMLX           │
│       • Validate diff (size, paths, deletions)        │
│       • Auto-rebase on merge conflicts                │
│       • Open PR → monitor CI → merge                  │
│       • Next task                                     │
│                                                       │
│  4. PHASE ADVANCEMENT                                 │
│     Phase complete → clear caches → re-read repo      │
│     → plan next phase → execute → repeat              │
│                                                       │
│  5. COMPLETION                                        │
│     Post final report on the issue                    │
└─────────────────────────────────────────────────────┘
```

## The split-brain model

| Role | Provider | Model | Why |
|------|----------|-------|-----|
| **Planning** | Amazon Bedrock | Claude Opus 4.6 | Smart enough to decompose complex projects into phased, dependency-aware tasks |
| **Scaffolding** | oMLX (local) | Qwen3-Coder-Next 4-bit | Fast for first task in each phase (project setup, boilerplate). ~3x faster than 35B |
| **Coding** | oMLX (local) | Qwen 3.6 35B (MLX 8-bit) | Precise for implementation tasks (features, logic, tests) |

The planner (Opus) does the thinking. The fast coder (Qwen-Next 4bit) scaffolds. The precise
coder (Qwen 35B) implements features. ai-dev orchestrates everything: worktrees, PRs, CI
monitoring, merge conflict resolution, and memory management.

Task 0 in each phase (typically scaffolding/setup) uses the fast model. All subsequent tasks
use the precise 35B model for higher quality code.

## Trigger labels

| Label | Behavior |
|-------|----------|
| `ai-dev` | Simple single-task: parse → plan → implement → PR → CI → merge |
| `ai-dev-pro` | Same as above but uses the "pro" model for all steps |
| `ai-dev-epic` | Per-step commits, pro model, left for manual review (no auto-merge) |
| `ai-dev-project` | **Project Mode**: phased multi-task execution with Opus planning |

## Project Mode (ai-dev-project)

For complex issues. The orchestrator:

1. Detects if the issue is "epic-sized" (>5000 chars)
2. **Epic Planner** (Bedrock/Opus) splits it into 3-6 sequential phases
3. Posts the phase plan on the issue, waits for `/ai-dev approve`
4. Executes phases sequentially, each producing multiple merged PRs
5. Between phases: clears oMLX caches, re-reads repo, plans next phase fresh
6. Posts a final report when all phases complete

### Commands (via issue comments)

| Command | Effect |
|---------|--------|
| `/ai-dev approve` | Start execution (after reviewing the plan) |
| `/ai-dev status` | Refresh the status comment |
| `/ai-dev pause` | Pause execution |
| `/ai-dev resume` | Resume a paused project |
| `/ai-dev retry <N>` | Retry failed task N |
| `/ai-dev cancel` | Cancel the project |

### Phase flow

```
Issue #52: "Build SocialPlanner MVP"
     │
     ▼ Epic Planner (Bedrock/Opus)
┌────────────────────────────────────────┐
│ Phase 1: Set up foundation and auth    │ ← 5 tasks → 5 PRs merged
│ Phase 2: Build post CRUD              │ ← 7 tasks → 7 PRs merged
│ Phase 3: Build calendar view          │ ← 6 tasks → 6 PRs merged
│ Phase 4: Build dashboard              │ ← 8 tasks → 8 PRs merged
│ Phase 5: Tests and deployment         │ ← 4 tasks → 4 PRs merged
└────────────────────────────────────────┘
     │
     ▼ Final report posted on issue
```

Each phase plans against the **current repo state** (not predictions), so later phases
adapt to what earlier phases actually built.

## Dashboard

Live monitoring at `https://ai-dev.qureshi.io/dashboard`:

- Project overview with phase progress
- Drill into phases → see tasks → see task details
- System health (ai-dev, oMLX, GitHub)
- oMLX metrics (model memory, generation TPS, cache efficiency, pressure)
- Action buttons (approve, pause, resume, cancel, retry)
- Auto-refreshes every 10 seconds

## Architecture

```
src/
  index.ts                 Express server, route registration, boot sequence
  config.ts                Zod-validated environment config
  dashboard.ts             Self-contained HTML dashboard (inline CSS/JS)
  dashboardApi.ts          Authenticated REST API for dashboard data
  sse.ts                   Server-Sent Events with ring buffer replay
  omlx/monitor.ts          oMLX stats sampler (health, models, admin API)
  agent/
    projectOrchestrator.ts State machine: plan → approve → phase → execute → advance
    epicPlanner.ts         Bedrock SDK: splits large issues into phases
    taskMaster.ts          Bedrock SDK: generates dependency-aware task plans
    claudeCodeExecutor.ts  Execution: worktrees, Claude Code, validation, CI, merge
    projectProgress.ts     Live status comment on GitHub issue
    projectCommands.ts     /ai-dev command parser
    orchestrator.ts        Simple mode state machine (ai-dev/ai-dev-pro/ai-dev-epic)
  storage/
    db.ts                  SQLite with WAL
    projectDb.ts           Migrations: projects, project_tasks, project_phases
    projectState.ts        CRUD for projects, tasks, phases, dependency resolution
    state.ts               Issue job CRUD
  github/
    app.ts                 GitHub App authentication
    webhooks.ts            Webhook dispatch (issues, labels, comments, workflow_run)
    repo.ts                PR/issue/merge operations
    ci.ts                  CI outcome aggregation
  llm/
    client.ts              oMLX (OpenAI-compatible) inference client
  router/
    router.ts              Deterministic task → model routing
```

## Infrastructure

| Component | Where | Purpose |
|-----------|-------|---------|
| ai-dev orchestrator | Docker (Ubuntu server) | State machine, webhooks, git, PRs |
| ai-dev dashboard | Same container, `/dashboard` | Monitoring UI |
| oMLX | Mac Studio M2 Max 96GB (LAN) | Local LLM inference |
| Qwen 3.6 35B | Loaded in oMLX (~35 GB) | Code generation model |
| Claude Opus 4.6 | AWS Bedrock (us-east-1) | Planning model |
| Cloudflare Tunnel | Docker network | Public HTTPS ingress |
| SQLite | `data/agent.db` | All persistent state |
| Task Master | Installed globally (Node 20) | Optional CLI for task planning |

## Security

- Claude Code gets a **sanitized environment**: no GitHub App key, webhook secret, SSH keys, or Docker socket
- Workflow edits (`.github/workflows/`) are **always blocked** in project mode
- Deployment file edits require explicit opt-in (`CLAUDE_CODE_ALLOW_DEPLOY_EDITS=true`)
- Diff limits enforced: max files, max bytes, max net deletions
- ai-dev independently validates all changes (never trusts Claude Code's claims)
- Merge conflict auto-rebase with abort on real conflicts
- oMLX memory management: auto-clear caches between phases, before each task

## Prerequisites

- Node.js 20+ (for Task Master); Docker image uses Node 20
- oMLX running on LAN with Qwen model loaded (`LMSTUDIO_BASE_URL`)
- AWS credentials configured for Bedrock access (Opus 4.6 in us-east-1)
- A GitHub App installed on target repo(s)
- Cloudflare Tunnel for webhook ingress

## Quick start

```bash
npm install
cp .env.example .env   # configure all required vars
npm run dev            # local dev with tsx watch

# Or with Docker:
docker compose up -d --build
```

## Configuration

### Required

| Variable | Description |
|----------|-------------|
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY` or `GITHUB_PRIVATE_KEY_PATH` | App private key |
| `GITHUB_WEBHOOK_SECRET` | Webhook signature secret |
| `LMSTUDIO_BASE_URL` | oMLX endpoint (e.g., `http://192.168.4.38:1234/v1`) |
| `LMSTUDIO_API_KEY` | oMLX Bearer token |
| `REPO_ALLOWLIST` | Comma-separated repos (e.g., `Qureshi-Inc/*`) |

### Project Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `PROJECT_MODE_ENABLED` | `false` | Enable Project Mode |
| `PROJECT_PLAN_VIA_CLAUDE_CODE` | `false` | Use Bedrock for planning |
| `PROJECT_LABEL` | `ai-dev-project` | Trigger label |
| `PROJECT_MAX_TASKS` | `50` | Max tasks per phase |

### Execution engine

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CODE_BIN` | `claude` | Claude Code binary |
| `CLAUDE_CODE_TIMEOUT_MS` | `900000` | Per-task timeout (15 min) |
| `CLAUDE_CODE_MAX_RETRIES` | `3` | Code generation retries |
| `CLAUDE_CODE_CI_MAX_RETRIES` | `3` | CI fix retries |
| `CLAUDE_CODE_MAX_CHANGED_FILES` | `30` | Safety limit |
| `CLAUDE_CODE_MAX_DIFF_BYTES` | `500000` | Safety limit |
| `CLAUDE_CODE_MAX_NET_DELETIONS` | `500` | Safety limit |
| `CLAUDE_CODE_PRESERVE_FAILED_WORKTREES` | `true` | Keep for debugging |
| `CLAUDE_CODE_TEST_CMD` | `""` | Test command to run |

### oMLX monitoring

| Variable | Default | Description |
|----------|---------|-------------|
| `OMLX_MONITORING_ENABLED` | `true` | Dashboard oMLX stats |
| `OMLX_ADMIN_STATS_ENABLED` | `false` | Rich admin API stats |
| `OMLX_STATS_INTERVAL_MS` | `5000` | Polling interval |
| `LLM_TTL_SECONDS` | `300` | Model unload after idle |

### Simple mode

| Variable | Default | Description |
|----------|---------|-------------|
| `TRIGGER_LABEL` | `ai-dev` | Simple mode trigger |
| `MAX_RETRIES` | `5` | CI fix attempts |
| `AUTO_MERGE` | `true` | Merge on green CI |
| `MERGE_METHOD` | `squash` | squash/merge/rebase |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /api/github/webhooks` | GitHub webhook receiver |
| `GET /healthz` | Liveness + queue depth |
| `GET /status` | Active jobs |
| `GET /dashboard` | Monitoring dashboard |
| `GET /events/stream` | SSE event stream |
| `GET /api/dashboard/*` | Dashboard REST API |

## GitHub App setup

Create a GitHub App with:

- **Permissions:** Contents (R&W), Pull requests (R&W), Issues (R&W), Actions (Read), Checks (Read), Metadata (Read)
- **Events:** Issues, Workflow run, Issue comment
- **Webhook URL:** `https://ai-dev.qureshi.io/api/github/webhooks`

## Guardrails

- One active branch/job per issue (UNIQUE constraint)
- Never auto-merges unless all CI runs are green
- Repo allowlist + trigger-user allowlist
- Signature-verified webhooks
- Path-traversal-guarded file writes
- Every model call logged to `model_calls` table
- oMLX memory pressure auto-clearing between phases
- Merge conflict detection with automatic rebase
- Dependency cascade protection (targeted skipping, not blanket)
- No-op task handling (verification tasks that produce no changes succeed)

## Compatibility check

```bash
npm run check:claude-code   # Verify Claude Code + oMLX connectivity
```

## Smoke test

```bash
npm run smoke   # Exercises router, storage, patches, CI logs, webhooks
```
