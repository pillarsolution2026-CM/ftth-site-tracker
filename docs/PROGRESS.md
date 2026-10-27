# Progress

Updated at the end of every phase (see `docs/ROADMAP.md`). Each phase waits for approval before the next starts.

| Phase | Status | Approved |
| --- | --- | --- |
| −1 Planning docs (ROADMAP, ARCHITECTURE, DECISIONS, agents) | Done | — |
| 0 Foundation | Done — awaiting approval | — |
| 1 Work orders + CAD import & mapping | Not started | — |
| 2 Contract, BOQ & rules | Not started | — |
| 3 Supervisor app (offline) | Not started | — |
| 4 As-Built editing | Not started | — |
| 5 QC, quantities, changes & invoicing | Not started | — |
| 6 Full testing | Not started | — |
| 7 Cloud launch & pilot | Not started | — |

## Phase template

### Phase N — <name>
- **Done:**
- **Not done:**
- **Test report:** (command, pass/fail counts, coverage)
- **Known issues:**
- **Acceptance criteria met:** yes / no

### Phase 0 — Foundation
- **Done:**
  - pnpm + Turborepo monorepo, TypeScript strict, ESLint + Prettier, Ruff + mypy strict, pre-commit config.
  - `packages/shared` (Zod auth contracts, roles, error codes, env schema), `packages/i18n` (ar/en/fr + RTL helpers), `packages/ui-tokens`.
  - `apps/api` (NestJS): clean-architecture `identity` and `projects` modules; login / refresh (rotation + reuse detection revoking the family) / logout / me; `JwtAuthGuard`, `RolesGuard`, `ProjectScopeGuard`; SQL migration `0001_foundation.sql` (PostGIS, append-only `events` trigger); idempotent dev seed (Qalyub project, EPSG:32636); OpenAPI at `/docs`; `/health`.
  - `apps/web` (Next.js 16): RTL-first layout, ar/en/fr switcher, login with tokens kept in httpOnly cookies behind Next route handlers, protected home.
  - `apps/mobile` (Expo 58): login, tokens in secure store, refresh-once client, RTL handling, 44dp targets.
  - `workers/cad` (Python, uv): layered skeleton, `ProjectCrs` (single CRS conversion point), Redis job consumer, `--health`.
  - `infra/docker-compose.yml`; GitHub Actions CI (Node, Python, Docker image builds).
- **Not done:**
  - Mobile not run on a device/emulator; dev client not built.
  - Full `docker compose up` not verified here: redis/minio/martin images could not be pulled in the build sandbox (registry rate limits / blocked hosts). postgis + api were verified via compose (`/health` ok, admin login ok).
  - MinIO and Martin images use `latest` tags; pin them once a tag is verified (MinIO is local-dev only; production uses Hetzner Object Storage, ADR-009).
- **Test report (local):**
  - `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check`: pass.
  - Unit: shared 7, i18n 4, ui-tokens 2, api 32, web 15, mobile 11 — all pass.
  - API integration (real PostGIS via Testcontainers): 35 pass.
  - Web e2e (Playwright, mock API): 4 pass.
  - CAD worker: ruff, mypy --strict, pytest 8 pass (coverage 50%: Redis adapter and entry point untested); Docker image builds and `--health` returns ok.
- **Known issues:**
  - i18n has overlapping keys from web and mobile (`home.projects` vs `auth.projects`); unify in Phase 1.
  - `ProjectResponseSchema` lives in the API; move to `packages/shared` when the web needs it.
  - Next 16 warns that `middleware.ts` is deprecated in favour of `proxy.ts`.
  - Login/refresh rate limiting done (in-memory, single instance). Security headers are set by Caddy on staging. `__Host-` cookies, least-privilege DB role, JWT iss/aud: deferred to Phase 7.
  - Deactivated/demoted admins keep their access token up to 15 min (accepted in ADR-007).
- **Security review (Opus) — fixed in this phase:**
  - Production rejects the dev JWT secret; dev seed no longer runs on container start and needs `ALLOW_DEV_SEED=true`.
  - Data services bound to 127.0.0.1, Redis password; Martin dev-only until tiles are gated (Phase 1 task added).
  - Zone scope fails closed (zoneless supervisor/contractor → 403); refresh-token 30 s grace window (no family revoke on benign races).
  - Composite FK keeps assignment zones inside the same project (migration 0002).
  - `/docs` hidden in production; CORS without credentials; web login/logout reject cross-site and non-JSON requests (login CSRF).
  - Compose web service now gets `API_URL`.
- **Acceptance criteria met:** login works on web (e2e) and mobile (component tests) against the API contract; CI green pending first run; `docker compose up` partially verified (see above).
