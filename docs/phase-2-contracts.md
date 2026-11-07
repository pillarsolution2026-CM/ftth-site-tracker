# Phase 2 contracts — contract and BOQ (step 1)

Decision: ADR-027. Zod source of truth: `packages/shared/src/contracts/contract.schemas.ts`
(plus the import changes in `work-orders/work-order-import.schemas.ts` and `admin/admin.schemas.ts`).
Migration: `apps/api/src/db/migrations/0007_contracts_and_boq.sql`.

## Model

```
contract (العقد)          number, name, client, currency, startsOn, durationDays, notes, PDF, status
  └── contract_items       BOQ lines: item (priced) or heading (section title)
  └── project (= one work order, «أمر التكليف / المشروع»)   drawing, CRS, zones, team, execution
```

- Only platform admins write contracts. A PM (role `pm` in a project) reads the contract of that
  project (`contract:read`). Supervisors, QC and contractors do not see it.
- `draft` → `approved` (final). After approval the BOQ lines are locked by a DB trigger; header
  fields except the currency stay editable.

## Endpoints

Admin (all `PlatformAdminGuard`, events with `project_id` NULL):

| Method | Path | Body / query | Answer |
| --- | --- | --- | --- |
| GET | `/admin/contracts` | — | `ContractListResponse` |
| POST | `/admin/contracts` | `CreateContractRequest` | 201 `ContractDetail` |
| GET | `/admin/contracts/:contractId` | — | `ContractDetail` |
| PATCH | `/admin/contracts/:contractId` | `UpdateContractRequest` | `ContractDetail` (409 `CONFLICT` on stale version, duplicate number) |
| POST | `/admin/contracts/:contractId/items` | `AddContractItemRequest` | 201 `ContractDetail` (409 when approved / duplicate code not accepted / line taken) |
| PATCH | `/admin/contracts/:contractId/items/:itemId` | `UpdateContractItemRequest` | `ContractDetail` |
| DELETE | `/admin/contracts/:contractId/items/:itemId` | `?expectedVersion=` | `ContractDetail` |
| POST | `/admin/contracts/:contractId/import/preview` | multipart `file` + `payload` = `ContractImportPreviewOptions` | `ContractImportPreviewResponse` |
| POST | `/admin/contracts/:contractId/import` | multipart `file` + `payload` = `ContractImportCommitPayload` | `ContractDetail` (422 `IMPORT_INVALID`, 409 when approved or stale) |
| POST | `/admin/contracts/:contractId/approve` | `ApproveContractRequest` | `ContractDetail` (409 when already approved, stale, or no priced item) |
| GET | `/admin/contracts/:contractId/attachments/:attachmentId` | — | file download |
| POST | `/admin/contracts/:contractId/attachments` | multipart `file` (PDF) | 201 `ContractAttachment` |
| DELETE | `/admin/contracts/:contractId/attachments/:attachmentId` | — | 204 |

Project-scoped (read only):

| Method | Path | Permission | Answer |
| --- | --- | --- | --- |
| GET | `/projects/:projectId/contract` | `contract:read` | `ContractDetail` (404 when the project has no contract) |

Changed:

- `POST /admin/projects` takes `contractId` instead of `client` and `currency`; both are copied
  from the contract. `PATCH /admin/projects/:id` no longer edits the client. `Project.contractId`
  is null only for projects created before Phase 2.

`409 CONFLICT` details carry `reason`: `STALE_VERSION`, `CONTRACT_APPROVED`, `DUPLICATE_CODE`,
`LINE_TAKEN`, `DUPLICATE_NUMBER`, `NO_PRICED_ITEMS`.

## Import rules (both imports; owner, 2026-10-31)

| Rule | Behaviour |
| --- | --- |
| `مسلسل` header | suggested as the code column |
| Heading row | unit and unit price empty, quantity and amount empty or 0 → `kind: 'heading'`; needs only a code; no other checks; not in the total; contract import stores it as a heading line, work-order import skips it |
| Zero quantity / price | accepted (quantity ≥ 0, price ≥ 0) |
| Work type | taken from each row (no inheritance from the section) |
| Unit typed differently | `UNIT_FORM_VARIANT` warning (`params.otherRows`), value kept as typed; does not block |
| Priced item with priced children | allowed |
| Duplicate codes | as in work orders: exclude rows or accept the code explicitly |

`summary.headingCount` counts heading rows. The commit stores the original xlsx as an
`import_source` attachment, like the work-order import.

## Checked against the sample (`contract boq.xlsx`)

Expected after this step: 199 rows → 160 items + 39 headings, 0 error rows, total
`236701830.984`, `UNIT_FORM_VARIANT` warnings on rows 192–195 and 199–200 (the `BULDING …` units).

# Step 2 — work-order lines from the contract (ADR-028)

Migration `0008_work_order_lines_from_contract.sql`. Zod: `work-orders/work-order.schemas.ts`
(`WorkOrderLineInput`, `CreateWorkOrderRequest.lines`, `AddWorkOrderItemRequest`,
`UpdateWorkOrderItemRequest` = quantity only, `WORK_ORDER_CONFLICT_REASONS`,
`ContractItemAvailability*`, `WorkOrderItem.contractItemId`) and
`work-orders/work-order-import.schemas.ts` (issue codes `NOT_IN_CONTRACT`, `CONTRACT_MISMATCH`,
`CODE_REPEATED`, `QUANTITY_EXCEEDS_CONTRACT`).

