# Phase 3 contracts — offline supervisor app

Decisions: ADR-023 (Phase 3 before Phase 2), ADR-024 (sync design). Zod sources of truth:
`packages/shared/src/execution/{execution.constants,execution.schemas,sync.schemas}.ts`.
Migration: `apps/api/src/db/migrations/0006_execution_sync.sql`.

## Permissions (assumption, owner to confirm)

| Permission | admin | pm | qc | supervisor | contractor |
| --- | --- | --- | --- | --- | --- |
| `execution:read` (bundle, changes) | ✓ | ✓ | ✓ | ✓ | — |
| `execution:write` (push, photo upload) | ✓ | ✓ | — | ✓ | — |

Zone-scoped roles (supervisor, contractor) act only on features whose design geometry intersects
one of their zones; project-wide roles (admin, pm, qc) on every feature.

## Endpoints (`/projects/:projectId/sync/…`, bearer token)

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| POST | `push` | `SyncPushRequest` `{deviceId, ops[1..50]}` | `SyncPushResponse` `{serverTime, results[]}` — 200 even when some ops are rejected |
| GET | `bootstrap` | — | `OfflineBundle` |
| GET | `changes` | `cursor` (default `0`), `limit` (1..500, default 200) | `SyncChangesResponse` |
| GET | `photos/:photoId` | — | `PhotoUploadStatus` |
| PUT | `photos/:photoId/content` | raw `application/octet-stream` ≤ 1 MiB, header `Upload-Offset` | `PhotoUploadStatus` |

### Operation `execution_update.record`

```
{ kind, clientOpId (uuid), capturedAt (device clock, ISO with offset),
  payload: { featureId, designRevisionId, workType (civil|installation|planning),
             lines[1..50] { workOrderItemId, quantity "decimal ≤4 dp, > 0", role work|material },
             label|null, note|null, gps {lon, lat, accuracyM, at}|null,
             photos[1..20] { photoId (uuid), requirementKey, sha256 (lower hex), sizeBytes ≤ 8 MiB,
                             contentType image/jpeg, takenAt, gps|null },
             acknowledgedWarnings[] (GPS_FAR | GPS_UNAVAILABLE | ITEM_OVERRUN) } }
```

Results per op: `applied {updateId}` · `duplicate {updateId}` (same id, user, device, project and
payload hash as before) · `rejected {code}` with code `OP_ID_REUSED`, `PHOTO_ID_REUSED`,
`FEATURE_NOT_FOUND`, `FEATURE_OUT_OF_SCOPE`, `REVISION_NOT_PUBLISHED`, `ITEM_NOT_FOUND`,
`ITEM_WORK_TYPE_MISMATCH`. Rejections are not stored, so a corrected op can be sent again.

Server flags (for QC, never a rejection): `CLOCK_AHEAD` (captured > received + 5 min),
`CLOCK_BEHIND` (captured < publication of the revision used), `GPS_FAR` (> 50 m), `GPS_MISSING`,
`ITEM_OVERRUN` (non-rejected recorded quantity > work-order quantity), `REVISION_OUTDATED`,
`FEATURE_REMOVED` (not in the latest published revision).

### Photo upload

1. The op carries photo metadata; the server creates the photo rows (`received_bytes = 0`).
2. `GET photos/:id` → where to resume. `PUT …/content` at that offset appends a chunk.
3. Wrong offset → 409 `CONFLICT` with the status in `details`. More bytes than declared → 413.
4. The last byte triggers the check: sha256 equal to the declared one and JPEG SOI/EOI markers.
   Mismatch → bytes discarded, 422 `VALIDATION_FAILED` with the status (offset 0) in `details`.
   Match → object written once at `projects/<projectId>/photos/<photoId>.jpg`, event
   `execution_photo.stored`.
5. Only the user who recorded the update can see or upload its photos (anyone else: 404).

## Limits (security review M3/M4; environment, technical defaults)

| Setting | Default | Effect |
| --- | --- | --- |
| `SYNC_RATE_LIMIT` | 120 / min / user | push, changes, bootstrap → 429 `RATE_LIMITED` + `Retry-After` |
| `SYNC_UPLOAD_RATE_LIMIT` | 600 / min / user | photo status and chunk requests |
| `SYNC_UPLOAD_BACKLOG_MB` | 64 | bytes one user may hold in unfinished uploads (all projects); a chunk that would exceed it → 429, the last chunk of an upload is always accepted |
| `SYNC_STALE_UPLOAD_HOURS` | 24 | hourly sweep discards unfinished uploads idle this long (`receivedBytes` back to 0) |
| `SYNC_LOCK_TIMEOUT_MS` | 5000 | a push waiting longer for the project lock → 429 |

## Database (migration 0006)

- `sync_operations` — idempotency record per `client_op_id` (append-only).
- `execution_updates` — immutable except review fields (`status`, `review_reason`, `reviewed_by`,
  `reviewed_at`); any change bumps `sync_seq` (pull cursor). No delete, no truncate.
- `execution_update_lines` — append-only; FK to `work_order_items` (deleting an item with recorded
  execution answers 409 `CONFLICT` `{reason: HAS_EXECUTION}`).
- `execution_photos` — metadata immutable; only upload progress changes until stored, then frozen.
- `execution_photo_chunks` — bytes of uploads in progress; deleted when stored or refused.
- Writes of one project are serialised with a transaction advisory lock so `sync_seq` order equals
  commit order (a cursor never skips a late commit). Phase 5 review writes must take the same lock.

## Device side

- `@ftth/sync` (pure TypeScript): `SyncEngine` (push in batches → upload photos → pull),
  `createHttpTransport`, `backoffDelayMs`, `InMemorySyncStore` (reference store for tests).
- Mobile: WatermelonDB tables `outbox_ops`, `local_photos`, `remote_updates`, `key_values`
  (`WatermelonSyncStore`); `SyncScheduler` (backoff, 401 refresh once, 403 stop); `FieldProvider`
  per project; offline bundle cached as JSON in the document directory.
