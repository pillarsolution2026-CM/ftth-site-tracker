# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/web/Dockerfile -t ftth-web .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /repo

# Dependencies: only manifests, so this layer is cached until a package.json changes.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui-tokens/package.json packages/ui-tokens/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @ftth/web...

# Build the shared packages, then the Next.js standalone bundle.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm --filter "@ftth/shared" --filter "@ftth/i18n" --filter "@ftth/ui-tokens" build \
 && pnpm --filter @ftth/web build

# Minimal runtime image: the standalone output already contains the traced node_modules.
FROM node:22-slim AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN groupadd --system app && useradd --system --gid app app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=app:app /repo/apps/web/public ./apps/web/public
USER app
EXPOSE 3000
# API_URL must point at the FTTH API, e.g. http://api:3001
CMD ["node", "apps/web/server.js"]
