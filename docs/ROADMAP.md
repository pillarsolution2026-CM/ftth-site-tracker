# FTTH Site Tracker — خارطة التنفيذ (Roadmap)

المرجع التفصيلي للـworkflow ونموذج البيانات ومعايير القبول: `خطة بناء منصة متابعة تنفيذ FTTH على الكاد – لـClaude Code.md`.
قواعد الكود والمعمارية: `docs/ARCHITECTURE.md`. القرارات: `docs/DECISIONS.md`. المتابعة: `docs/PROGRESS.md`.

**قرارات محسومة:** تخزين وتشغيل سحابي على Hetzner بدومين `ftthtracker.projectflow.site`، معالجة AutoCAD على السيرفر فقط (Python worker)، الـStack كما في خطة البناء.

## 1. نظام الـAgents وتوجيه الموديلات

### المبدأ
- **Opus 5.5** = التفكير الصعب والقرارات اللي غلطها غالي: المعمارية، نموذج البيانات، المنطق المالي، الهندسة/الإحداثيات، المزامنة offline، المراجعة الأمنية. استخدام قليل ومركّز.
- **Sonnet 5.5** = الحصان الأساسي: تنفيذ الـfeatures، الـAPI، الشاشات، الاختبارات. ~70% من الشغل.
- **Haiku 5.5** = شغل ميكانيكي محدد بدقة: boilerplate، ترجمات i18n، إصلاح lint، تحديث docs، البحث في الكود (Explore)، تشغيل الاختبارات وتلخيصها.
- **قاعدة توفير التوكن:** Opus يكتب الـcontract (types/interfaces/ADR) مرة واحدة → Sonnet ينفذ عليه → Haiku يكمل الروتيني. كل agent بياخد prompt فيه الملفات المحددة بس، مش الريبو كله.

### الـAgents المقترحة (`.claude/agents/`)
| Agent | الموديل | الدور | يستدعي sub-agents |
| --- | --- | --- | --- |
| `orchestrator` (الجلسة الرئيسية) | Opus 5.5 | يقسم المرحلة، يوزع التاسكات، يراجع ويدمج، يقفل المرحلة | كل اللي تحت |
| `architect` | Opus 5.5 | ADRs، schemas، interfaces للـdomain، مراجعة تصميم كل مرحلة | `explorer` |
| `backend-dev` | Sonnet 5.5 | NestJS modules، repositories، endpoints، migrations | `test-writer` |
| `cad-engineer` | Opus 5.5 (algorithms) / Sonnet 5.5 (plumbing) | Worker الكاد: ezdxf، تحويل DWG، ربط النصوص، tiles | `test-writer` |
| `finance-domain` | Opus 5.5 | الحصر، المستخلص، الفاتورة، snapshots، قواعد الأموال | `test-writer` |
| `web-dev` | Sonnet 5.5 | Next.js، MapLibre/deck.gl، شاشات الـPM والـQC | `ui-polisher`, `i18n` |
| `mobile-dev` | Sonnet 5.5 | Expo، MapLibre RN، Skia، الكاميرا | `ui-polisher`, `i18n` |
| `sync-engineer` | Opus 5.5 | WatermelonDB، outbox، idempotency، حل التعارضات | `test-writer` |
| `test-writer` | Sonnet 5.5 | unit/integration/E2E، golden files، property-based | — |
| `security-reviewer` | Opus 5.5 | RBAC/IDOR، رفع الملفات، OWASP، مراجعة قبل قفل كل مرحلة | — |
| `ui-polisher` | Sonnet 5.5 | Design tokens، RTL، accessibility | — |
| `i18n` | Haiku 5.5 | ملفات ar/en/fr | — |
| `explorer` | Haiku 5.5 | بحث read-only في الكود | — |
| `chore` | Haiku 5.5 | lint fixes، تحديث PROGRESS.md، scaffolding، CI yaml | — |

