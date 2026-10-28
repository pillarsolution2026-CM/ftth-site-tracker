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

## ADR-016: Item work type, unit-price decimals and unit length — Accepted (2026-10-28)
**Context:** Testing the owner's real BOQ sheet (`boq_restored3_errors_yellow.xlsx`, 199 rows) against the 1a import rules showed three gaps: its "نوع الاعمال" column was ignored, 22 unit prices have 5 decimals (e.g. 5.59936), and 6 units are longer than 32 characters (e.g. "BULDING (more than 8 unit/flat per building)", 45 characters). The owner decided (2026-10-28):
1. Every item has a **work type** from a fixed list: `civil` (مدني), `installation` (تركيبات), `planning` (تخطيط). It is required on every item that has code, description, unit, quantity and price; it will be used for payment certificates, invoices, filtering and reports. The Arabic labels in the sheet are kept as they are, including items under section 2 labelled مدني.
2. **Unit prices** keep up to **6 decimals**; quantities stay at 4.
3. **Units** may be up to **64 characters**, and tables wrap long units instead of widening.
Section headings (rows without unit, quantity and price), empty quantities and the "مسلسل" header (not a code synonym) stay as they are.

**Decision:**
- Contracts (`packages/shared`): `WORK_TYPES` / `WorkTypeSchema`; `WorkOrderItemInputSchema.workType` required; `Decimal6StringSchema` for unit prices (`Decimal4StringSchema` stays for quantities); `ITEM_TEXT_LIMITS.unit = 64`. Import: `workType` is a required import field with header synonyms (نوع الأعمال, نوع العمل, work type, type of work, type de travaux); cell values must match `WORK_TYPE_SYNONYMS` after header normalisation, else the new row error `INVALID_WORK_TYPE`. `TOO_MANY_DECIMALS` carries `params.max` (4 or 6).
- Migration `0004`: `unit_price numeric(20,6)`; `amount` recreated as `numeric(38,10)` generated (4 + 6 decimals, still exact, never rounded); unit CHECK ≤ 64; `work_type text` with CHECK on the three codes and an index `(work_order_id, work_type)`.
- Items saved before 0004 have `work_type NULL` (no value is invented). The API returns `workType: null` for them and refuses an edit that does not set one (`VALIDATION_FAILED`, `reason: WORK_TYPE_REQUIRED`); the web form makes the user pick one.
- Web: work type select in the item form, a work type column in the item and import tables, and the unit column wraps (`max-w-48 wrap-break-word`). Mobile has no work-order screens yet; the same wrapping applies when they are built (Phase 3).
**Consequences:** Old Excel files without a work type column now fail with `REQUIRED_FIELD_UNMAPPED` (intended: the field is required). Line amounts may show up to 10 decimals until the rounding rule is decided for invoicing (Phase 5). Per-type totals and filters are built in Phases 2 and 5 on top of this column.

## ADR-017: CAD mapping and design revisions — Accepted (2026-10-28)
**Context:** Phase 1b turns a processed drawing (raw `cad_*` rows, SRID 0) into design features. The build plan asks for a mapping screen (layer/block → feature type, suggested from names), immutable published revisions, and stable feature ids across revisions.
**Decision:**
- Feature types: `route` (line), `box`, `hhi`, `joint`, `mh` (points) — `packages/shared/src/design/feature-types.ts`.
- Mapping (`cad_mappings`, one per CAD file, optimistic `version`): rules by `layer`, `block` (wins over its layer for inserts) or `text` (exact text on one layer, e.g. `NEW-HHI` on `RRR` → hhi). Targets are a feature type, `label` (texts are link candidates), `background` (tiles only) or `ignore`; layers without a rule are ignored. The PM also confirms `crsEpsg` (WGS 84 / UTM only) and picks the drawing unit (ADR-018). Name-based suggestions come from the plan's examples only and are never applied without the PM saving them.
- `POST /design-revisions` freezes the mapping (rules, EPSG, unit, factor) on a new `design_revisions` row and enqueues `cad.build_revision` on the existing Redis protocol (ADR-013; same reliability rules, guard = `design_revisions.current_job_id`). The worker builds features, text links (ADR-019), the diff (ADR-020) and a PMTiles archive, and leaves the revision `draft`. The PM reviews, then publishes: `rev_no` = next number in the project, and the revision is locked.
- Stable ids: `features` (identity, never updated) + `design_features` (one row per feature per revision, PK `(revision_id, feature_id)`). As-Built (Phase 4) will key on `features.id`.
- Immutability is enforced in the database: triggers reject any change to a published or discarded revision and to its features, text links and diff rows, and reject changes to a revision's frozen inputs at any time. At most one revision per project is `queued`/`building`/`draft` (partial unique index).
- Geometry: drawing coordinates × `metres_per_unit`, SRID = revision EPSG, 2D. `length_m` is a generated column (`ST_Length`, 3 decimals).
**Consequences:** Reprocessing a CAD file never changes a revision (revisions copy what they need, and the file cannot be deleted while a revision uses it). Fixing a published revision means building a new one. Drawings in local coordinates (not UTM) cannot become revisions until georeferencing is built (out of scope v1).

