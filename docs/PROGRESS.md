# Progress

Updated at the end of every phase (see `docs/ROADMAP.md`). Each phase waits for approval before the next starts.

| Phase | Status | Approved |
| --- | --- | --- |
| −1 Planning docs (ROADMAP, ARCHITECTURE, DECISIONS, agents) | Done | — |
| 0 Foundation | Done — merged (PR #1, #2) | 2026-10-28 (owner) |
| Staging (Hetzner) | Running on the real server: `Deploy (SSH)` (ADR-022) runs after each image publish; `/health` reports `cd6a08c` (2026-10-30) | — |
| Admin setup: projects, zone names, users, assignments | Done — merged (PR #18, ADR-026), added at the owner's request outside the roadmap tasks. Owner decisions open; not yet tried on staging; zones have names only until Phase 2 draws boundaries | — |
| 1a Work orders + CAD upload & extraction | Done — merged | 2026-10-28 (owner) |
| 1b Mapping, text linking, features, tiles | Done — merged (PR #10), awaiting approval (needs the Qalyub golden run and owner decisions) | — |
| 2 Contract, BOQ & rules | Not started | — |
| 3 Supervisor app (offline) | Done — merged (PR #17), awaiting approval. Started 2026-10-30 at the owner's request **before Phase 2** (ADR-023); Phase 1b still awaits approval. Not run on a device; the airplane-mode acceptance was simulated | — |
| 4 As-Built editing | Started early (owner request): geometry engine `@ftth/geo` merged (PR #5); the rest waits for Phase 3 | — |
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
  - Drawing units are inches (`$INSUNITS=1`) while the plan assumes metres: confirm in 1b before lengths are used for quantities. **Resolved 2026-10-28: owner confirmed metres (ADR-018).**
  - S3 adapter only unit-tested; the web was tested against a mock API only (the API path above was checked with curl).
  - Owner decisions pending (ADR-011): visibility of prices to supervisors, header fields, hard delete. Confirmed 2026-10-28: required item fields (plus work type, ADR-016) and duplicate-code handling (never merged, explicit decision). The real work-order Excel sample was received and tested.
- **Change after review — ADR-016 (2026-10-28, branch `feat/work-order-work-type`):**
  - Item work type (مدني / تركيبات / تخطيط) required on every item and in the import; unit prices with 6 decimals (quantities stay at 4); units up to 64 characters, wrapped in web tables. Migration `0004`.
  - Owner's sheet (199 rows): 153 clean rows (was 129), total 78,900,610.328; the 46 remaining error rows are section headings, empty quantities and one heading without description — left as they are by the owner's decision. Work type column detected automatically.
  - Test report (local, Windows + Docker): unit shared 103, i18n 4, ui-tokens 2, api 202, web 115; web e2e 9; API integration 91 (Linux container + PostGIS 16 + Redis, like CI). Build, typecheck, lint and format check pass.
  - Note: API integration tests cannot run directly on a Windows host (`STORAGE_FS_ROOT` must be a POSIX path); run them in Linux/CI.

### Phase 1b — Mapping, text linking, design revisions, tiles
Contracts: `docs/phase-1b-contracts.md`. ADRs: 017 (mapping, revisions), 018 (drawing units — **Accepted: metres, owner 2026-10-28**), 019 (text linking, SHX), 020 (matching), 021 (tiles). Migration `0005`.
- **Done:**
  - **Mapping** (`cad_mappings`, one per file, versioned): rules by layer, block or exact text on a layer → `route` / `box` / `hhi` / `joint` / `mh`, or `label` / `background` / `ignore`. Name suggestions from the plan's examples only (`N_DUC_CBL` → route, `sub` → box, `NEW-HHI` → hhi, `JONT 144` → joint); the PM saves every rule.
  - **EPSG detection** at import (`cad_files.crs_detection`): UTM ranges + the project's zone → suggested EPSG; lon/lat, local and unknown are recognised and not offered. The PM confirms the EPSG (WGS 84 / UTM only).
  - **Drawing units (owner confirmed metres, 2026-10-28):** a per-drawing setting with no default (`m`, `cm`, `mm`, `km`, `in`, `ft`), stored with the exact factor on the mapping and on every revision. When `$INSUNITS` disagrees with the CRS detection, the file gets `UNITS_CRS_MISMATCH`, the mapping screen shows a warning and the revision keeps `units_conflict`. All geometry and lengths are scaled by the chosen factor.
  - **Arabic SHX** (`xarb.shx`): conversion table = the 33 lowercase keys of the Arabic 101 layout. Any other character keeps the whole text `readable=false`; unreadable texts go to the review list and are never guessed.
  - **Text linking**: plan patterns (`F 36 C`, `1X2Way16/12`, `150.0M`, `1-1`, `12B`), nearest allowed feature within 15 × text height, confidence 0..1; ≥ 0.8 auto, else review. Box codes come from their best `1-1`-style link.
  - **Design revisions**: build job `cad.build_revision` on the existing Redis protocol → `draft` with features, text links, diff and a PMTiles archive; review list (least confident first), confirm / reassign / reject; publish → `rev_no`, locked by database triggers (revision, its features, links and diff). Stable feature ids (`features` + `design_features`).
  - **Revision matching** against the last published revision (handle → code → distance, 5 m) with a diff report: added, removed, unchanged, moved, reshaped, attributes changed, conflict.
  - **Tiles**: PMTiles per revision (layers `network` and `background`, zoom 12–18) streamed with HTTP Range; Martin config with `auto_publish: false` and only the function source `tiles.design_features`, read-only role `ftth_tiles` (execute that function only), signed tile URLs (HMAC, 1 h) checked by the API at `/tiles/verify` for Caddy `forward_auth`.
  - **Web**: mapping screen (CRS/unit panel with the units warning, layers, blocks, text rules, save, build) and design-revision list/detail (counts, text review list, diff, publish with acknowledgement, discard). ar/en/fr.
- **Verified end to end (local, real PostGIS + Redis + built API + worker, synthetic DXF on UTM 36N with `$INSUNITS=1`):** import → `projected_utm`, suggested 32636, `unitsConflict=true`, warning `UNITS_CRS_MISMATCH`; mapping saved with unit `m`; revision built: 2 routes (180 m), 1 box coded `1-1` from its linked text, 1 HHI from the `NEW-HHI` text rule, 2 links auto; PMTiles Range request → 206; signed tile URL → `/tiles/verify` 204, tampered → 401; publish → rev 1; a direct `UPDATE` on a published feature → rejected by the trigger. Second drawing (box moved 3 m, one route extended 10 m) → box `moved` and route `reshaped`, both kept their ids; published as rev 2.
- **Bug found by the end-to-end run and fixed (failing test first):** a route extended from 80 m to 90 m lost its id (removed + added) because its Hausdorff distance exceeded the 5 m tolerance. Routes now also match when the shorter lies within tolerance of the longer and covers ≥ 80 % of it (ADR-020).
- **Security review (Opus) — no critical or high findings; fixed in this phase (each with a failing test first):**
  - M1: tile generation is capped (≤ 1,024 z12 seed tiles, ≤ 100,000 tiles, ≤ 256 MiB) and fails with `TILES_FAILED`; build statements time out after 120 s; API requests that need a revision row being built wait at most 5 s and answer 409 `REVISION_BUSY` instead of hanging.
  - L1: a `change-me` `TILE_URL_SECRET` is refused in production; empty `TILE_URL_SECRET=` / `TILES_PUBLIC_URL=` lines mean "not set" instead of stopping the API.
  - L2: temporary tile tables are dropped schema-qualified (`pg_temp.`), so a permanent table of the same name can never be dropped.
  - L3: `TILES_FAILED` and `INTERNAL` build failures show a fixed message; exception text (paths, SQL) goes to the revision log only.
  - L4: the PMTiles archive is served only for `draft`/`published` revisions, like the tile URL and the SQL function.
  - L5: `TRUNCATE` is rejected on every design table.
  - Accepted as is (documented): tile signatures appear in tile-server access logs (valid 1 h); the read-only setting of `ftth_tiles` is not the boundary (its missing privileges are); supervisors read design data project-wide (ADR-011 assumption); the app still connects as the table owner (least-privilege roles are Phase 7).
- **Test report (local, Linux, PostGIS 16-3.4, Redis 7):**
  - `pnpm format:check`, `pnpm build`, `pnpm lint`, `pnpm typecheck`: pass.
  - Unit: shared 137, i18n 4, ui-tokens 2, geo 60, api 282, web 179, mobile 11 — all pass.
  - API integration (real PostGIS + Redis): 131 pass (30 new for 1b, incl. RBAC/IDOR, publish lock, rev numbers, Range download, signed URLs, and the `ftth_tiles` role: table reads denied, matching tile non-empty, other project empty).
  - Web e2e (Playwright, mock API): 10 pass (new: mapping → unit → save → build → review → publish).
  - CAD worker: ruff, ruff format, mypy --strict: pass; pytest 208 pass, 5 skipped (golden — drawings not in the repo); coverage 95 %.
  - Docker images: not built here (Docker Hub rate limit in the sandbox); checked by CI.
- **Golden run on the real drawings (one command, for someone who has them):**
  ```bash
  CAD_FIXTURES_DIR=/path/to/drawings workers/cad/scripts/golden.sh
  ```
  It needs Docker (or `TEST_DATABASE_URL`) and Node 22, installs the DWG converter if missing, imports every drawing named in `workers/cad/tests/golden/*.json`, and for Qalyub sector 1 builds a revision with `tests/golden/qalyub_sector1_mapping.json` (drawing unit `m` as a **test parameter** only) and prints routes, route metres, boxes, HHI, joints, EPSG, units conflict and seconds. Add `UPDATE_GOLDEN=1` once to record the route count, route metres and the new unreadable-text counts (left empty in the repo because the drawings were not available).
- **Not done:**
  - Golden run against the real Qalyub drawings (not in the repo).
  - Martin not run (image could not be pulled here); its config follows the docs and is untested. The SQL function and role were tested directly in PostGIS. Martin and the tiles host are not deployed on staging (steps in `docs/DEPLOY.md`).
  - No map preview on the mapping screen (MapLibre comes with Phase 2's CAD viewer); the web was tested against a mock API only (the API path was checked with curl, above).
  - Manual resolution of diff conflicts (choose another base feature) — conflicts are listed and must be acknowledged on publish.
  - Correcting the text of an unreadable label by hand.
  - Street-name texts (`tx`) are not drawn in the background tiles yet (curves and blocks only).
- **Known issues:**
  - `Deploy` workflow failed on every push to `main` ("node is not available" for the server SSH user); removed after 1b and replaced by the Docker-based `Deploy (SSH)` (ADR-022).
  - `design_features.attrs.texts` records the links found at build time; after the PM's review only box codes are recomputed (diff rows keep the build-time code).
  - API integration tests need a fresh database per run (a 1a test leaves memberships behind) — CI uses a fresh service database.
  - Revision `warnings` may contain `ROUTE_ZERO_LENGTH_SKIPPED`, which has no shared enum yet (not shown in the UI).
- **Acceptance criteria met:** **not verified — needs the drawings.** Qalyub → ~25 routes (~3,700 m), 17 boxes, 6 HHI, 4 joints, UTM 36N in under a minute: the golden test asserts 17 boxes, 4 joints, 6 HHI, EPSG 32636 and < 60 s, and prints routes/metres, but it has not been run against the real files. From the 1a extraction, layer `N_DUC_CBL` has 28 polylines, 3 lines and 1 arc (32 curves, 3,782.53 drawing units), so the route count will likely be 32 rather than ~25 unless the technical office says some of them are not routes.

### Phase 3 — Supervisor app (offline) — started before Phase 2 (ADR-023)
Started 2026-10-30 at the owner's request, before Phase 2 (contract, BOQ, `type_rules`, zones UI), which was not built. Phase 1b is still awaiting approval; neither 1b nor 2 is marked approved here. Contracts: `docs/phase-3-contracts.md`. ADRs: 023 (order of phases), 024 (sync design), 025 (on-device encryption). Migration `0006`.
- **Done:**
  - **Contracts** (`packages/shared/src/execution`): operation `execution_update.record` with `clientOpId`, push/pull/bundle/photo-upload schemas, rejection codes, QC flags; permissions `execution:read` / `execution:write` (assumption below).
  - **API** (`execution` module): `POST sync/push` (idempotent by `clientOpId` + payload hash, one transaction per operation, per-project advisory lock so the pull cursor never skips a commit), `GET sync/bootstrap` (latest published revision's features in the caller's zones, in project-CRS metres; work-order items without prices; Phase 2 capabilities marked unavailable), `GET sync/changes` (server cursor), `GET/PUT sync/photos/:photoId` (resumable upload: offset check, ≤ 1 MiB chunks, sha256 + JPEG check, write-once storage key). Tables are append-only by trigger; only review fields of an update may change (Phase 5). Deleting a work-order item with recorded execution now answers 409 instead of 500.
  - **Conflict rules (ADR-024):** updates from several devices on the same feature add up; the server rejects only integrity/security problems and otherwise attaches flags for QC (`ITEM_OVERRUN`, `GPS_FAR`, `GPS_MISSING`, `CLOCK_AHEAD`, `CLOCK_BEHIND`, `REVISION_OUTDATED`, `FEATURE_REMOVED`). Ordering uses the server only.
  - **`@ftth/sync`** (new package, pure TS): sync engine (push in batches → resumable photo upload → pull), HTTP transport, backoff (2 s → 5 min, jitter), in-memory reference store.
  - **Mobile:** WatermelonDB outbox (`outbox_ops`, `local_photos`, `remote_updates`, `key_values`, all per user and project); sync scheduler (backoff, one token refresh on 401, stop on 403; triggers on save, network back, app in front); CAD screen (vector drawing of the network features in project CRS, pan / pinch-zoom with rotation locked, crosshair pick, E/N, layers, day/night palettes checked for WCAG AA contrast, feature card); the 6-step update tool (activity › work items › materials › label & location › photos › review) with stepper buttons, progress bar, back on every step, GPS-distance and overrun warnings that must be acknowledged, mandatory photos; camera pipeline (≤ 1600 px, watermark burnt in: feature, time, GPS, author; JPEG 80 %; sha256 of the stored bytes); «في الانتظار» screen with sync state, rejection reasons and QC status pulled from the server. ar/en/fr strings.
  - **Suggested quantity:** behind `ExecutionCapabilities` (API) / `settings.suggestedQuantity` (bundle); the only implementation answers `unavailable` until Phase 2 `type_rules` exist. Nothing is guessed.
  - **Zones:** read from the Phase 0 `zones` / `assignments` tables. Until Phase 2 assigns features to zones, a feature is in a zone when its design geometry intersects the zone polygon; a zone without a polygon contains nothing (fail closed). Zone polygons in the tests are **test data only** (`apps/api/test/support/execution-fixtures.ts`); the dev seed is unchanged.
- **Test report (local, Linux, PostGIS 16 + Redis 7, Node 22):**
  - `pnpm format:check`, `pnpm build`, `pnpm lint`, `pnpm typecheck`: pass.
  - Unit: shared 147, i18n 4, ui-tokens 3, geo 60, sync 19 (coverage ≥ 90 % lines), api 300, web 179, mobile 50 (Jest, incl. WatermelonDB on the LokiJS adapter and the full field flow on the real components against a fake API).
  - API integration (real PostGIS + Redis): 167 pass (32 new: idempotency incl. 10 concurrent resends, reused ids, zone scope/IDOR, RBAC, flags, immutability, bootstrap, cursor paging, resumable upload incl. checksum failure and non-JPEG, plus the security-review cases: mixed roles, upper-case UUIDs, old revision, rate limits, lock timeout, upload cap and idle sweep).
  - **Sync tests with the real engine over HTTP against the real API** (`apps/api/test/sync-devices.int-spec.ts`): 20 updates in airplane mode then online → exactly 20 updates and 20 stored photos; 3 devices on the same box with 20 % lost requests and 25 % lost responses → 30 updates once each, quantities added exactly, every device sees all 30; device clocks +3 days and 1970 → accepted, flagged, ordered by the server; network cut in the middle of a photo upload → resumed from the server offset, byte-identical file.
- **Acceptance criterion** ("20 updates in airplane mode sync with no duplicates"): **simulated only** — the airplane mode is a simulated network in front of the real sync engine and the real API/PostGIS. **Not run on a real Android device or emulator**; the dev client was not built (no device/emulator in the build sandbox).
- **Security review (Opus, sync endpoints and photo upload)** — all high and medium findings fixed in this phase (with tests):
  - H1: a user with a read-only project-wide role (qc) plus a zone-scoped supervisor role could write in every zone → the write scope now comes only from assignments whose role grants `execution:write`.
  - H2: the device outbox was not tied to a user, so on a shared phone the next user's token would send the previous user's updates → outbox, photos, pulled updates, cursor and cached bundle are kept per user.
  - L5 (UUID case), L6 (photo-id race across projects → 500), L8 (older revision used to reach a feature now outside the zone), L12 (Android backups off, release builds require https).
  - M3: unfinished uploads are capped per user (64 MiB, the last chunk of an upload always accepted) and an hourly sweep discards uploads idle for 24 h (the device restarts them); new column `execution_photos.last_chunk_at`.
  - M4: per-user rate limits on the sync routes (120/min push, changes, bootstrap; 600/min photo requests; 429 with `Retry-After`) and a 5 s timeout on the project lock (429 instead of waiting). All values are environment settings (`SYNC_*`) the owner may tune. The limiter is in memory, like the auth limiter: one API instance only (Phase 7 if the API is scaled out).
  - **Documented, not changed:** completing a photo reads its ≤ 8 MiB into memory once. Info: Phase 5 review writes must take the same project lock; a stored photo does not bump the pull cursor (`photos[].stored` can be stale on devices); zone-scoped users see every work-order item and recorded quantity of the project, and other users' notes in their zone; the JPEG check is signature-only (serve photos with `nosniff` / `attachment` later); `deviceId` is client-chosen evidence; photos, the offline bundle and the outbox content are encrypted on the device (ADR-025; ids and states stay readable for queries).
- **Not done:**
  - Not run on a device; the WatermelonDB Expo plugin, SQLite JSI adapter, camera, view-shot watermark, GPS and NetInfo are wired but untested on hardware.
  - Background CAD layer (PMTiles) not shown on the phone: the CAD screen draws the network features from the bundle; original ACI layer colours are not in the bundle (feature-type palette instead).
  - Push notifications for rejected updates: the rejection and reason appear in «في الانتظار» after a pull, no OS notification.
  - Suggested quantity, per-activity photo requirements, work/material split of items, items filtered by feature type: wait for Phase 2.
  - Free-space warning for unsent photos (needs a threshold from the owner) and deleting uploaded photos from the phone.
  - Large projects: the bundle is not paginated (fine for Qalyub's size; revisit for 50,000 features).
- **Decisions waiting for the owner:** who may record updates (assumed supervisor, pm, admin; qc read-only; contractor nothing); one photo minimum per update until Phase 2 rules (from the plan's "every quantity with its photos"); feature-in-zone by polygon intersection; the 5-minute clock tolerance and the 50 m GPS distance (plan default); whether supervisors may see work-order quantities of the whole project; the open 1b questions (route count, permissions, B/P/U codes, tuning values, publishing with unreviewed items) are unchanged.
- **Infrastructure note:** commits from the build sandbox are pushed unsigned; signed pushes were refused by GitHub ("fatal error in commit_refs_rules"). The API Dockerfile now copies `packages/sync` (dev dependency of the API tests). No change to `infra/staging` or the deploy workflows.

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
- **Not done (blocked on Phase 3):** mobile editing tools, web design-vs-As-Built review, As-Built DXF export.
- **Decisions to confirm (owner):**
  - Snap tie order endpoint → symbol → vertex (a UX choice, not in the plan).
  - Supported CRSs limited to WGS 84 / UTM; other EPSG codes are rejected until a project needs them.
- **Note:** PR #6 is an earlier, smaller version of the same package and conflicts with `main`; it is superseded by PR #5.

### Admin setup (owner request, 2026-10-30) — outside the roadmap's listed tasks (ADR-026)
Added because staging had no way to create a project, a user or an assignment. It does not approve or start any phase.
- **Done:**
  - Contracts `packages/shared/src/admin/admin.schemas.ts`; API `admin` module (interface only) over `identity` (users, assignments) and `projects` (projects, zones). No migration.
  - Routes (all platform-admin only, re-checked against the database by `PlatformAdminGuard`): `GET/POST /admin/projects`, `PATCH /admin/projects/:id`, `GET/POST …/:id/zones`, `GET/POST …/:id/assignments`, `DELETE …/:id/assignments/:assignmentId`, `GET/POST /admin/users`, `POST /admin/users/:id/deactivate|reactivate`. Every change writes an event.
  - Web: `/{locale}/admin/projects`, `/admin/projects/:id` (edit, zone names, team), `/admin/users`; BFF proxy `/api/admin/*`. Home: an admin sees every project, each opening its page; the project switcher lists every project for admins. Non-admins unchanged. ar/en/fr strings.
  - Checked: `ProjectScopeGuard` already let admins in (integration test `GET /projects/:id` as admin = 200); only the web lacked the project name and switcher for admins (fixed).
  - Deactivated users: their assignments grant nothing (membership query joins active users), refresh tokens revoked.
- **Test report (local, 2026-10-30):** `pnpm lint`, `typecheck`, `test`, `format:check`: pass. Unit: shared 146, api 299, web 191, mobile 11, geo 60, i18n 4, ui-tokens 2. API integration (real PostGIS + Redis): 152 pass (17 new in `admin.int-spec.ts`, incl. 401/403 for every admin route as PM and supervisor). Web e2e: 12 pass (2 new admin flows, mock API).
- **Security review (Opus):** no high/medium findings. Fixed: password hash could reach error logs through drizzle's query-param message; concurrent assignment removal could write two events; re-deactivation now always revokes sessions; the web drops the password from the mutation cache. Accepted and documented: zone-name uniqueness is enforced in code under a project-row lock (no DB index; Unicode forms not normalised); admin access on project routes trusts the JWT `isAdmin` for up to 15 min (ADR-007; `/admin` routes re-check at once); no rate limit on user creation (admin-only, argon2 ~19 MiB per call); reactivation restores previous assignments.
- **Not done / not verified:** not tried on the real staging server. No password reset for non-admin users, no forced password change at first login, no zone boundary drawing or zone rename/delete (Phase 2), no `contractor_id` (contractors table comes with Phase 2). A supervisor or subcontractor on a name-only zone can open the project but gets no zone-scoped features until the boundary is drawn.
- **Decisions to confirm (owner):**
  1. CRS and currency cannot be changed after a project is created.
  2. Project CRS limited to WGS 84 / UTM (same rule as the mapping screen).
  3. PM and QC are whole-project (no zone); supervisor and subcontractor need exactly one zone per assignment (several zones = several assignments).
  4. Platform admins only from the server command: the web cannot create, deactivate or assign admins, and the project `admin` role cannot be assigned.
  5. Deactivation keeps assignments (hidden); reactivation brings them back. Reactivation was added although only deactivation was asked for.
  6. Zone names are unique per project, ignoring case.
  7. The initial password is handed over by the admin in person (no email); the user is not forced to change it.
- **Note:** merged with `main` after PR #17 (Phase 3); ADR renumbered to 026 because #17 used 025. No migration added.