### طريقة التشغيل لكل مرحلة
1. `orchestrator` (Opus) يقرأ ROADMAP + PROGRESS ويكتب خطة المرحلة.
2. `architect` (Opus) يثبت الـcontracts في `packages/shared` (Zod schemas + types) — ده بيخلي الـagents التانية تشتغل بالتوازي من غير تعارض.
3. agents التنفيذ تشتغل **بالتوازي** كل واحد في worktree منفصل (`isolation: worktree`) على module مختلف.
4. `test-writer` يكتب الاختبارات بالتوازي مع التنفيذ (من الـcontract).
5. `security-reviewer` + `/code-review` قبل القفل.
6. `chore` (Haiku) يحدث PROGRESS.md ويشغل كل الاختبارات ويلخص.
7. وقفة لموافقتك قبل المرحلة اللي بعدها.

---

## 2. Clean Code والمعمارية (التفصيل في `docs/ARCHITECTURE.md`)

### المبادئ
- **Clean / Hexagonal Architecture** في الـAPI والـWorker: `domain` (entities + قواعد العمل، من غير أي framework) ← `application` (use cases) ← `infrastructure` (DB، S3، queues) ← `interface` (controllers/DTOs). الاعتماد دايمًا للداخل.
- **Modular Monolith** في NestJS: module لكل bounded context: `projects`, `work-orders`, `cad`, `boq`, `execution`, `asbuilt`, `qc`, `quantities`, `invoicing`, `changes`, `identity`. ممنوع module يقرأ جداول module تاني مباشرة — عن طريق service مُصدَّر أو domain events.
- **SOLID + DRY معقول:** use case واحد = class واحد = مسؤولية واحدة. Repository interfaces في الـdomain والتنفيذ في infrastructure.
- **Contract-first:** كل DTO/payload معرّف مرة واحدة بـZod في `packages/shared` ويتولد منه types للويب والموبايل والـAPI و OpenAPI.
- **Money:** value object `Money` (decimal / minor units) — ممنوع float. **Geometry:** value objects + كل تحويل إحداثيات في `packages/geo` / `workers/cad/geo.py` بس.
- **Event log immutable** + projections للحالة الحالية.
- **Frontend:** feature-sliced (`features/<name>/{components,hooks,api,model}`)، الـUI مكونات presentational، الـstate في hooks، الـserver state بـTanStack Query.
- **Conventions:** TypeScript strict، ESLint + Prettier، Ruff + mypy strict، Conventional Commits، أسماء واضحة بدل التعليقات، functions قصيرة، ممنوع `any`، ممنوع business logic في controllers أو components.

### هيكل الريبو
```
apps/api        NestJS — src/modules/<context>/{domain,application,infrastructure,interface}
apps/web        Next.js App Router — src/features/<feature>/
apps/mobile     Expo — src/features/<feature>/ , src/sync/
workers/cad     Python — cad_worker/{domain,application,adapters}
packages/shared Zod schemas + types + error codes
packages/geo    CRS/length/snap helpers (TS)
packages/ui-tokens design tokens مشتركة
infra/          docker-compose، terraform/IaC للسحابة لاحقًا
docs/           PLAN, ROADMAP, ARCHITECTURE, DECISIONS, PROGRESS
```

---

## 3. المراحل والتاسكات (مع الـAgent والموديل)
الصيغة: `تاسك — agent (موديل)`. التاسكات اللي في نفس المجموعة **[‖]** تشتغل بالتوازي.

### المرحلة 0: الأساس
- Contracts أولية + ADRs + هيكل الـmodules — architect (Opus)
- [‖] Monorepo pnpm/Turborepo + TS strict + ESLint/Prettier + Ruff/mypy + pre-commit — chore (Haiku)
- [‖] Docker Compose (PostGIS، Redis، MinIO، Martin، worker) — backend-dev (Sonnet)
- [‖] CI GitHub Actions (lint، typecheck، test، build) — chore (Haiku)
- Migrations (Drizzle + raw SQL PostGIS) + seed مشروع قليوب — backend-dev (Sonnet)
- Auth: JWT + refresh + RBAC على مستوى المشروع/المنطقة — backend-dev (Sonnet) + مراجعة security-reviewer (Opus)
- [‖] i18n + RTL ويب/موبايل — i18n (Haiku) + ui-polisher (Sonnet)
- **قبول:** `docker compose up` شغال، CI أخضر، login ويب + موبايل.

### بيئة Staging (قبل المرحلة 1)
- [x] Staging على سيرفر Hetzner المشترك (`49.13.167.124`) خلف الـCaddy الموجود: `bootstrap.sh` (أمر واحد من Hetzner Console) + `ftth-autodeploy` (pull كل دقيقتين، rollback تلقائي) + `publish-images.yml` (GHCR)، و`create-admin`، وrate limiting للدخول — ADR-010 و`docs/DEPLOY.md`.

