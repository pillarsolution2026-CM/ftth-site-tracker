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
