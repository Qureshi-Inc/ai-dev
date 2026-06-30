# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for compiling better-sqlite3 native bindings if no prebuilt is available.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# git CLI is required at runtime (the agent shells out to git).
# curl is needed for Task Master and Claude Code installation verification.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Pin Claude Code and Task Master versions for reproducibility.
ARG CLAUDE_CODE_VERSION=1.0.29
ARG TASK_MASTER_VERSION=0.43.1
RUN npm install -g \
    @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    task-master-ai@${TASK_MASTER_VERSION} \
  && claude --version \
  && task-master --version

# Create non-root user for Claude Code subprocess isolation.
# The main orchestrator runs as root (needs to read mounted secrets),
# but Claude Code is invoked with a sanitized env that excludes secrets.
RUN useradd -m -s /bin/bash aidev \
  && mkdir -p /app/data/worktrees \
  && chown -R aidev:aidev /app/data/worktrees

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8088
CMD ["node", "dist/index.js"]