### المرحلة 1: أوامر التكليف + استيراد الكاد والـMapping
- Domain للمشروع / أوامر التكليف (أكتر من أمر للمشروع، كل أمر ببنوده) — architect (Opus) ثم backend-dev (Sonnet)
- رفع DWG/DXF بـpresigned + job في BullMQ — backend-dev (Sonnet)
- Worker: DWG→DXF (ODA/LibreDWG)، ezdxf recover، استخراج layers/blocks/attributes/TEXT/MTEXT — cad-engineer (Sonnet)
- [‖] ربط النصوص بالعناصر (regex + أقرب مسافة + confidence) + اكتشاف EPSG — cad-engineer (Opus)
- [‖] تحويل SHX العربي (xarb.shx) — cad-engineer (Sonnet)
- [‖] شاشة Mapping + قائمة مراجعة النصوص — web-dev (Sonnet)
- features + design_revisions مقفولة + tiles (PMTiles) — cad-engineer (Sonnet)
- Tiles security: Martin serves only project-scoped function sources via a read-only DB role, behind Caddy forward_auth / signed tile URLs checked by the API; never auto-publish tables — architect (Opus) + security-reviewer (Opus)
- Revision matching وتقرير فروقات — cad-engineer (Opus)
- Golden-file tests على ملف قليوب — test-writer (Sonnet)
- **قبول:** قليوب ← ~25 مسار (~3,700 م)، 17 صندوق، 6 HHI، 4 Joint، UTM 36N في < دقيقة.

### المرحلة 2: العقد والـBOQ والقواعد
- CRUD تصنيفات/بنود + استيراد Excel للمقايسة لكل أمر تكليف — backend-dev (Sonnet) + web-dev (Sonnet) [‖]
- مطابقة بنود التصميم ببنود أمر التكليف (كود ثم وصف، والغير مؤكد للمراجعة) — architect (Opus) للقواعد، backend-dev (Sonnet) للتنفيذ
- أسعار العميل والمقاولين + `type_rules` — backend-dev (Sonnet)
- المناطق + التسكين — [‖] web-dev (Sonnet)
- عرض الكاد على الويب (MapLibre + deck.gl بألوان ACI) — web-dev (Sonnet)
- **قبول:** PM يجهز مشروع قليوب كامل من الواجهة.

### المرحلة 3: تطبيق المشرف (offline)
- تصميم المزامنة: outbox، `client_op_id`، قواعد التعارض — sync-engineer (Opus)
- [‖] شاشة الكاد (pan/zoom، crosshair، layers، نهار/ليل) — mobile-dev (Sonnet)
- [‖] أداة «تحديث» بالـ6 خطوات + الكمية المقترحة + تحذيرات GPS/التجاوز — mobile-dev (Sonnet)
- [‖] الكاميرا: صور إجبارية، GPS، watermark، ضغط، sha256 — mobile-dev (Sonnet)
- تنفيذ WatermelonDB + رفع صور قابل للاستكمال — sync-engineer (Sonnet)
- Endpoints idempotent للمزامنة — backend-dev (Sonnet)
- Sync tests (3 أجهزة، قطع نت، ساعة غلط) — test-writer (Sonnet)
- **قبول:** 20 تحديث في وضع الطيران تتزامن صح من غير تكرار.

### المرحلة 4: As-Built
- Geometry engine: snap، grips، حساب الطول — architect/cad-engineer (Opus) في `packages/geo`
- [‖] أدوات التحريك/تعديل المسار/رسم/INSERT/Label على الموبايل (Skia) — mobile-dev (Sonnet)
- [‖] عرض التصميم مقابل As-Built + اعتماد كل تعديل على الويب — web-dev (Sonnet)
- تصدير As-Built DXF (layers ASBUILT_EDITS/ADDED) — cad-engineer (Sonnet)
- Property-based tests للهندسة — test-writer (Sonnet)
- **قبول:** تعديل مسار يظهر بعد المزامنة، الطول في الحصر = طول As-Built المعتمد، DXF يفتح في AutoCAD.

