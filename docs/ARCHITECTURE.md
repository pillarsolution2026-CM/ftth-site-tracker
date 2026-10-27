# Architecture & Clean Code Rules

These rules apply to every app, package and worker in the monorepo. If a rule must be broken, record why in `docs/DECISIONS.md`.

## 1. Layers (Clean / Hexagonal)

Used in `apps/api` (per module) and `workers/cad`. Dependencies always point inward.

| Layer | Contains | May depend on | Must not contain |
| --- | --- | --- | --- |
| `domain` | Entities, value objects (`Money`, `Quantity`, `Geometry`), domain rules, repository **interfaces**, domain events | nothing (pure TS / Python) | NestJS, ORM, HTTP, S3, Redis |
| `application` | Use cases (one class = one action), ports, transactions | `domain` | SQL, HTTP details |
| `infrastructure` | Repository implementations (Drizzle / PostGIS), S3, BullMQ, external converters | `domain`, `application` | business rules |
| `interface` | Controllers, DTO mapping (Zod), guards, queue consumers | `application` | business rules |

## 2. Modular monolith (NestJS)

One module per bounded context:

`identity` · `projects` · `work-orders` · `cad` · `boq` · `execution` · `asbuilt` · `qc` · `quantities` · `changes` · `invoicing`

- A module never queries another module's tables. It calls an exported application service or reacts to a domain event.
- Every table carries `project_id`; authorization is checked in a guard **and** in the repository query (defence against IDOR).
- Every state change writes an immutable row to `events`; current state is a projection.

```
apps/api/src/modules/execution/
  domain/          update.entity.ts, update-line.vo.ts, update.repository.ts
  application/     record-update.use-case.ts, approve-update.use-case.ts
  infrastructure/  drizzle-update.repository.ts
  interface/       updates.controller.ts, updates.consumer.ts
  execution.module.ts
```

## 3. Contract-first

- All request/response payloads and sync operations are Zod schemas in `packages/shared`. Types for web, mobile and API are inferred from them; OpenAPI is generated from them.
- Error codes live in `packages/shared/errors.ts`; never return free-text errors to clients.

## 4. Domain invariants (non-negotiable)

- **Money:** `Money` value object over decimal / integer minor units. No `number` arithmetic on money, no floats.
- **Geometry:** stored in the project CRS (metric). All CRS transforms go through `packages/geo` (TS) or `workers/cad/cad_worker/domain/geo.py` (Python) only.
- **Design revisions are immutable.** As-Built is separate state keyed by the same feature IDs.
- **Idempotency:** every mobile write carries `client_op_id`; handlers are idempotent.
- **Executed ≠ accepted ≠ invoiced.** Each quantity status is a separate field/table; an unapproved change never increases contract value.
- **Invoices are snapshots:** once locked, never recalculated.

## 5. Frontend (web + mobile)

Feature-sliced structure:

```
src/features/<feature>/
  components/   presentational only (props in, events out)
  hooks/        state + side effects
  api/          TanStack Query hooks over shared schemas
  model/        pure helpers / mappers
src/shared/     design-system components, i18n, utils
```

- No business logic in components. No direct `fetch` in components.
- Design tokens come from `packages/ui-tokens`; no hard-coded colours.
- RTL first; codes, numbers and coordinates are wrapped LTR.
- Status is never shown by colour alone (colour + icon/text).

## 6. Python worker

```
workers/cad/cad_worker/
  domain/        feature types, text-link rules, geo
  application/   import_drawing.py, export_asbuilt.py
  adapters/      ezdxf_reader.py, oda_converter.py, postgis_writer.py, queue.py
```

Type hints everywhere (`mypy --strict`), `ruff` for lint/format, pure functions in `domain`.

## 7. Code style

- TypeScript `strict`, no `any`, no non-null `!` without a comment.
- ESLint + Prettier; Ruff + mypy; pre-commit runs them.
- Small functions with intention-revealing names; comments explain *why*, not *what*.
- Conventional Commits (`feat(execution): …`, `fix(cad): …`).
- Tests sit next to the code (`*.spec.ts`, `test_*.py`); a bug fix starts with a failing test.
- Integration tests use Testcontainers PostGIS — never mock PostGIS.

## 8. Excel exports

Exports built with ExcelJS use real formulas (not pasted values) for totals, cumulative quantities, remaining quantities and KPIs, and include an «شرح» sheet that explains each formula and KPI in Arabic.
