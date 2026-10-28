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
| 4 As-Built editing | Started early (owner request): geometry engine `@ftth/geo` merged (PR #5); the rest waits for Phases 1b and 3 | — |
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
  - Owner decisions pending (ADR-011): visibility of prices to supervisors, header fields, hard delete. Confirmed 2026-10-28: required item fields (plus work type, ADR-016) and duplicate-code handling (never merged, explicit decision). The real work-order Excel sample was received and tested.
- **Change after review — ADR-016 (2026-10-28, branch `feat/work-order-work-type`):**
  - Item work type (مدني / تركيبات / تخطيط) required on every item and in the import; unit prices with 6 decimals (quantities stay at 4); units up to 64 characters, wrapped in web tables. Migration `0004`.
  - Owner's sheet (199 rows): 153 clean rows (was 129), total 78,900,610.328; the 46 remaining error rows are section headings, empty quantities and one heading without description — left as they are by the owner's decision. Work type column detected automatically.
  - Test report (local, Windows + Docker): unit shared 103, i18n 4, ui-tokens 2, api 202, web 115; web e2e 9; API integration 91 (Linux container + PostGIS 16 + Redis, like CI). Build, typecheck, lint and format check pass.
  - Note: API integration tests cannot run directly on a Windows host (`STORAGE_FS_ROOT` must be a POSIX path); run them in Linux/CI.

### Phase 4 (early start) — Geometry engine `packages/geo` (PR #5)
Started ahead of Phases 1b–3 at the owner's request; only the part with no dependency on CAD mapping or the mobile app. Package decisions G-1..G-7 are in `packages/geo/DECISIONS.md`.
- **Done:**
  - `@ftth/geo`: pure TypeScript, no DOM or DB; the only runtime dependency is `proj4`.
  - Measure: `polylineLength` in planar metres in the project CRS (same as PostGIS `ST_Length`), `distanceToSegment`, `closestPointOnSegment`.
  - Grips and edits: vertex and segment-midpoint grips; `EditOperation` (move, insert, remove vertex, translate) as plain data, applied immutably; a route never drops below 2 vertices.
  - Snap: endpoint / vertex / symbol, nearest within tolerance wins; `SNAP_TOLERANCE_PX = 14` converted to metres per zoom with `toleranceFromPixels`; the dragged feature or vertex is excluded.
  - History: `EditSession` with unlimited, exact undo (stored snapshots, no float drift) and deterministic redo; `appliedOperations` are what the device will send as As-Built events.
  - Arc/bulge flattening ported from `workers/cad/cad_worker/domain/flatten.py` (1 mm sagitta, max 2048 segments), so devices and the worker produce the same vertices; exact arc length via `bulgePolylineLength`.
  - CRS: project CRS ↔ WGS84 for WGS 84 / UTM (EPSG 326xx / 327xx) only; the single TypeScript CRS conversion point.
  - Typed `GeometryError` codes: `NON_FINITE_COORDINATE`, `TOO_FEW_VERTICES`, `VERTEX_OUT_OF_RANGE`, `INVALID_TOLERANCE`, `INVALID_BULGE`, `UNSUPPORTED_CRS`, `COORDINATE_OUT_OF_RANGE`.
- **Bug found by testing and fixed:** proj4 silently returns a wrong point for impossible WGS84 input (e.g. lat 1e10, lon 213, as a GPS glitch could produce); `fromWgs84` now rejects it with `COORDINATE_OUT_OF_RANGE`.
- **Test report:** `pnpm --filter @ftth/geo test:cov` — 60 tests pass, 11 of them fast-check properties at 10,000 runs each; CRS matches pyproj 3.8 to the millimetre; coverage 100% (threshold 90%). Lint, typecheck, build, format: pass. `pnpm test` (whole repo): 10/10 tasks pass. CI green on merge `a1e766b`.
- **Not done (blocked on Phases 1b and 3):** mobile editing tools, web design-vs-As-Built review, As-Built DXF export.
- **Decisions to confirm (owner):**
  - Snap tie order endpoint → symbol → vertex (a UX choice, not in the plan).
  - Supported CRSs limited to WGS 84 / UTM; other EPSG codes are rejected until a project needs them.
- **Note:** PR #6 is an earlier, smaller version of the same package and conflicts with `main`; it is superseded by PR #5.
