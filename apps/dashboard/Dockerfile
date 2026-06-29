FROM node:20-bookworm-slim AS build
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV AI_DEV_BACKEND_URL=http://ai-dev-orchestrator:8088

# Copy shared package first
COPY packages/shared ./packages/shared

# Copy dashboard package.json and install ALL deps (devDeps needed for build)
COPY apps/dashboard/package.json ./apps/dashboard/
WORKDIR /app/apps/dashboard
RUN npm install

# Copy dashboard source (exclude node_modules via .dockerignore)
COPY apps/dashboard/app ./app
COPY apps/dashboard/components ./components
COPY apps/dashboard/lib ./lib
COPY apps/dashboard/public ./public
COPY apps/dashboard/next.config.mjs ./
COPY apps/dashboard/tailwind.config.ts ./
COPY apps/dashboard/tsconfig.json ./
COPY apps/dashboard/postcss.config.js ./

RUN npm run build

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV AI_DEV_BACKEND_URL=http://ai-dev-orchestrator:8088

# Copy the standalone output
COPY --from=build /app/apps/dashboard/.next/standalone ./
COPY --from=build /app/apps/dashboard/.next/static ./.next/static
COPY --from=build /app/apps/dashboard/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
