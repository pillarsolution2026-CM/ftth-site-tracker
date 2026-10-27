# FTTH Site Tracker — instructions for Claude Code

## Read first
- `docs/ROADMAP.md` — phases, tasks, which agent/model does each task.
- `docs/ARCHITECTURE.md` — clean architecture and code rules.
- `docs/DECISIONS.md` — accepted ADRs (cloud hosting, server-side CAD, stack).
- `خطة بناء منصة متابعة تنفيذ FTTH على الكاد – لـClaude Code.md` — workflow, data model, acceptance criteria.
- `FTTH Site Tracker Brainstorming.md` — business rules.

## Non-negotiable rules
1. Work phase by phase. Do not start a phase until the previous one is approved.
2. Start of phase: short plan (tasks, files, risks). End of phase: run all tests, update `docs/PROGRESS.md`, stop for approval.
3. Design revisions are immutable; As-Built is separate state with the same feature IDs; every change is an immutable event.
4. Every mobile write carries `client_op_id`; the server is idempotent.
5. Geometry in the project CRS (metric); WGS84 only for display/GPS.
6. Money is decimal / minor units, never float. Invoices are frozen snapshots.
7. Executed, accepted and invoiced quantities are kept separate; unapproved changes never increase contract value.
8. Arabic RTL first, plus English and French. Codes, numbers and coordinates stay LTR.
9. Tests are part of every task; a bug fix starts with a failing test; never mock PostGIS.
10. Never invent business rules (prices, units, BOQ codes) — ask.

## Orchestration
- The main session orchestrates: split the phase, fix contracts in `packages/shared` first, then dispatch implementation agents in parallel (separate worktrees, one module each), then review and merge.
- Agents live in `.claude/agents/`. Pick by task type:
  - Opus: `architect`, `finance-domain`, `sync-engineer`, `security-reviewer`, `cad-engineer` (algorithms)
  - Sonnet: `backend-dev`, `web-dev`, `mobile-dev`, `test-writer`, `ui-polisher`
  - Haiku: `i18n`, `chore`, `explorer`
- Give each agent only the files and contracts it needs, not the whole repo.
