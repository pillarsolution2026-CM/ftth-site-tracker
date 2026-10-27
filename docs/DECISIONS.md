# Architecture Decision Records

Short ADRs. Format: context → decision → consequences. Status: Accepted / Superseded.

## ADR-001: Cloud storage and hosting — Accepted (2026-10-27)
**Context:** The brainstorming doc left storage open (cloud vs on-prem vs hybrid).
**Decision:** Cloud (provider and topology in ADR-009). PostgreSQL 16 + PostGIS with daily backups and point-in-time recovery; S3-compatible object storage for CAD files, tiles and photos (MinIO locally); services run as Docker containers.
**Consequences:** No on-prem servers to maintain. Original CAD files are kept read-only in object storage; As-Built versions are separate objects. Internet is needed for the web app; the mobile app works offline and syncs.

## ADR-002: AutoCAD processing on the server only — Accepted (2026-10-27)
**Context:** Open question whether AutoCAD is needed on user machines.
**Decision:** v1 is web + mobile only. DWG/DXF is read and written by the Python worker (ODA File Converter / LibreDWG for DWG→DXF, ezdxf for parsing and As-Built DXF export). No local AutoCAD plugin.
**Consequences:** Users do not need AutoCAD licences to use the platform. Exported As-Built DXF must be verified in AutoCAD/BricsCAD as part of acceptance. A local plugin can be added later behind the same API.

## ADR-003: Technology stack — Accepted (2026-10-27)
**Decision:** As defined in the build plan: pnpm + Turborepo monorepo; NestJS API; Next.js web; Expo React Native mobile with MapLibre + Skia + WatermelonDB; Python 3.12 CAD worker; PostgreSQL/PostGIS; Redis/BullMQ; Martin/PMTiles; GitHub Actions.
**Consequences:** Shared TypeScript contracts across web, mobile and API; Python is limited to the CAD worker.

## ADR-004: Clean architecture + modular monolith — Accepted (2026-10-27)
**Decision:** One NestJS module per bounded context with domain / application / infrastructure / interface layers (see `docs/ARCHITECTURE.md`). Contract-first schemas in `packages/shared`.
**Consequences:** Modules can be developed in parallel by separate agents against fixed contracts, and can be split into services later if needed.

## ADR-005: Agent and model routing — Accepted (2026-10-27)
**Decision:** Hard reasoning (architecture, finance, geometry, sync, security) → Opus; feature implementation and tests → Sonnet; mechanical work (scaffolding, i18n, lint, docs, search) → Haiku. Agents are defined in `.claude/agents/`. Contracts are fixed first so implementation agents can run in parallel worktrees.
**Consequences:** Most tokens are spent on Sonnet/Haiku; Opus is used where a mistake is expensive.

## ADR-006: Drizzle ORM with explicit SQL migrations — Accepted (2026-10-27)
**Decision:** Drizzle for typed queries; migrations are plain SQL files (so PostGIS types, extensions, triggers and constraints are explicit and reviewable).
**Consequences:** No ORM magic around geometry; spatial queries use `sql` templates in repository implementations only.

## ADR-007: Authentication and authorization — Accepted (2026-10-27)
**Decision:** Short-lived JWT access token (15 min, claims: `sub`, `isAdmin`) + opaque refresh token (30 days) stored as SHA-256 hash, rotated on every use; reuse of a rotated token revokes the whole token family. Passwords hashed with argon2id. Authorization = role per project (`assignments`) + optional zone scope; `admin`, `pm`, `qc` are project-wide. Memberships are resolved per request, not baked into the token.
**Consequences:** Revoking access takes effect within one access-token lifetime. Web stores tokens in httpOnly cookies via the Next.js server; mobile stores them in the OS secure store.

## ADR-008: Python worker tooling — Accepted (2026-10-27)
**Decision:** `uv` for dependency management, Python ≥ 3.12, `ruff` + `mypy --strict` + `pytest`.

