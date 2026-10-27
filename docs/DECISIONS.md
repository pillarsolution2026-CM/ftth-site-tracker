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