## ADR-018: Drawing units are a per-drawing setting — Accepted; Qalyub drawings are metres (owner, 2026-10-28)
**Context:** The Qalyub drawings declare `$INSUNITS=1` (inches), but their coordinates are clearly metres on UTM zone 36N (easting ≈ 325,000, northing ≈ 3,340,000; routes ≈ 3,700 m as planned). The owner has asked the technical office which is right; until then neither may be hard-coded.
**Owner decision (2026-10-28):** the drawings are in **metres**. `$INSUNITS=1` in the files is wrong and must not be used for lengths; the PM picks `m` on the mapping screen.
**Decision:**
- The drawing unit (`m`, `cm`, `mm`, `km`, `in`, `ft`) is chosen by the PM on the mapping screen, with **no default**. It is stored on the mapping and copied, with its exact factor (`metres_per_unit`, e.g. 0.0254), onto every design revision; the database checks factor = unit.
- The worker's CRS detection records the unit implied by the extents (UTM → metres) and the unit declared by `$INSUNITS`. When they differ it sets `unitsConflict` and adds the file warning `UNITS_CRS_MISMATCH`; the mapping screen shows both and the revision keeps `units_conflict`.
- Every metric value (feature geometry, `length_m`, link distances, matching tolerances) is computed after scaling by the revision factor, so later quantities go through this setting.
**Open:** whether `m` should become a per-project default (pre-selected on the mapping screen) instead of a choice with no default. Not implemented; the per-drawing choice and the `UNITS_CRS_MISMATCH` warning stay, so a future drawing in another unit is still caught. Revisions keep the unit they were built with.

## ADR-019: Text linking and Arabic SHX conversion — Accepted (2026-10-28)
**Context:** Free texts near features carry their data (`F 36 C`, `1X2Way16/12`, `150.0M`, box ids `1-1`, B/P/U codes). Street names on layer `tx` use the legacy `xarb.shx` font and are stored as ASCII key codes.
**Decision:**
- Candidate texts = texts on layers mapped to a feature type or `label`, excluding texts consumed by `text` rules. Each is classified by the plan's patterns (whole text): `cable`, `duct`, `length` → routes; `box_id`, `box_bpu` → boxes; else `other` (listed, not linked). The meaning of B/P/U is not interpreted.
- Link = nearest feature of an allowed type within radius `15 × text height` (min 1 m), in metres. Confidence = `0.5 × (1 − d1/radius) + 0.5 × (1 − d1/d2)` (second term 1 without a second candidate). ≥ 0.8 → `auto`, else `review`; no candidate → `review` without a feature. These are tuning parameters, not business rules.
- A box's `code` is its best `box_id` link (auto or confirmed); the API recomputes it when the PM confirms, reassigns or rejects a box-id link.
- Unreadable texts (`readable=false`) become `unreadable` links in `review`: they can be linked or rejected, but their text is never guessed.
- SHX: the owner chose the conversion-table approach. `shx_arabic.json` `mappings` now holds the lowercase keys of the Arabic 101 layout (q→ض … /→ظ, b→لا). A text in a legacy font is decoded only when every character is a digit, space or a key in the table; any other character (upper-case keys, punctuation such as `U`, `H`, `F`) keeps the whole text `readable=false` for review. The backtick key (ذ on the layout) is not in the table yet because it was not observed in the drawings.
**Consequences:** Some street names become readable; the rest stay in the review list until the table is extended with confirmed upper-case forms. The 1a golden count of unreadable texts no longer applies and must be regenerated with the drawings.