## ADR-009: Hosting on Hetzner Cloud under ftthtracker.projectflow.site — Accepted (2026-10-27)
**Context:** ADR-001 chose cloud hosting; the provider and domain are now fixed.
**Decision:** Hetzner Cloud. Production on one dedicated-vCPU VPS (e.g. CCX23) and staging on a smaller VPS (e.g. CPX21), both running Docker Compose behind Caddy with automatic Let's Encrypt certificates. Hetzner has no managed PostgreSQL, so PostgreSQL/PostGIS runs in a container on a Hetzner Volume with daily base backups and WAL archiving (WAL-G or pgBackRest) to Hetzner Object Storage, giving point-in-time recovery; a restore is tested monthly. Files, CAD drawings, tiles and photos go to Hetzner Object Storage (S3-compatible), replacing MinIO outside local development. Images are built in GitHub Actions, pushed to GHCR, deployed to staging automatically and to production after manual approval.
Hostnames (A records at the `projectflow.site` registrar):
- `ftthtracker.projectflow.site` — web app
- `api.ftthtracker.projectflow.site` — API (used by web server and mobile app)
- `tiles.ftthtracker.projectflow.site` — vector tiles
- `staging.ftthtracker.projectflow.site` — staging (API and tiles under `api.staging…` / `tiles.staging…`)
**Consequences:** Low monthly cost and EU data location. We operate the database ourselves, so backups, restore drills, monitoring and security updates are our responsibility (scripts and runbook delivered in Phase 7). The code stays provider-neutral: everything is configured by env vars (`DATABASE_URL`, `S3_ENDPOINT`, `CORS_ORIGINS`, …), so moving to a managed database later needs no code change.

## ADR-010: Early staging environment on the shared Hetzner server — Accepted (2026-10-27)
**Context:** The owner wants a reachable environment now, before Phase 1, on the existing Hetzner server `49.13.167.124`, which already runs other apps (invoices, app, n8n) behind a host-level Caddy that imports one snippet per app. The owner has no deploy keys set up and prefers not to manage server secrets.
**Decision:** Pull-based staging that follows the server's conventions.
- `infra/staging/bootstrap.sh` is run once as root from the Hetzner web console (and is safe to re-run). It:
  - creates user `ftth-deploy`, `/srv/ftth`, a clone of the public repo and generated secrets in `/srv/ftth/.env`;
  - renders `/srv/ftth/ftthtracker.caddy` and adds a single `import` to `/etc/caddy/Caddyfile`, with a backup, `caddy validate` and automatic rollback;
  - installs `ftth-autodeploy` and its systemd timer, then deploys and creates the first admin with a random password.
- Every 2 minutes `ftth-autodeploy` compares `origin/main` with the deployed commit. When the matching GHCR images (`<sha>`, published by `publish-images.yml`) exist, it checks the commit out, runs `compose up --wait`, and rolls back to the previous commit on failure.
- The stack (`ftth-staging`) runs its own PostGIS, Redis (password), api, web, cad-worker and a nightly `pg_dump` kept 7 days. Only web and api listen, on loopback ports chosen by bootstrap (3310/3311 by default).
- Martin and MinIO are not deployed until tiles are gated and uploads exist (Phase 1). Staging uses `NODE_ENV=production`, so the dev seed is refused. Login and refresh are rate-limited.
**Consequences:**
- No GitHub secrets, no inbound deploy SSH, no new public ports, and no edits to other apps' config.
- Each merge to `main` reaches staging within a few minutes.
- GHCR packages must be public for anonymous pulls.
- Resources are shared with other apps, so heavy CAD processing may need its own server later.
- Off-site backups, WAL/PITR, monitoring and production remain Phase 7 work.

