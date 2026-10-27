# Phase 1a contracts — work orders, Excel import, attachments, CAD upload

All schemas are exported from `@ftth/shared`. ADRs: 011 (work orders, money, import), 012 (storage, uploads), 013 (job protocol). Data model: `docs/phase-1a-data-model.md`.

## Common rules

- Guards on every route: `JwtAuthGuard` → `ProjectScopeGuard` (`:projectId`) → `PermissionGuard` with `@RequirePermission(p)`; the guard passes when `request.auth.isAdmin` or `hasPermission(request.projectAccess.roles, p)`. Repositories also filter by `project_id` (a child id from another project → `NOT_FOUND`, never `FORBIDDEN`).
- Errors: `ApiError {code, message, details?}`. New codes: `UNSUPPORTED_FILE` 415, `FILE_TOO_LARGE` 413, `IMPORT_INVALID` 422 (details = `ImportInvalidDetailsSchema`). Also update `AllExceptionsFilter.codeForHttpStatus` so 413/415 from multer map to these codes.
- Money/quantities are decimal strings (`Decimal4StringSchema` in, `DecimalStringSchema` out, shortest exact form: `"12.5"`, not `"12.5000"`). Timestamps ISO-8601 UTC (`toISOString()`), dates `YYYY-MM-DD`.
- Multipart: file field `file`; JSON field `payload` (a string, parsed with the named schema). Uploads are streamed to `ObjectStorage` (`apps/api/src/common/object-storage.port.ts`) with `maxBytes = MAX_UPLOAD_MB × 2^20`; never buffer the whole file in memory except the xlsx being parsed.
- Raise the JSON body limit to 5 MB (create with up to `MAX_WORK_ORDER_ITEMS` items).
- Every state change appends one event (`EVENT_ENTITIES`, `EVENT_TYPES`) in the same transaction as the change.
- Lists are ordered: work orders by `number`; items by `line_no`; attachments and CAD files by `created_at DESC`; layers by `name`; inserts/texts/curves by `layer, handle`.

## Permissions (`packages/shared/src/auth/permissions.ts`)

| Permission | Roles (assumption, ADR-011) |
| --- | --- |
| `work_orders:read`, `cad_files:read` | admin, pm, qc, supervisor |
| `work_orders:write`, `cad_files:write` | admin, pm |
| — | contractor: none |

## Work orders — module `work-orders`

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `/projects/:projectId/work-orders` | work_orders:read | — | 200 `WorkOrderListResponse` |
| POST | `/projects/:projectId/work-orders` | work_orders:write | `CreateWorkOrderRequest` | 201 `WorkOrderDetail`; 409 CONFLICT number taken |
| GET | `/projects/:projectId/work-orders/:workOrderId` | work_orders:read | — | 200 `WorkOrderDetail` |
| PATCH | `/projects/:projectId/work-orders/:workOrderId` | work_orders:write | `UpdateWorkOrderRequest` | 200 `WorkOrderDetail`; 409 version mismatch or number taken |
| DELETE | `/projects/:projectId/work-orders/:workOrderId` | work_orders:write | — | 204 (event holds a snapshot; storage objects deleted after commit) |
| POST | `…/work-orders/:workOrderId/items` | work_orders:write | `AddWorkOrderItemRequest` | 201 `WorkOrderItem`; 409 line taken / duplicate code not accepted |
| PATCH | `…/work-orders/:workOrderId/items/:itemId` | work_orders:write | `UpdateWorkOrderItemRequest` | 200 `WorkOrderItem` |
| DELETE | `…/work-orders/:workOrderId/items/:itemId` | work_orders:write | — | 204 (line numbers are not compacted) |

Domain: `WorkOrder` aggregate with `items`; `Decimal` value object (bigint + scale; `parse(string)`, `add`, `mul`, `toString()` shortest exact; no `number` in or out). `total = Σ quantity × unitPrice`. Currency comes from the exported projects application service at creation (export `GET_PROJECT_USE_CASE` from `ProjectsModule`), not from a query on `projects`.

### Excel import

| Method | Path | Permission | Request (multipart) | Response |
| --- | --- | --- | --- | --- |
| POST | `/projects/:projectId/work-orders/import/preview` | work_orders:write | `file` (.xlsx) + `payload` = `WorkOrderImportPreviewOptions` (may be `{}`) | 200 `WorkOrderImportPreviewResponse` (no writes) |
| POST | `/projects/:projectId/work-orders/import` | work_orders:write | `file` + `payload` = `WorkOrderImportCommitPayload` | 201 `WorkOrderDetail`; 422 IMPORT_INVALID; 409 number taken |

Rules for the parser (backend-dev):
- Accept `.xlsx` only (zip magic `PK\x03\x04` + OOXML content type); `.xls`/`.csv` → `UNSUPPORTED_FILE`. Read cached formula results; a formula without a result → `FORMULA_WITHOUT_RESULT`.
- Header row: scan the first `HEADER_SCAN_ROWS` rows, normalise cells (see `IMPORT_HEADER_SYNONYMS` comment), pick the row with the most matched fields (≥ `HEADER_MIN_MATCHES`); per field prefer exact match, then the longest contained synonym ("سعر الوحدة" beats "الوحدة"). Merged header cells: use the top-left value.
- Numbers: numeric cells → shortest round-trip string of the JS number (never arithmetic), then `Decimal4StringSchema`; > 4 decimals → `TOO_MANY_DECIMALS` (no silent rounding). Text cells: convert Arabic-Indic digits (٠-٩, ۰-۹), `٫` → `.`, drop `٬`/`,` thousands separators and spaces.
- Fully empty rows are skipped; any other row is returned with its issues. `DUPLICATE_CODE` is added to every row of a repeated code (`params.otherRows`). `AMOUNT_MISMATCH` when the sheet amount ≠ computed amount rounded half-up to the sheet value's decimals.
- Commit: re-parse; reasons for IMPORT_INVALID: sha256 differs (`FILE_CHANGED`), any file issue, an included row with an error, a duplicate code among included rows not in `acceptedDuplicateCodes`, zero included rows. Items get `line_no` 1..n in sheet order, `source='import'`, `source_row=rowNumber`. Store the xlsx as an `import_source` attachment (object first, DB transaction second, delete the object if the transaction fails). One event `work_order.imported`.