## ADR-020: Revision matching and diff report — Accepted (2026-10-28)
**Context:** `features.id` must stay the same across design revisions; a new revision is matched to the old one by position, type and code, and conflicts go to the PM.
**Decision:** The worker matches each new feature to the base revision (last published) of the same type, one-to-one, in this order: (1) same source handle and within tolerance; (2) same non-empty code, unique on both sides; (3) nearest within tolerance (points: distance; routes: Hausdorff distance — or, for a route that was extended or shortened, the deviation of the shorter route from the longer one when it lies within tolerance of it and the shared part covers ≥ 80 % of the longer route), greedy by ascending distance. Tolerance 5 m. (The partial-overlap rule was added after the end-to-end run showed an 80 m route extended to 90 m losing its id.) When the second-best unmatched candidate is within tolerance and no farther than the best + 0.5 m, the match is a `conflict` (it still takes the nearest id and lists the others). Matched features are `unchanged` (≤ 1 mm and same code), `moved` (points), `reshaped` (routes), or `attributes_changed`; leftovers are `added` (new id) or `removed`. The diff is stored per revision (`revision_diff_items`) with counts on the revision. Publishing with conflicts or texts still in review needs an explicit acknowledgement.
**Consequences:** Ids survive small edits and re-saves; large moves (> 5 m) appear as removed + added and must be checked by the PM. Manual conflict resolution in the UI is a later task.

## ADR-021: Tile serving and its security — Accepted (2026-10-28)
**Context:** Design data must be visible on maps without exposing other projects. Martin can auto-publish every table it can read, which would leak all projects.
**Decision:**
- Martin runs with `auto_publish: false` and only the function source `tiles.design_features(z, x, y, query_params)` (`infra/martin/config.yaml`). It connects as `ftth_tiles`: no table privileges, `USAGE` on schema `tiles`, `EXECUTE` on that function only, read-only transactions. The function is `SECURITY DEFINER`, requires `p` (project) and `r` (revision) to match, serves only `draft` and `published` revisions, and returns an empty tile otherwise.
- Tile URLs are signed by the API: `POST …/design-revisions/:id/tile-url` (permission `design:read`) returns `{TILES_PUBLIC_URL}/design_features/{z}/{x}/{y}?p=…&r=…&exp=…&sig=…`, HMAC-SHA256 with `TILE_URL_SECRET`, valid 1 h. Caddy protects the tiles host with `forward_auth` to the API's `GET /tiles/verify`, which checks the signature and expiry from `X-Forwarded-Uri` in constant time (204, else 401).
- Offline/mobile: each built revision also gets a PMTiles archive (`network` and `background` layers, zoom 12–18, WGS 84 web mercator) in object storage, streamed by `GET …/design-revisions/:id/tiles.pmtiles` with HTTP Range support after the normal permission checks.
- Limits (security review): an archive is capped at 1,024 z12 seed tiles, 100,000 tiles and 256 MiB, else the build fails with `TILES_FAILED`; build statements time out after 120 s, and API requests waiting for a revision row being built give up after 5 s (409 `REVISION_BUSY`).
**Consequences:** No table is ever published by accident; a leaked URL works for one revision for at most an hour. The `ftth_tiles` login password and `TILE_URL_SECRET` are deployment secrets. Martin and the tiles host are not deployed on staging yet (ADR-010) — the deploy steps are listed in `docs/DEPLOY.md`.