### المرحلة 5: QC + الحصر + إدارة التغييرات + المستخلص
- Domain المالي: Money، الحصر view، السابق/الحالي/التراكمي، snapshot، الفصل بين المنفذ/المقبول/المعتمد، القبول الجزئي — finance-domain (Opus)
- [‖] صندوق QC (خريطة + قائمة + اختصارات) — web-dev (Sonnet)
- [‖] إدارة التغييرات (variation): الأثر الفني/المالي منفصل عن الاعتماد — backend-dev (Sonnet) على قواعد finance-domain
- [‖] Dashboard + KPIs (الإنجاز، المنفذ مقابل التصميم، الإنتاجية، نسبة الرفض) — web-dev (Sonnet)
- تصدير Excel (ExcelJS بمعادلات حقيقية — مع شرح لكل معادلة وKPI في شيت «شرح») + PDF — backend-dev (Sonnet)
- Unit tests مالية ≥ 90% + SQL assertions لسلامة البيانات — test-writer (Sonnet) + مراجعة finance-domain (Opus)
- **قبول:** مستخلص أسبوع قليوب = مجموع المعتمد × الأسعار بالظبط، وثابت بعد تعديل الأسعار، وكل سطر يفتح لحد الصورة.

### المرحلة 6: الاختبارات الشاملة
- E2E ويب (Playwright) + موبايل (Maestro) — test-writer (Sonnet)
- أداء (k6، Flashlight) — test-writer (Sonnet)
- أمان (ZAP، Semgrep، IDOR) — security-reviewer (Opus)
- Accessibility + RTL — ui-polisher (Sonnet)
- تلخيص التقارير في PROGRESS — chore (Haiku)

### المرحلة 7: الإطلاق على Hetzner
الاستضافة على **Hetzner Cloud** والدومين **`ftthtracker.projectflow.site`** (تفاصيل القرار في ADR-009).
- تجهيز السيرفرات: Hetzner Cloud VPS لـproduction (مثلًا CCX23) وVPS أصغر لـstaging (CPX21)، Firewall (22 من IPs محددة، 80/443 بس)، SSH keys، تحديثات أمنية تلقائية — backend-dev (Sonnet) + مراجعة security-reviewer (Opus)
- Docker Compose للإنتاج + **Caddy** reverse proxy بشهادات Let's Encrypt تلقائية — backend-dev (Sonnet)
- الدومينات (A records عند مسجّل `projectflow.site` على IP السيرفر):
  - `ftthtracker.projectflow.site` → الويب
  - `api.ftthtracker.projectflow.site` → الـAPI (والموبايل بيكلمه)
  - `tiles.ftthtracker.projectflow.site` → Martin/PMTiles
  - `staging.ftthtracker.projectflow.site` → بيئة الاختبار
- قاعدة البيانات: PostgreSQL/PostGIS في container على Hetzner Volume، مع نسخ احتياطي يومي + WAL archiving (WAL-G/pgBackRest) إلى Hetzner Object Storage لـpoint-in-time recovery، واختبار استرجاع شهري — backend-dev (Sonnet) + مراجعة architect (Opus)
- الملفات والصور: Hetzner Object Storage (S3-compatible) بدل MinIO، مع lifecycle وتشفير — backend-dev (Sonnet)
- CD: GitHub Actions يبني الـimages ويرفعها على GHCR، وdeploy على staging تلقائي وعلى production بموافقة يدوية — chore (Haiku) + مراجعة architect (Opus)
- EAS Build + توزيع داخلي + OTA، والموبايل مربوط بـ`api.ftthtracker.projectflow.site` — mobile-dev (Sonnet)
- مراقبة (Sentry، OpenTelemetry، uptime check على الدومين، تنبيه تأخر المزامنة) — chore (Haiku)
- أدلة تدريب بالعربي — i18n/chore (Haiku)
- Pilot قليوب أسبوعين ← تعميم.

---

## 4. الأسئلة المفتوحة (تفضل في ROADMAP قبل المرحلة 2 و5)
صيغ أوامر التكليف، أكواد B/P/U، BOQ الحقيقي، قالب مستخلص العميل، حد GPS، الضرائب والاحتجاز، هل التطبيق يصدر فاتورة رسمية ولا مستندات دعم فقط، هل العميل يدخل على النظام.
