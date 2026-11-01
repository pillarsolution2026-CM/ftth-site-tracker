# Phase 4 contracts — As-Built editing

Decisions: ADR-029 (start order), ADR-030 (model). Zod sources of truth:
`packages/shared/src/asbuilt/asbuilt.schemas.ts` (+ `execution/sync.schemas.ts`, `cad/cad-job.schemas.ts`,
`auth/permissions.ts`, `events/domain-events.ts`). Migration: `apps/api/src/db/migrations/0009_asbuilt.sql`.
All coordinates are metres in the project CRS (the revision's `crs_epsg`), never WGS 84.

## Permissions (assumptions, owner to confirm)

| Permission | admin | pm | qc | supervisor | contractor |
| --- | --- | --- | --- | --- | --- |
| `asbuilt:read` (edits, state, lengths) | ✓ | ✓ | ✓ | ✓ (zones) | — |
| `asbuilt:write` (record edits from the phone) | ✓ | ✓ | — | ✓ (zones) | — |
| `asbuilt:review` (approve / reject) | ✓ | ✓ | ✓ | — | — |
| `asbuilt:export` (request / download DXF) | ✓ | ✓ | — | — | — |

- Write scope comes only from assignments whose role grants `asbuilt:write` (Phase 3 H1 rule).
- Read scope for zone-scoped roles: an edit or state is visible when the feature's design geometry
  (latest published revision) or the edit's proposed geometry intersects one of the user's zones.
- Nobody reviews an edit they recorded (403 `FORBIDDEN`, `details.reason = SELF_REVIEW`).
- A platform admin (`isAdmin`) passes like elsewhere (ADR-007).

## Sync (Phase 3 path, ADR-024)

`POST /projects/:projectId/sync/push` accepts `asbuilt_edit.record` next to
`execution_update.record`. Per op, in its own transaction under the project lock:

1. Idempotency exactly as Phase 3 (`sync_operations`; same id + user + device + payload hash →
   `duplicate` with the first `updateId` = the edit id; anything else → `OP_ID_REUSED`).
2. Checks, first failure wins (rejections are not stored, the device may send a corrected op):
   - caller has no assignment granting `asbuilt:write` → `FEATURE_OUT_OF_SCOPE`;
   - `designRevisionId` not a published revision of the project → `REVISION_NOT_PUBLISHED`;
   - **add_\***: `featureId` exists (design feature anywhere, or any earlier add) → `FEATURE_ID_REUSED`;
   - **other kinds**: feature unknown in the project (not a design feature, not an *approved* added
     feature) → `FEATURE_NOT_FOUND`; a design feature not in `designRevisionId` →
     `REVISION_NOT_PUBLISHED`; `move` on a route / `reshape` on a point → `GEOMETRY_KIND_MISMATCH`;
   - geometry not `ST_IsValid`, or a route with `ST_Length = 0` → `GEOMETRY_INVALID`;
   - zone-scoped caller: existing feature's design geometry not in scope (in `designRevisionId`, and in
     the latest revision when the feature is still there — Phase 3 L8), or proposed geometry not
     entirely inside the caller's zones (`ST_CoveredBy` their union; security review M1), or an added feature (approved state geometry) not in scope →
     `FEATURE_OUT_OF_SCOPE`.
3. Flags (never a rejection): `BASE_OUTDATED` (baseVersion ≠ current approved geometry/label
   version at receipt), `REVISION_OUTDATED`, `FEATURE_REMOVED` (design feature not in the latest
   published revision), `CLOCK_AHEAD` (Phase 3 tolerance).
4. Writes: `sync_operations` row (kind `asbuilt_edit.record`), `asbuilt_edits` row (status
   `pending`), event `asbuilt_edit.recorded`. `featureType` of the record is the design feature's
   type, the added feature's type, `route` for `add_route`, `payload.featureType` for `add_symbol`.