### Attachments

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| GET | `…/work-orders/:workOrderId/attachments` | work_orders:read | — | 200 `WorkOrderAttachmentListResponse` |
| POST | `…/work-orders/:workOrderId/attachments` | work_orders:write | multipart `file` (PDF, magic `%PDF-`) | 201 `WorkOrderAttachment` (`kind='document'`) |
| GET | `…/work-orders/:workOrderId/attachments/:attachmentId/content` | work_orders:read | — | 200 stream, `Content-Type`, `Content-Disposition: attachment; filename*=UTF-8''…` |
| DELETE | `…/work-orders/:workOrderId/attachments/:attachmentId` | work_orders:write | — | 204 (`import_source` cannot be deleted → 409) |

## CAD files — module `cad`

| Method | Path | Permission | Request | Response |
| --- | --- | --- | --- | --- |
| POST | `/projects/:projectId/cad-files` | cad_files:write | multipart `file` (.dwg/.dxf) | 201 `CadFileSummary` (status `queued`, or `failed` with `ENQUEUE_FAILED`) |
| GET | `/projects/:projectId/cad-files` | cad_files:read | — | 200 `CadFileListResponse` |
| GET | `/projects/:projectId/cad-files/:cadFileId` | cad_files:read | — | 200 `CadFileDetail` |
| GET | `…/cad-files/:cadFileId/content` | cad_files:read | — | 200 stream of the original |
| GET | `…/cad-files/:cadFileId/log` | cad_files:read | — | 200 `CadFileLogResponse` |
| GET | `…/cad-files/:cadFileId/layers` | cad_files:read | — | 200 `CadLayerListResponse` |
| GET | `…/cad-files/:cadFileId/inserts` | cad_files:read | query `CadInsertListQuery` | 200 `CadInsertPage` |
| GET | `…/cad-files/:cadFileId/texts` | cad_files:read | query `CadTextListQuery` | 200 `CadTextPage` |
| GET | `…/cad-files/:cadFileId/curves` | cad_files:read | query `CadCurveListQuery` | 200 `CadCurvePage` |
| POST | `…/cad-files/:cadFileId/reprocess` | cad_files:write | — | 202 `CadFileSummary` (status `queued`); 409 if `processing`/`queued` and not stale (`CAD_STALE_AFTER_MINUTES`) |

Upload (backend-dev): format from the extension, verified by content — DWG starts with `AC10` + 2 digits; binary DXF starts with `AutoCAD Binary DXF`; ASCII DXF's first non-comment group is `0` / `SECTION`. Mismatch → `UNSUPPORTED_FILE`. Flow: stream to `storageKeys.cadOriginal(...)` (sha256 and size from `put`) → insert row `uploaded` + event `cad_file.uploaded` → set `queued`, new `current_job_id`, `queued_at` + event `cad_file.queued` → commit → `LPUSH cad:jobs` (`CadImportJob`, attempt 1). Reprocess: clear `error_code`/`error_message`, new job id, same flow from `queued`. Extraction lists of a file that is not `processed` return empty pages.

Worker (cad-engineer), per ADR-013:
- Parse with `cad_worker/adapters/job_message.py` (`parse_job`); invalid → `cad:dead`.
- Start: conditional UPDATE to `processing` (+ event `cad_file.processing_started`). DWG → DXF via ODA (fallback LibreDWG), write `storageKeys.cadConverted`, then `ezdxf.recover`.
- Extract layers, model-space INSERTs with ATTRIBs, TEXT/MTEXT (raw + decoded + `readable`), LINE/LWPOLYLINE/POLYLINE/ARC/CIRCLE/SPLINE as `LineStringZ` SRID 0 (flattened arcs set `flatten_tolerance`), extents from entities, `CadWarning`s, converter log.
- Finish: one transaction (DELETE old rows, COPY new rows, set counts/extents/warnings/log, `processed`, event `cad_file.processed`) guarded by `current_job_id`; then ack. Failure: `failed` + `CadFailureCode` + event `cad_file.failed`; ack.
- Settings to add: `STORAGE_DRIVER`, `STORAGE_FS_ROOT`, S3 settings (same names as the API), `WORKER_ID` (default hostname).

## Web (web-dev)

Screens against the contracts above: work-order list/detail with item table (amounts and codes LTR), item form, import wizard (upload → sheet/header/mapping selection → row review with error/warning filters, "exclude rows with errors", per-code duplicate decisions → header form → commit), attachments; CAD file list with status (icon + text), detail with warnings, layers table, inserts/texts/curves tabs with filters, unreadable-texts filter. Hide actions with `hasPermission`; the API remains the authority.
