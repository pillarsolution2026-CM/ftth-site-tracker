# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# ---- deps: resolve the workspace from manifests only (best layer caching) ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @ftth/api... --store-dir /pnpm/store

# ---- build: compile @ftth/shared, then the API ----
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ftth/shared build && pnpm --filter @ftth/api build
# Self-contained production tree (workspace packages are copied in, dev dependencies dropped).
RUN pnpm --filter @ftth/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist

# ---- runtime ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