Pull: `GET …/sync/changes` returns `asBuiltEdits` (in the caller's read scope) with
`sync_seq > cursor` on the same sequence as `updates`; the page limit counts both kinds, the cursor is
the max sequence returned. `GET …/sync/bootstrap` returns `asBuilt` (approved state of in-scope
features that differ from design or were added). Rejection codes are unchanged for Phase 3 ops.

## Web review (`/projects/:projectId/asbuilt/…`, bearer token)

| Method | Path | Permission | Body / query | Answer |
| --- | --- | --- | --- | --- |
| GET | `edits` | `asbuilt:read` | `AsBuiltEditListQuery` | `AsBuiltEditListResponse` (newest received first) |
| GET | `edits/:editId` | `asbuilt:read` | — | `AsBuiltEditDetail` (404 outside scope or project) |
| POST | `edits/:editId/approve` | `asbuilt:review` | `{}` | `AsBuiltEdit` |
| POST | `edits/:editId/reject` | `asbuilt:review` | `RejectAsBuiltEditRequest` | `AsBuiltEdit` |
| GET | `state` | `asbuilt:read` | — | `AsBuiltStateResponse` |
| GET | `lengths` | `asbuilt:read` | — | `AsBuiltLengthsResponse` |

All `/asbuilt/…` routes are rate limited per user (`SYNC_RATE_LIMIT` per minute, own counter; 429
`RATE_LIMITED` + `Retry-After`; security review M2).

Review rules (both under the project lock, one transaction):
- Only `pending` edits: otherwise 409 `CONFLICT` `{reason: NOT_PENDING}`.
- Approve: `baseVersion` must equal the current approved version (geometry version for
  move/reshape, label version for label) → else 409 `{reason: STALE_BASE}`. An add needs no base.
  Approval sets `approved_version = current + 1` (1 for an add), updates `asbuilt_features`
  (insert for an add or the first approved edit of a design feature; `geom`/`geometry_version`/
  `geometry_edit_id` for shapes, `label`/`label_version`/`label_edit_id` for labels; an add with a
  label sets both versions to 1), writes event `asbuilt_edit.approved`.
- Reject: reason required, event `asbuilt_edit.rejected`. A rejected edit is final; the supervisor
  records a new edit (new `clientOpId`) on the current state.

### Approved lengths (Phase 5 read model)

`AsBuiltLengthsPort` (exported by the `asbuilt` API module) and `GET …/asbuilt/lengths`: one row per
route of the latest published revision plus each approved added route. `lengthM` = approved As-Built
`ST_Length` (3 dp) when an approved geometry exists, else `design_features.length_m`; `source` tells
which. Design routes missing from the latest revision are left out. Nothing pending counts.

## As-Built DXF export

| Method | Path | Permission | Answer |
| --- | --- | --- | --- |
| POST | `exports` | `asbuilt:export` | 202 `AsBuiltExport` (`queued`); 409 `{reason: NO_PUBLISHED_REVISION}`; 409 `{reason: EXPORT_IN_PROGRESS}` while another export of the project is queued or processing |
| GET | `exports` | `asbuilt:export` | `AsBuiltExportListResponse` (newest first, ≤ 50) |
| GET | `exports/:exportId` | `asbuilt:export` | `AsBuiltExport` |
| GET | `exports/:exportId/file` | `asbuilt:export` | the DXF (`application/dxf`, `attachment`, `nosniff`); 409 until `done` |

Job `cad.export_asbuilt` (`CadExportAsBuiltJob`) on the existing `cad:jobs` queue (ADR-013 guard:
`current_job_id`, 3 attempts, then `failed` / `MAX_ATTEMPTS_EXCEEDED`). The worker reads from the
database at run time:

- the export row's `revision_id` (latest published when requested) and its `crs_epsg`;
- `design_features` of that revision → entities on their **original layer names**
  (`LWPOLYLINE`/`POLYLINE` for routes, a point symbol for points), design text as on the drawing;
- `asbuilt_features` of the project: approved geometry of design features → `ASBUILT_EDITS`;
  approved added features → `ASBUILT_ADDED`; As-Built labels as `TEXT` on the same layer; a status
  text per edited/added feature (`AS-BUILT G<geometryVersion> L<labelVersion>` / `AS-BUILT ADDED`).
- Units metres (`$INSUNITS = 6`), DXF R2018 (UTF-8, Arabic labels). Layer names are checked with
  ezdxf's validator; text is stripped of control characters and `%%` control codes are neutralised.
- Output written once to `projects/<projectId>/asbuilt/<exportId>.dxf`; row `done` with size,
  sha256 and stats; event `asbuilt_export.done` (actor NULL). Files are checked with `ezdxf audit`
  in tests; opening in AutoCAD is a manual check (plan, Phase 6).

## Database (migration 0009)

- `asbuilt_edits` — immutable except the one review (`status`, `review_reason`, `reviewed_by`,
  `reviewed_at`, `approved_version`), which bumps `sync_seq`. No delete/truncate. Shape, base,
  label and review consistency are CHECK constraints; a BEFORE INSERT trigger checks the target
  (existing design feature / approved add of the same type, or a new id for adds).
- `asbuilt_features` — projection of approved state; versions only increase; geometry and label
  must come from an approved edit with the matching version (trigger). No delete/truncate.
- `asbuilt_exports` — export jobs and their output.
- `sync_operations.kind` now allows `asbuilt_edit.record`.

## Device side

- `@ftth/sync`: `SyncStore.applyRemoteAsBuiltEdits(edits)`; the engine applies `asBuiltEdits` of each
  pull page. As-Built ops have no photos.
- Mobile (`apps/mobile/src/features/asbuilt`): tools on `@ftth/geo` (snap 14 px, grips, live length,
  undo/redo in the session); on save, one `asbuilt_edit.record` per changed feature with the final
  geometry and the base version from the bundle / pulled approved edits.
