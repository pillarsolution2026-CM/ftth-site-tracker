# Progress

Updated at the end of every phase (see `docs/ROADMAP.md`). Each phase waits for approval before the next starts.

| Phase | Status | Approved |
| --- | --- | --- |
| −1 Planning docs (ROADMAP, ARCHITECTURE, DECISIONS, agents) | Done | — |
| 0 Foundation | Done — merged (PR #1, #2), awaiting approval | — |
| Staging (Hetzner) | Ready — server bootstrap pending (owner runs one command) | — |
| 1a Work orders + CAD upload & extraction | Done — awaiting approval | — |
| 1b Mapping, text linking, features, tiles | Not started | — |
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
  - Unit: shared 7, i18n 4, ui-tokens 2, api 43, web 15, mobile 11 — all pass (82).
  - API integration (real PostGIS via Testcontainers): 42 pass (incl. rate limiting, create-admin).
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
- **Acceptance criteria met:** login works on web (e2e) and mobile (component tests) against the API contract; CI green on every commit; `docker compose up` partially verified locally (see above); the full staging stack was verified on a simulated server.

### Staging on Hetzner (before Phase 1) — ADR-010, `docs/DEPLOY.md`
- **Done:**
  - `publish-images.yml`: every push to `main` publishes api/web/cad-worker to GHCR (first run on merge `297c61b` succeeded; images pull anonymously).
  - `infra/staging/bootstrap.sh` (one command from the Hetzner console), `autodeploy.sh` + systemd timer (pull every 2 min, rollback on failure), Caddy snippet imported into the host Caddy with validate + automatic rollback.
  - API: `create-admin` CLI, login/refresh rate limiting (429 `RATE_LIMITED`), `/health` reports the deployed version.
  - DNS: `staging.ftthtracker` and `api.staging.ftthtracker` → `49.13.167.124`.
- **Verified:** simulated Ubuntu server with real Caddy and a second site: bootstrap end-to-end (healthy stack, login page 200, admin created), idempotent re-run, Caddy rollback byte-for-byte, autodeploy waits when images are missing, other site untouched.
- **Not done:** bootstrap has not been run on the real server yet (needs the owner in the Hetzner web console; SSH from the build sandbox is blocked and no existing key has admin access).


### Phase 1a — Work orders and CAD import (upload + extraction)
- **Done:**
  - Contracts (`packages/shared`), ADR-011..015, migration 0003 (8 tables, verified on PostGIS 16).
  - API: work orders (CRUD, items, PDF attachments), Excel import (preview → commit, Arabic/English/French headers, Arabic-Indic digits, formulas, duplicate codes, exact decimal money), CAD upload (streamed, content-sniffed, write-once storage `fs`/`s3`), extraction read endpoints, permission guard.
  - Worker: LibreDWG-WASM DWG→DXF + ezdxf extraction (layers, inserts+attributes, texts, curves as LineStringZ), reliable Redis job loop (per-worker in-flight list, heartbeat, orphan requeue, 3 attempts), single-transaction write.
  - Web: work-order screens, import wizard, CAD list/detail with layers/inserts/texts/curves, BFF proxy streaming uploads and downloads.
- **Verified end to end (local, real PostGIS + Redis + API + worker):** the sector-1 DWG uploaded through the API became `processed` with 81 layers, 47 inserts, 672 texts, 3,786 curves; an Arabic xlsx (header on row 3, Arabic-Indic digits, formulas, a duplicate code, a bad row) previewed correctly with total 99,382.375; supervisor upload → 403, list → 200.
- **Test report:** unit shared 84, i18n, ui-tokens, api 194, web 110, mobile 11; API integration 89 (PostGIS + Redis); web e2e 9; worker 89 (94% coverage; golden runs on three real drawings: 8–13 s each, largest has 5,755 inserts and 13,725 texts).
- **Bug found by the end-to-end run and fixed:** redis-py's default 5 s socket timeout equal to the blocking claim crashed an idle worker (ADR-015).
- **Not done / open:**
  - One CAD job disappeared from Redis during manual process-killing in the end-to-end run (file stayed `queued`). Not reproduced; recovery paths are covered by tests, and a stale `queued` file can be re-queued with Reprocess after 15 min. Watch for it on staging.
  - Arabic street names (legacy `xarb.shx` fonts) are stored as raw ASCII key codes and flagged `readable=false`; a full character table is needed (the lowercase keys follow the Arabic 101 keyboard layout). Alternative: re-export those texts as Unicode from AutoCAD.
  - Drawing units are inches (`$INSUNITS=1`) while the plan assumes metres: confirm in 1b before lengths are used for quantities.
  - S3 adapter only unit-tested; the web was tested against a mock API only (the API path above was checked with curl).
  - Owner decisions pending (ADR-011): required item fields, duplicate-code handling, visibility of prices to supervisors, and the real work-order Excel sample.
