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
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8088
CMD ["node", "dist/index.js"]