## ADR-011: Work orders, money and Excel import — Accepted, assumptions pending owner confirmation (2026-10-27)
**Context:** A project has several work orders (أوامر التكليف), each with its own items, quantities, prices and value (brainstorming §4, §7, §8 rules 1–2). Required item fields, duplicate handling and file formats are open questions (§11).
**Decision:**
- Tables `work_orders`, `work_order_items`, `work_order_attachments` (migration 0003, columns in `docs/phase-1a-data-model.md`). Unique `(project_id, number)`; unique line number per order; children reference `(project_id, work_order_id)`.
- Money and quantities: decimal **strings** in the API (`Decimal4StringSchema`: ≥ 0, ≤ 14 integer and ≤ 4 fraction digits), `numeric(18,4)` in PostgreSQL, a bigint-backed `Decimal` value object in the API domain. No `number` arithmetic. Line amount = quantity × unit_price, **exact** (scale 8, `numeric(36,8)` generated column), never rounded in 1a; work-order total = Σ amount computed in the domain and checked against `SUM(amount)` in a DB-level test. Currency is copied from the project when the order is created and is immutable (trigger).
- Entry: manual CRUD; Excel import = stateless preview (detect header row, suggest mapping from Arabic/English/French synonyms, per-row issues) then an atomic commit that re-parses the same file (sha256 must match) and creates one new work order. The xlsx is kept as an `import_source` attachment. PDF attachments are stored, not parsed.
- Every change appends to `events` (types in `packages/shared/src/events/domain-events.ts`). Header edits use optimistic concurrency (`version`).
- Permissions: `packages/shared/src/auth/permissions.ts` (role → permission strings) checked by a permission guard after `ProjectScopeGuard`, and `project_id` in every repository query.
**Assumptions the owner must confirm:**
1. Required item fields are code, description, unit, quantity, unit price. Quantity and price ≥ 0, at most 4 decimals.
2. Duplicate codes in one work order are never merged. In the import they are warnings that block the commit until the user excludes rows or explicitly keeps each code as separate lines; the same explicit acceptance applies to manual entry.
3. Line amounts are kept exact; the rounding rule (and currency decimals) is decided before invoicing (Phase 5). A sheet "amount" column is only cross-checked (warning), never stored.
4. Only the work-order number is required on the header; title, issue date and notes are optional.
5. A work order can be hard-deleted while nothing references its items (the event keeps a full snapshot). From Phase 2 on, references will block deletion.
6. Permissions: admin and pm write; admin, pm, qc and supervisor read (supervisors see prices project-wide, not limited to their zones); contractor has no access yet.
**Consequences:** Clients never parse money as floats. Rounding is an explicit later decision, not an accident of storage. Re-parsing on commit avoids server-side temp state at the cost of uploading the file twice.

## ADR-012: Storage port (fs | s3) and API-mediated uploads — Accepted (2026-10-27)
**Context:** ADR-001/009 store files in S3-compatible storage, but staging has no object storage yet (ADR-010). The roadmap planned presigned uploads; web tokens, however, live in httpOnly cookies behind Next.js route handlers (ADR-007), so the browser cannot sign S3 requests itself, and the worker must read the same files.
**Decision:**
- One `ObjectStorage` port (`apps/api/src/common/object-storage.port.ts`): `put` (streamed, write-once, size-limited, returns size and sha256), `get`, `stat`, `delete`. Adapters: `fs` (a directory volume mounted in both api and cad-worker, used on staging now) and `s3` (Hetzner Object Storage / MinIO later). Selected by `STORAGE_DRIVER=fs|s3`; `STORAGE_FS_ROOT` (default `/var/lib/ftth/storage`); S3 settings are required only for `s3`. The worker gets the same variables.
- Keys are generated, never user-supplied: `projects/<projectId>/cad/<fileId>/original.<dwg|dxf>`, `…/cad/<fileId>/converted.dxf`, `projects/<projectId>/work-orders/<workOrderId>/attachments/<attachmentId>.<pdf|xlsx>`. Original names stay in the DB.
- **Deviation from the roadmap:** in 1a uploads go through the API as streamed multipart (`MAX_UPLOAD_MB`, default 100) — no presigned URLs. The Next.js route handler streams the body through without buffering. Downloads are streamed by the API after the permission check.
- Originals are immutable: write-once keys plus a DB trigger that rejects changes to the original's name, key, size and hash.
**Consequences:** One code path for staging and production; uploads cost API bandwidth and a long-lived request (acceptable at ≤ 100 MB and few users). Presigned uploads can be added later behind the same port for the mobile app (photos) without changing keys. The fs volume must be backed up with the database until s3 is used.

