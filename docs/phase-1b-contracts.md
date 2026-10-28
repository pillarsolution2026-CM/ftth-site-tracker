# Phase 1b contracts — mapping, text linking, design revisions, tiles

Schemas: `packages/shared/src/cad/{drawing-units,crs-detection.schemas,cad-mapping.schemas}.ts`,
`packages/shared/src/design/{feature-types,text-link,design-revision.schemas}.ts`, job
`CadBuildRevisionJobSchema`. Migration: `apps/api/src/db/migrations/0005_design_revisions.sql`.
ADRs: 017 (mapping, revisions), 018 (drawing units — Proposed), 019 (text linking, SHX), 020
(matching), 021 (tiles). Common rules of `docs/phase-1a-contracts.md` still apply (guards, errors,
events in the same transaction, `project_id` in every query, lists ordered).

## Permissions

| Permission | Roles |
| --- | --- |
| `design:read` | admin, pm, qc, supervisor |
| `design:write` | admin, pm |
Mapping uses `cad_files:read` / `cad_files:write`.

## API — module `cad` (new files under `apps/api/src/modules/cad/`)

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/projects/:projectId/cad-files/:cadFileId/mapping` | cad_files:read | — | 200 `CadMappingView` (layers/blocks/texts empty unless `processed`) |
| PUT | `/projects/:projectId/cad-files/:cadFileId/mapping` | cad_files:write | `CadMappingInput` | 200 `CadMapping`; 409 `CONFLICT` version mismatch (`details.reason = 'VERSION_MISMATCH'`); 409 file not processed (`NOT_PROCESSED`) |
| GET | `/projects/:projectId/design-revisions` | design:read | — | 200 `DesignRevisionListResponse` (created_at DESC) |
| POST | `/projects/:projectId/design-revisions` | design:write | `CreateDesignRevisionRequest` | 202 `DesignRevisionSummary` (`queued`, or `failed` + `ENQUEUE_FAILED`); 409 reasons `NO_MAPPING`, `MAPPING_VERSION_MISMATCH`, `NOT_PROCESSED`, `REVISION_IN_PROGRESS` |
| GET | `…/design-revisions/:revisionId` | design:read | — | 200 `DesignRevisionDetail` |
| GET | `…/design-revisions/:revisionId/features` | design:read | `DesignFeatureListQuery` | 200 `DesignFeaturePage` (type, then code, then source_handle) |
| GET | `…/design-revisions/:revisionId/text-links` | design:read | `TextLinkListQuery` | 200 `TextLinkPage` (confidence ASC, text_handle) |
| PATCH | `…/design-revisions/:revisionId/text-links/:linkId` | design:write | `ReviewTextLinkRequest` | 200 `TextLink`; 409 `REVISION_LOCKED` when not `draft`; 422 `VALIDATION_FAILED` (`reason: FEATURE_TYPE_NOT_ALLOWED` / `FEATURE_REQUIRED`) |
| GET | `…/design-revisions/:revisionId/diff` | design:read | `DiffListQuery` | 200 `DiffPage` (change, feature_type, code) |
| POST | `…/design-revisions/:revisionId/publish` | design:write | `PublishDesignRevisionRequest` | 200 `DesignRevisionDetail`; 409 `OPEN_ITEMS` (`PublishBlockedDetails`) or `NOT_DRAFT` |
| POST | `…/design-revisions/:revisionId/discard` | design:write | — | 200 `DesignRevisionDetail`; 409 `NOT_DISCARDABLE` (only `draft`/`failed`, or `queued`/`building` older than CAD_STALE_AFTER_MINUTES) |
| GET | `…/design-revisions/:revisionId/tiles.pmtiles` | design:read | `Range` header | 200/206 `application/vnd.pmtiles` stream; 404 when no archive |
| POST | `…/design-revisions/:revisionId/tile-url` | design:read | — | 200 `TileUrlResponse`; 404 when `TILE_URL_SECRET`/`TILES_PUBLIC_URL` unset or revision not `draft`/`published` |
| GET | `/tiles/verify` | none (Caddy only) | headers `X-Forwarded-Uri` | 204 valid; 401 otherwise |

Rules:
- **Mapping view:** layers from `cad_layers` with `suggestLayerTarget`; blocks = `cad_inserts` grouped by block name (count, distinct layers, `suggestBlockTarget`); texts = readable `cad_texts` grouped by (layer, trimmed text), count DESC then layer, text, limited to `MAPPING_TEXT_ROWS_LIMIT`, with `suggestTextTarget`. `crsDetection` from `cad_files.crs_detection`; `projectEpsg` via the projects application service.
- **Saving a mapping:** `metres_per_unit = METRES_PER_UNIT[drawingUnit]`; version 1 on insert, +1 on update; `version` in the request must equal the stored one (null when none). Event `cad_mapping.saved`.
- **Creating a revision:** in one transaction: lock the mapping, check version and that the file is `processed`; base = latest `published` revision of the project; copy rules/EPSG/unit/factor/`ins_units` and `units_conflict = crs_detection.unitsConflict`; new `current_job_id`; insert (the partial unique index turns a second open revision into `REVISION_IN_PROGRESS`); event `design_revision.queued`; commit, then `LPUSH cad:jobs` a `CadBuildRevisionJob` (attempt 1). Push failure → `failed` + `ENQUEUE_FAILED`.
- **Reviewing a link:** only in `draft`. `confirm` with `featureId`: the feature must belong to this revision and its type must be in `TEXT_LINK_TARGETS[kind]`; recompute `distance_m` with `ST_Distance(position, geom)`; without `featureId` the link must already have one. `confirm` sets `confidence` unchanged, `status='confirmed'`, `reviewed_by/at`. `reject` → `rejected`, keeps the proposed feature id and distance (if any) for the record. After any change of a `box_id` link recompute the affected boxes' `code` (best auto/confirmed `box_id` link by confidence, then distance) and the revision's `text_link_counts`. Event `text_link.reviewed`.
- **Publishing:** `draft` only. Open items = links in `review` + diff `conflict`s; if > 0 and not acknowledged → 409. Set `status='published'`, `rev_no = max(rev_no)+1` for the project, `published_at/by`. Event `design_revision.published`.
- **Busy revision:** requests that lock a revision row (review, publish, discard) wait at most 5 s (`lock_timeout`) and then answer 409 `REVISION_BUSY`.
- **Reprocess guard:** reprocessing a CAD file is refused (409 `REVISION_IN_PROGRESS`) while one of its revisions is `queued`/`building`.
- **CadFileDetail** gains `crsDetection` (from the column).
- **Tile URL:** `exp = now + TILE_URL_TTL_SECONDS`; `sig = base64url(HMAC_SHA256(TILE_URL_SECRET, tileSignaturePayload('design_features', p, r, exp)))`; template `${TILES_PUBLIC_URL}/design_features/{z}/{x}/{y}?p=&r=&exp=&sig=` (braces kept literally). `/tiles/verify` parses the path `/design_features/<int>/<int>/<int>` and the four params from `X-Forwarded-Uri`, rejects expired or bad signatures with `timingSafeEqual`, and is excluded from JWT auth and rate limits. It does not touch the database.
- **PMTiles download:** stream from `ObjectStorage` with `Range: bytes=a-b` support (206 + `Content-Range`, `Accept-Ranges: bytes`); the BFF must forward `Range` and the 206 response.

## Worker — `workers/cad`

### Import (extends 1a)
- `domain/crs_detect.py` (pure; transforms only through `domain/geo.py`): input extents (drawing units), `$INSUNITS`, project EPSG → `CrsDetection` JSON (camelCase keys as the Zod schema). Rules: no extents → `unknown/NO_EXTENTS`. If minX ≥ 100,000, maxX ≤ 900,000, 0 ≤ minY, maxY ≤ 10,000,000 → `projected_utm`, `impliedUnit='m'`; if the project EPSG is UTM and the extents centre, read as metres in it, falls within ±4° longitude of the zone's central meridian and inside the hemisphere's latitude band → `suggestedEpsg = projectEpsg`, `MATCHES_PROJECT_CRS`; else `UTM_ZONE_UNKNOWN`. Else if all within ±180/±90 and span < 10 → `geographic` (`LONLAT_RANGE`, suggested 4326 is NOT offered: null). Else if all |values| < 100,000 → `local` (`SMALL_LOCAL_COORDINATES`). Else `unknown/OUT_OF_KNOWN_RANGES`. `declaredUnit` from `$INSUNITS` (1 in, 2 ft, 4 mm, 5 cm, 6 m, 7 km). `unitsConflict = impliedUnit and declaredUnit and impliedUnit != declaredUnit`; when true add warning `UNITS_CRS_MISMATCH` with params `{declared, implied}`.
- The repo reads `projects.crs_epsg`; `cad_files.crs_detection` is written in the same final transaction.
- SHX: `shx_arabic.json` `mappings` = the lowercase Arabic 101 table (ADR-019).

### `cad.build_revision` (`CadBuildRevisionJob`, pydantic mirror in `adapters/job_message.py`)
1. Start: `UPDATE design_revisions SET status='building', build_started_at=now() WHERE id AND project_id AND current_job_id AND status IN ('queued','building')`, event `design_revision.build_started`; 0 rows → superseded (ack, drop).
2. One transaction (lock the row `FOR UPDATE` guarded by job id): delete this revision's previous partial rows (`revision_diff_items`, `text_links`, `design_features`, then `features WHERE first_revision_id = revision`), read the frozen rules/EPSG/factor, the file's `cad_curves`/`cad_inserts`/`cad_texts` (file must be `processed`, else failure `CAD_FILE_NOT_PROCESSED`), and the base revision's `design_features`.
3. Domain (pure, `domain/design_build.py`, `domain/text_links.py`, `domain/revision_match.py`; shapely allowed): scale coordinates by the factor (2D); build features per ADR-017 rule semantics (one feature per curve/insert/text; skip zero-length routes); classify and link texts (ADR-019; radius from text height × factor); match against the base (ADR-020); box codes from the best `box_id` link.
4. Write `features` (new ids only), `design_features` (`ST_SetSRID(ST_GeomFromText(wkt), epsg)`), `text_links`, `revision_diff_items` (for `removed`, the base feature id), counts JSON (`counts`, `text_link_counts`, `diff_counts`), warnings, log.
5. PMTiles (`adapters/pmtiles_writer.py`, package `pmtiles`): zoom 12–18 over the revision extent; per tile one PostGIS query building `ST_AsMVT` layers `network` (design_features of the revision, in the open transaction) and `background` (curves on `background` layers + inserts' positions, from `cad_curves` scaled and transformed); gzip-compressed MVT; skip empty tiles; upload to `projects/<projectId>/revisions/<revisionId>/design.pmtiles`; set `tiles_storage_key`. Failure → `TILES_FAILED`.
6. Set `status='draft'`, `built_at`, event `design_revision.built`, commit, ack. Handled failures → `failed` + code + event `design_revision.failed`.
- Recovery (ADR-013) treats both job types; at `MAX_ATTEMPTS` a build job marks the revision `failed` (`MAX_ATTEMPTS_EXCEEDED`).

### Golden run (needs the real drawings)
`workers/cad/scripts/golden.sh` → imports each drawing in `fixtures/cad/` and, for Qalyub sector 1, builds a revision with `tests/golden/qalyub_sector1_mapping.json`, printing the acceptance numbers (routes, route metres, boxes, HHI, joints, EPSG, seconds). Without drawings the tests skip.

## Web — `apps/web`

- `/[locale]/projects/[projectId]/cad-files/[cadFileId]/mapping` — `features/cad-mapping`: CRS panel (detected kind, suggested EPSG, EPSG input prefilled with the suggestion or project EPSG, drawing-unit select with **no preselection**, and a warning box when `crsDetection.unitsConflict` or when the chosen unit differs from `declaredUnit`/`impliedUnit`); layer table (colour swatch, counts, target select prefilled from the saved rule or the suggestion, "suggested" badge); block table (target or "follow layer"); text-rule table (pick from `texts`, target point type); Save (sends every layer rule); "Build revision" (after save, with the saved version).
- `/[locale]/projects/[projectId]/design-revisions` list and `/[id]` detail — `features/design-revisions`: status (icon + text), units/CRS (warning when `unitsConflict`), counts by type and route metres, text review list (default `status=review`, confidence ascending, confirm / reject / reassign to a feature id picked from a feature search), diff table (changed only by default), Publish (dialog when open items → acknowledge), Discard. Poll while `queued`/`building`.
- Link "Mapping" from the CAD file detail; nav entry "Design revisions". ar/en/fr strings; codes, numbers and coordinates LTR.
