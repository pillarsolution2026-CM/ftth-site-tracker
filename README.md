# FTTH Site Tracker

منصة ويب وتطبيق موبايل لمتابعة تنفيذ مشاريع FTTH على رسمة الكاد: المشرف يسجل شغل اليوم على الرسمة، والنظام يطلّع As-Built والحصر (مرتبط بمقايسة العقد) والمستخلص والفاتورة.

Web platform + mobile app for tracking FTTH rollout directly on CAD drawings, with As-Built editing, BOQ-linked quantity take-off and payment certificates.

## Contents
- `خطة بناء منصة متابعة تنفيذ FTTH على الكاد – لـClaude Code.md`: full build plan (workflow, architecture, data model, phases).
- `FTTH Site Tracker – Mobile Mockup …html`: supervisor app mockup.

- `docs/ROADMAP.md`: phased execution plan — tasks, assigned agent and model per task.
- `docs/ARCHITECTURE.md`: clean-architecture and code rules.
- `docs/DECISIONS.md`: ADRs (cloud hosting, server-side CAD, stack, model routing).
- `docs/PROGRESS.md`: phase tracking.
- `CLAUDE.md` and `.claude/agents/`: Claude Code rules and sub-agent definitions.
- `docs/prototype/`: standalone HTML mockup (open `index.html`): supervisor app screens + web QC and BOQ-linked invoice screens (sample data).

Status: Phase 0 (foundation) — see `docs/PROGRESS.md`.

## Run locally
```bash
pnpm install
pnpm build && pnpm test                 # all JS/TS packages
pnpm --filter @ftth/api test:int        # API integration tests (needs Docker)
cd workers/cad && uv sync && uv run pytest
docker compose -f infra/docker-compose.yml up -d --build   # postgis, redis, minio, martin, api, web, worker
# Dev seed is never run automatically; load it once (refuses NODE_ENV=production):
docker compose -f infra/docker-compose.yml run --rm -e ALLOW_DEV_SEED=true api node dist/db/seed.js
```
All published ports bind to 127.0.0.1 (dev only).
Dev users (seed): `admin@ftth.local` / `Admin#12345`, `pm@ftth.local` / `Pm#123456`, `supervisor@ftth.local` / `Super#12345`.