## ADR-013: Redis-list job protocol for the Python CAD worker (not BullMQ) — Accepted (2026-10-27)
**Context:** ADR-003 lists BullMQ, but BullMQ's data layout is a Node implementation detail; the CAD worker is Python (ADR-002/008). We need at-least-once delivery that survives worker crashes, without a second broker.
**Decision:**
- Message: JSON `{id, type:'cad.import', cadFileId, projectId, storageKey, format, attempt, enqueuedAt}` — `CadImportJobSchema` (Zod, `packages/shared`) mirrored by a pydantic model (`workers/cad/cad_worker/adapters/job_message.py`). The Phase 0 `health` job stays.
- Producer (API): in one transaction set `cad_files.status='queued'` and a new `current_job_id`, append the event, commit; then `LPUSH cad:jobs <json>`. If the push fails, mark the file `failed` (`ENQUEUE_FAILED`) so the user can reprocess.
- Consumer: `BLMOVE cad:jobs cad:processing:<workerId> RIGHT LEFT <timeout>` (FIFO). Heartbeat `SET cad:worker:<workerId> … EX 30` every 10 s. Ack = `LREM cad:processing:<workerId> 1 <raw>` **after** the final DB commit. A per-worker in-flight list (instead of one shared `cad:processing`) lets a restarted or second worker recover only the work of dead workers.
- Recovery (on start and every 60 s): for every `cad:processing:*` whose heartbeat key is missing (or is this worker's own list on start), move each item back with a Lua script (atomic `LREM` + `LPUSH` with `attempt + 1`). At `attempt = 3` the file is marked `failed` (`MAX_ATTEMPTS_EXCEEDED`) instead. Malformed messages go to `cad:dead`.
- The database is the source of truth and the worker writes it directly via psycopg: `processing` is set with `UPDATE … WHERE id = $1 AND current_job_id = $2 AND status IN ('queued','processing')`; zero rows → the job was superseded, ack and drop. Results replace previous extraction rows (DELETE + INSERT/COPY) and set `processed` in **one** transaction guarded by the same `current_job_id`, and append the event (actor NULL). Handled failures set `failed` and are not retried automatically; only crashes are redelivered.
- A file stuck in `queued`/`processing` for more than 15 min can be reprocessed manually (new job id supersedes the old one).
**Consequences:** No BullMQ in 1a; Node-side job features (delays, repeat, UI) are not available for CAD jobs. Delivery is at-least-once and processing is idempotent per job id. BullMQ remains an option for Node-only jobs later.

## ADR-014: DWG conversion with LibreDWG (WASM) only — Accepted (2026-10-27)
**Context:** ADR-002 planned ODA File Converter with LibreDWG as a fallback. ODA needs a manual download and licence acceptance, and the build sandbox cannot reach apt mirrors.
**Decision:** The worker converts DWG to DXF with `@mlightcad/libredwg-web` 0.8.2 (LibreDWG compiled to WebAssembly), run by a small pinned Node script (`workers/cad/converter/dwg2dxf.mjs`), then reads the DXF with ezdxf. Verified on three real AutoCAD 2018 (AC1032) drawings up to 3.8 MB: same entity counts as reading the DWG directly and zero audit errors. Node is copied into the worker image from the pinned `node:22-slim` stage.
**Consequences:** No licence or system packages are needed. Node peaks near 0.9 GB RSS on the largest drawing, so the worker container needs about 1.5 GB. If a future drawing fails to convert, the file is marked `failed` (`CONVERTER_FAILED`) and the user can supply a DXF; ODA can be added behind the same `ConverterPort`.

## ADR-015: Redis client timeouts (lesson from the first end-to-end run) — Accepted (2026-10-27)
**Context:** redis-py 8 applies a 5 s socket timeout by default. The worker blocks in `BLMOVE` for 5 s, so an idle worker died with "Timeout reading from socket" and queued files stayed `queued`. The unit and integration tests used 1 s waits and did not see it.
**Decision:** The broker sets a 35 s socket timeout (longer than any blocking wait), a 5 s connect timeout and a health-check interval; the consumer loop converts Redis connection errors into `BrokerUnavailableError` and retries with exponential backoff (1 s up to 30 s) instead of crashing. Regression tests cover both.
**Consequences:** An idle worker survives indefinitely and recovers from a Redis restart. Lesson recorded: run the full API → Redis → worker → database path before closing a phase.