| Method | Path | Change |
| --- | --- | --- |
| GET | `/projects/:projectId/work-orders/contract-items` | new; `work_orders:write`; `ContractItemAvailabilityResponse`; 409 `NO_CONTRACT` / `CONTRACT_NOT_APPROVED` |
| POST | `/projects/:projectId/work-orders` | body `lines[]` of `{contractItemId, quantity}`; 409 `NO_CONTRACT`, `CONTRACT_NOT_APPROVED`, `WORK_ORDER_EXISTS`, `NOT_IN_CONTRACT`, `CONTRACT_ITEM_REPEATED`, `QUANTITY_EXCEEDS_CONTRACT` |
| POST | `…/work-orders/:id/items` | body `{contractItemId, quantity, lineNo?}`; same 409 reasons |
| PATCH | `…/work-orders/:id/items/:itemId` | body `{quantity}` only; 409 `QUANTITY_EXCEEDS_CONTRACT`, `LEGACY_ITEM` |
| DELETE | `…/work-orders/:id/items/:itemId`, `…/work-orders/:id` | unchanged; frees the reserved quantity |
| POST | `…/work-orders/import/preview`, `…/work-orders/import` | rows matched to the approved contract by code (issues above); 409 `NO_CONTRACT`, `CONTRACT_NOT_APPROVED`, `WORK_ORDER_EXISTS` before reading the file |

Matching rules: the code must be a priced item of the contract (headings never match); then
`description` and `unit` must be equal as stored (trimmed), `unitPrice` equal as a decimal
(`8000` = `8000.00`), `workType` equal. Quantity check: `reserved (other work orders) + row
quantity ≤ contract quantity`. A code on two rows → `CODE_REPEATED` on both.

Empty quantity (owner, 2026-10-31): an item row whose quantity cell is empty becomes
`kind: 'skipped'` with the warning `EMPTY_QUANTITY_SKIPPED`; it is not checked against the
contract and never stored. A quantity of 0 or unreadable text is not empty.

Checked with the owner's files (copies, not committed): the work-order sheet
(`boq_restored3_errors_yellow.xlsx`, same 199 codes, quantities = 1/3 of the contract) against
`contract boq.xlsx` → 0 errors, 153 lines, 7 skipped rows (the contract's zero-quantity items, empty
in the sheet), 39 headings, total `78900610.328`. With two identical work orders already reserved
it still fits exactly; a fourth gives `QUANTITY_EXCEEDS_CONTRACT` on 153 rows.

# Subcontractors, part 1 (point 2-أ, ADR-036)

Zod: `packages/shared/src/contractors/contractor.schemas.ts` (+ import field `scope`).
Migration: `0013_subcontractors.sql`.

```
contractors                     shared list: name, contact person, phone, commercial register, tax card
  └── contractor_registrations  contractor on a project's work order + registration date
        ├── contractor_lines    work-order line + scope of work (NULL = whole) + quantity + source row
        │     └── contractor_line_prices   dated prices (append-only)
        └── contractor_import_files        uploaded sheets (write-once)
```

Rules: per work-order line and scope Σ quantity ≤ work-order quantity; whole and scoped lines never
mix; Σ over scopes of each scope's highest price ≤ contract price; first price on the registration
date, each next one later; the last line of a registration cannot be removed.

| Method | Path | Notes |
| --- | --- | --- |
| GET, POST | `/admin/contractors` | admin; 409 `CONTRACTOR_NAME_TAKEN` |
| GET, PATCH | `/admin/contractors/:contractorId` | admin; PATCH needs `expectedVersion` (409 `STALE_VERSION`) |
| GET | `/admin/projects/:projectId/contractors` | registrations (lines with scope, files) + `availability` per work-order line and scope |
| POST | `/admin/projects/:projectId/contractors/import/preview` | multipart file + `{target, sheetName?, headerRow?, mapping?}`; row issues `NOT_IN_WORK_ORDER`, `WORK_ORDER_MISMATCH`, `LEGACY_WORK_ORDER_LINE`, `CODE_SCOPE_REPEATED`, `WHOLE_AND_SCOPES_MIXED`, `LINE_ALREADY_ASSIGNED`, `QUANTITY_EXCEEDS_WORK_ORDER`, `PRICE_EXCEEDS_CONTRACT` |
| POST | `/admin/projects/:projectId/contractors/import` | target `new` (contractor + date) or `append` (registration); 201; 409 `NO_WORK_ORDER`, `CONTRACTOR_ALREADY_REGISTERED`; 422 `IMPORT_INVALID` |
| DELETE | `…/contractors/:registrationId` | snapshot in the event |
| PATCH, DELETE | `…/lines/:lineId` | quantity only (per scope); 409 `LAST_LINE` on delete of the only line |
| POST | `…/lines/:lineId/prices` | `{effectiveFrom, unitPrice}`; 409 `PRICE_EXCEEDS_CONTRACT` (scope sum), `PRICE_DATE_NOT_AFTER_LATEST` |
| GET | `/projects/:projectId/contractors` | `contractors:read` (admin, pm) |

Work-order writes gain 409 `QUANTITY_BELOW_CONTRACTORS` (largest scope sum), `LINE_HAS_CONTRACTORS`,
`WORK_ORDER_HAS_CONTRACTORS`.

Owner's example (checked in PostGIS, unit and integration tests): line 2-12-4-8, work-order quantity
225, contract price 2,033.12 — «تركيب الخوصة» 225 @300, «تركيب البوكس» 225 @900, «لحام البوكس» 150
@500 + 75 @833.12 (exactly 2,033.12) accepted; 76 more or 834 refused; a whole-line row refused.

The price used for work on day D (Phase 5) is the line price with the latest `effectiveFrom` ≤ D.
