# خطة بناء منصة متابعة تنفيذ FTTH على الكاد – لـClaude Code

Oct 6, 2026 · @Ai team

## الهدف والنطاق

نبني منصة ويب وتطبيق موبايل للمشرف، يسجل فيهما شغل اليوم مباشرة على رسمة الكاد، وتطلع منه نسخة As-Built والحصر والمستخلص تلقائيًا. نقطة البداية هي النموذج التفاعلي اللي اتعمل على رسمة القطاع الأول – قليوب.

**المستخدمين:**

| الدور | بيعمل إيه |
| --- | --- |
| مدير المشروع | يرفع الكاد، يعمل الـMapping، يدخل بنود العقد والأسعار، يقسم المناطق، يتابع التقارير والمستخلصات |
| المشرف (موبايل) | يسجل شغل اليوم على العناصر، يعدل على الرسمة As-Built، يصور، يشتغل offline |
| QC / الاستشاري | يراجع التحديثات ويعتمد أو يرفض بسبب |
| المقاول الباطن (اختياري) | يشوف شغله ومستخلصه بس |
| Admin | المستخدمين، الصلاحيات، المشاريع |

**خارج النطاق في الإصدار الأول:** تكامل مع ERP، وتصميم شبكة جديد من الصفر، وحساب link budget، ومرحلة السيرفي الدقيق للعناصر اللي اتغير مكانها.

**جوه النطاق:** متابعة الشغل اليومي (Work Progress) على الكاد، وتعديل As-Built، وحصر الأعمال والـMaterial، والمستخلص والفاتورة (تفصيلها في قسم «الفاتورة والمستخلص»).

**طريقة الاستخدام مع Claude Code:**

1. صدّر الدوك ده Markdown، واحفظه في الريبو باسم `docs/PLAN.md`.
2. انسخ قسم «البرومت الافتتاحي» في آخر الدوك، والصقه كأول رسالة لـClaude Code.
3. اشتغل مرحلة مرحلة. Claude Code يخلص تاسكات المرحلة، ويشغّل اختباراتها، ويحدّث `docs/PROGRESS.md`، ويستنى موافقتك قبل المرحلة اللي بعدها.
4. حط ملفات DXF/DWG حقيقية في `fixtures/cad/`، من غير بيانات حساسة، علشان الاختبارات تشتغل على رسومات حقيقية.

## الـWorkflow الكامل

كل كمية في المستخلص لازم ترجع لتحديث معتمد على عنصر في الرسمة، ومعاه صوره والـGPS بتاعه. ده المبدأ اللي بيتبني عليه النظام كله.

&#91;embedded content: الـWorkflow · 3 مراحل، قرار اعتماد واحد\]

التحديث المرفوض بيرجع للمشرف بسببه، والمعتمد بس هو اللي يدخل الحصر والمستخلص.

**أولًا: الإعداد (مدير المشروع، مرة لكل مشروع)**

1. ينشئ المشروع والمناطق (Sector / Cluster) ونظام الإحداثيات (مثلًا UTM 36N).
2. يرفع DWG أو DXF. السيرفر يحوله ويقرأ الـlayers والـblocks والنصوص.
3. **شاشة الـMapping:** يربط كل layer أو block بنوع عنصر (مسار، صندوق، HHI، Joint، MH قائم، خلفية). النظام يقترح الربط تلقائيًا من الأسماء، ومدير المشروع يأكد.
4. **ربط النصوص بالعناصر:** النصوص الحرة (زي `F 36 C` و`1X2Way16/12` و`150.0M`) بتتربط بأقرب عنصر جغرافيًا بقواعد regex. أي ربط مش مؤكد يظهر في قائمة مراجعة.
5. يدخل بنود العقد مصنفة: أعمال ومهمات، ولكل بند كود ووحدة وسعر للعميل وأسعار للمقاولين.
6. يربط كل نوع عنصر بالتصنيفات والبنود المسموحة عليه، والصور المطلوبة لكل نشاط.
7. يسكّن المشرفين والمقاولين على المناطق، وينشر نسخة التصميم (Design Rev) مقفولة.

**ثانيًا: التنفيذ اليومي (المشرف، موبايل، offline)**

1. يفتح المنطقة. الرسمة نازلة على الجهاز كـvector tiles.
2. أداة «تحديث»: يدوس على العنصر، يختار النشاط، تظهر بنود العقد الخاصة بيه بس، يحدد الكميات ويختار المهمات المركّبة.
3. لو التنفيذ مختلف عن التصميم: يحرّك العنصر، أو يعدل نقاط المسار، أو يرسم مسار جديد، أو يضيف رمز، أو يعدل الـLabel. كل ده بيتسجل في نسخة As-Built بس.
4. يصور الصور الإجبارية، وكل صورة عليها GPS ووقت وwatermark.
5. يحفظ. التحديث يتخزن محليًا ويتزامن أول ما النت يرجع.

**ثالثًا: الاعتماد (QC)**

1. يشوف التحديثات المعلقة على الخريطة وفي قائمة.
2. يعتمد، أو يرفض بسبب يرجع للمشرف، أو يطلب تعديل كمية.
3. تعديلات الـAs-Built على الشكل ليها اعتماد منفصل.

**رابعًا: الحصر والمستخلص**

1. الحصر = مجموع الكميات المعتمدة لكل بند، بفلاتر المنطقة والمقاول والمشرف والفترة.
2. مستخلص العميل = الحصر × أسعار العقد، ناقص المستخلصات السابقة.
3. مستخلص المقاول الباطن = حصره × أسعاره.
4. يتقفل المستخلص كـsnapshot ثابت (رقم، فترة، PDF وExcel)، وأي تحديث متأخر يروح للمستخلص اللي بعده.
5. تصدير As-Built كـDXF، والتعديلات عليها لون وlayer منفصلين.

## المعمارية والمتطلبات التكنولوجية

المعمارية Monorepo بـTypeScript في الويب والموبايل والـAPI، ومعاها Worker بـPython مخصص للكاد. السبب إن أحسن مكتبات قراءة DWG/DXF موجودة في Python.

&#91;embedded content: المعمارية · 2 عملاء، API، Worker، 3 مخازن\]

الموبايل بيرفع الصور مباشرة لـS3 بـpresigned URL من الـAPI، والـWorker بيسحب ملفات الكاد من الطابور ويكتب الـfeatures في PostGIS والـtiles في S3.

| الطبقة | الاختيار | ليه |
| --- | --- | --- |
| Monorepo | pnpm workspaces + Turborepo | أنواع مشتركة بين الويب والموبايل والـAPI |
| الموبايل | React Native (Expo, dev client) + TypeScript | كود مشترك مع الويب، كاميرا وGPS وbackground sync |
| رسم الكاد على الموبايل | MapLibre React Native بإحداثيات محلية (CRS مخصص) + طبقة Skia للتعديل والـgrips | vector tiles سريعة، وتحكم كامل في الـsnap والسحب |
| Offline | WatermelonDB (SQLite) + outbox queue | تخزين محلي ومزامنة بالتغييرات فقط |
| الويب | Next.js (App Router) + React + Tailwind + shadcn/ui | لوحات مدير المشروع والـQC والتقارير |
| رسم الكاد على الويب | MapLibre GL JS + deck.gl للطبقات التفاعلية | آلاف العناصر بسلاسة |
| الـAPI | NestJS (Node 22) + REST + OpenAPI | موديولات واضحة، وvalidation بـZod |
| قاعدة البيانات | PostgreSQL 16 + PostGIS 3 | أطوال ومسافات وsnap جغرافي داخل الـDB |
| الـWorker | Python 3.12 + ezdxf + LibreDWG (dwg2dxf) أو ODA File Converter + pyproj + shapely | تحويل DWG وقراءة layers وblocks ونصوص وتحويل إحداثيات |
| Tiles | Martin (من PostGIS) أو tippecanoe → PMTiles | تحميل الرسمة على الموبايل للعمل offline |
| الطوابير | Redis + BullMQ | معالجة الكاد والتقارير في الخلفية |
| الملفات والصور | S3-compatible (MinIO محليًا) + presigned uploads | الصور تترفع مباشرة من الموبايل |
| التقارير | ExcelJS للمستخلص، Playwright HTML→PDF | قوالب مستخلص قابلة للتعديل |
| Auth | JWT + refresh tokens، RBAC على مستوى المشروع والمنطقة | المشرف يشوف منطقته بس |
| i18n | عربي (RTL) وإنجليزي وفرنساوي | فرق في مصر ومدغشقر |
| DevOps | Docker Compose محليًا، GitHub Actions، Sentry، OpenTelemetry |  |

**قرارات معمارية لازم Claude Code يلتزم بيها:**

- **الإحداثيات:** التخزين الأصلي بنظام المشروع (مثلًا EPSG:32636)، ونسخة WGS84 للخرائط والـGPS. كل التحويلات في مكان واحد.
- **التصميم مقفول:** الـDesign Revision مبيتعدلش أبدًا. الـAs-Built عبارة عن features بنفس الـIDs، بالإضافة لـfeatures جديدة عليها علامة `added`.
- **Event log:** كل تحديث أو تعديل بيتسجل كـevent غير قابل للتعديل، والحالة الحالية projection منه. ده بيضمن الـaudit وحل التعارضات.
- **المزامنة:** كل عملية من الموبايل ليها `client_op_id` (UUID)، فالسيرفر بيتجاهل التكرار (idempotent). التعارض على نفس العنصر يتحل بـlast-writer-wins للشكل، وبجمع الكميات للتحديثات، والتعارض الحقيقي يروح للـQC.
- **المستخلص snapshot:** بعد ما يتقفل مبيتغيرش، حتى لو أسعار العقد اتعدلت.

## نموذج البيانات

النموذج كله مبني على 4 مجموعات: الرسمة (Design و As-Built)، والعقد (البنود والقواعد)، والتنفيذ (التحديثات والصور)، والمال (الحصر والمستخلصات). وأي جدول عليه `project_id` وصلاحيات.

| الجدول | أهم الحقول | ملاحظات |
| --- | --- | --- |
| `projects` | id, name, client, crs\_epsg, currency, locale | مثلًا EPSG:32636 |
| `zones` | id, project\_id, name, geom (polygon), parent\_id | Sector › Cluster |
| `cad_files` | id, project\_id, original\_name, storage\_key, status, converter, log | DWG / DXF أصلي |
| `cad_layers` | id, cad\_file\_id, name, aci\_color, entity\_counts (json), mapped\_type, role | role: network / background / text / ignore |
| `design_revisions` | id, project\_id, cad\_file\_id, rev\_no, published\_at, locked | نسخة مقفولة |
| `features` | id (ثابت)، project\_id, design\_rev\_id, feature\_type, code, zone\_id, design\_geom, design\_length\_m, attrs (json), source\_handle | العنصر الأصلي من الرسمة |
| `asbuilt_features` | feature\_id, geom, length\_m, label, status, added, edited, version | الحالة الحالية As-Built |
| `text_links` | id, feature\_id, cad\_text, kind (cable/duct/length/box\_id…), distance\_m, confidence, confirmed\_by | ربط النصوص الحرة |
| `feature_types` | id, key (route/box/hhi/joint/mh), geometry\_kind, icon, color |  |
| `boq_categories` | id, project\_id, name, sort | حفر، دكت، كابلات، لحام… |
| `boq_items` | id, category\_id, code, name\_ar/en/fr, unit, kind (work/material), client\_price |  |
| `contractor_prices` | boq\_item\_id, contractor\_id, price |  |
| `type_rules` | feature\_type\_id, category\_id, allowed\_item\_ids, default\_qty\_rule, required\_photos (json) | مين يظهر لمين، والكمية المقترحة |
| `assignments` | user\_id, zone\_id, contractor\_id, role | تسكين |
| `updates` | id, client\_op\_id (unique), feature\_id, activity\_category\_id, user\_id, contractor\_id, captured\_at, gps (point), gps\_accuracy\_m, status (pending/approved/rejected), reviewer\_id, reason | التحديث اليومي |
| `update_lines` | id, update\_id, boq\_item\_id, qty, unit | أعمال ومهمات |
| `geometry_edits` | id, client\_op\_id, feature\_id, op (move/vertex/add/delete/label), before, after, user\_id, status | تعديلات الـAs-Built |
| `photos` | id, update\_id, requirement\_key, storage\_key, sha256, gps, taken\_at, device\_id |  |
| `events` | id, project\_id, entity, entity\_id, type, payload, actor\_id, at | event log غير قابل للتعديل |
| `invoices` | id, project\_id, party (client/contractor), contractor\_id, period\_from, period\_to, no, status, totals (json), locked\_at |  |
| `invoice_lines` | invoice\_id, boq\_item\_id, prev\_qty, period\_qty, cum\_qty, price, amount | snapshot |

**قواعد أساسية:**

- `features.id` مبيتغيرش أبدًا بين revisions التصميم. ولو اتعمل revision جديد، الـWorker يعمل matching بالموقع والنوع والكود، والتعارضات تتعرض على مدير المشروع.
- طول الـAs-Built بيتحسب في PostGIS بـ`ST_Length` على الإحداثيات الأصلية (متري)، مش على WGS84.
- الحصر view مبني على `update_lines` المعتمدة بس.

## مبادئ UI/UX

المشرف في الشارع، تحت الشمس، بإيد واحدة، والنت ضعيف. أي تحديث لازم يخلص في أقل من 30 ثانية لعنصر عادي. والنموذج التفاعلي بتاع قليوب هو المرجع البصري.

**الموبايل (المشرف):**

- **شاشة الكاد هي الشاشة الرئيسية:** خلفية Model Space غامقة، ألوان الـlayers الأصلية (ACI)، crosshair، سطر Command، وإحداثيات E/N.
- **شريط أدوات ثابت تحت:** تحديث (الافتراضي، بلون مميز)، تحديد، تحريك، تعديل مسار، رسم مسار، إضافة رمز، Label. وفوق: تراجع، Layers، حالة المزامنة.
- **التحديث في 6 خطوات ثابتة:** النشاط › بنود الأعمال › المهمات › الـLabel والموقع › الصور › مراجعة. مع شريط تقدم، والكمية مقترحة من طول المسار المتبقي، وكل خطوة ليها رجوع.
- **أهداف لمس 44px كحد أدنى،** وstepper بزرارين بدل الكيبورد للأرقام، ومفيش typing إلا في الـLabel والملاحظات.
- **تباين عالي في الشمس:** وضع «نهار» بخلفية فاتحة للكاد زي ما هو.
- **حالة offline واضحة دايمًا:** عدد العمليات اللي لسه متزامنتش، وآخر مزامنة، وتحذير لو الصور كبرت عن المساحة.
- **منع الأخطاء مش رفضها:** تحذير لو الكمية أكبر من المتبقي، وتحذير لو GPS المشرف بعيد عن العنصر بأكتر من 50 م (قابل للضبط)، والحفظ مقفول لحد ما الصور الإجبارية تكمل.
- **Snap واضح:** مربع أصفر على النقطة، وgrips زرقا للمسار المختار، وتراجع غير محدود في الجلسة.
- **العربي RTL كامل،** والأكواد والأرقام والإحداثيات LTR ثابتة.

**الويب (مدير المشروع والـQC):**

- **Layout:** sidebar فيه (المشاريع، الرسمة، الـMapping، العقد، التحديثات، الحصر، المستخلصات، المستخدمين)، وفي النص الخريطة أو الجدول.
- **شاشة الـMapping:** قائمة الـlayers بلونها وعدد العناصر، ونوع مقترح، ومعاينة على الخريطة لما تمرر عليها. وجنبها قائمة «ربط النصوص» مرتبة من الأقل ثقة للأعلى.
- **صندوق QC:** خريطة + قائمة جنب بعض، الضغط على تحديث يعمل zoom للعنصر ويعرض الصور ومقارنة قبل/بعد للشكل. وفيه اختصارات كيبورد (A اعتماد، R رفض، J/K تنقل).
- **الحصر:** جدول pivot (بند × منطقة/مقاول/فترة)، وكل رقم بيفتح التحديثات اللي طلّعته.
- **المستخلص:** معاينة بالشكل النهائي قبل القفل، وبعد القفل مفيش تعديل.
- **Design System موحد:** tokens للألوان (ألوان الحالة: لم يبدأ، جاري، منفذ، معتمد، مرفوض) مشتركة بين الويب والموبايل، وأيقونات خطية. ولون الحالة مايكونش لوحده مصدر المعنى: معاه شكل أو نص.

## المراحل والتاسكات

فيه 6 مراحل بناء، بعدهم الاختبارات الشاملة والإطلاق. كل مرحلة ليها «معيار القبول» لازم يتحقق، وClaude Code يقف ويستنى موافقتك قبل ما يبدأ اللي بعدها. التاسكات مكتوبة كـcheckboxes علشان تعلّم عليها وانت ماشي.

### المرحلة 0: الأساس

- [ ] Monorepo: `apps/web` و`apps/mobile` و`apps/api` و`workers/cad` و`packages/shared` (types وZod schemas) و`packages/ui-tokens`.
- [ ] Docker Compose: Postgres+PostGIS، وRedis، وMinIO، وMartin، والـWorker.
- [ ] ESLint وPrettier وTypeScript strict، وRuff وmypy للـPython، وpre-commit hooks.
- [ ] CI على GitHub Actions: lint، type-check، unit tests، build لكل app.
- [ ] Migrations (Drizzle أو Prisma مع raw SQL للـPostGIS)، وseed بمشروع تجريبي.
- [ ] Auth: تسجيل دخول، refresh، أدوار (admin, pm, supervisor, qc, contractor)، وصلاحيات على مستوى المنطقة.
- [ ] i18n (ar/en/fr) وRTL في الويب والموبايل.
- [ ] `docs/PROGRESS.md` و`docs/DECISIONS.md` (ADR مختصر لكل قرار).

**معيار القبول:** `docker compose up` يشغّل كل حاجة، والـCI أخضر، وتسجيل الدخول شغال على الويب والموبايل.

### المرحلة 1: استيراد الكاد والـMapping

- [ ] رفع DWG/DXF (حتى 100 MB) مع presigned upload، وتسجيل job.
- [ ] Worker: تحويل DWG→DXF (LibreDWG، وODA كبديل)، والقراءة بـezdxf في وضع recover، وتسجيل التحذيرات.
- [ ] استخراج: layers (اسم، لون ACI، عدد كل نوع)، وblocks وinserts وattributes، وTEXT/MTEXT بالموقع والارتفاع والدوران، والـpolylines والـlines والـarcs.
- [ ] التعامل مع نصوص الخطوط العربية القديمة (SHX زي `xarb.shx`): جدول تحويل حروف قابل للتوسيع، وعلامة «غير مقروء» لو فشل.
- [ ] اكتشاف نظام الإحداثيات من الـextents واقتراح EPSG، ومدير المشروع يأكد.
- [ ] شاشة Mapping في الويب: layer/block → نوع عنصر، مع اقتراح تلقائي من الاسم (`N_DUC_CBL`→route، `sub`→box، `NEW-HHI`→hhi، `JONT 144`→joint).
- [ ] ربط النصوص بالعناصر: أقرب مسافة لكل نص، وregex لكل نوع (`F \d+ C`، `\d+X\dWay`، `[\d.]+\s*[mM]`، `\d-\d`، `\d+[BPU]`)، ودرجة ثقة، وقائمة مراجعة.
- [ ] إنشاء `features` و`design_revisions` ونشر الـrevision مقفول.
- [ ] توليد tiles: خلفية (مباني وطرق ونصوص) كـPMTiles، والشبكة كـGeoJSON أو MVT.
- [ ] Revision جديد للتصميم: matching بالـfeatures القديمة، وتقرير فروقات.

**معيار القبول:** ملف `General_القطاع_الاول_قليوب.dwg` يتحول ويطلع منه 25 مسار تقريبًا (حوالي 3,700 م)، و17 صندوق، و6 HHI، و4 Joint، وإحداثيات UTM 36N، في أقل من دقيقة.

### المرحلة 2: العقد والقواعد (ويب)

- [ ] CRUD للتصنيفات والبنود (أعمال ومهمات) مع استيراد من Excel للـBOQ.
- [ ] أسعار العميل وأسعار كل مقاول.
- [ ] `type_rules`: لكل نوع عنصر التصنيفات المسموحة، والبنود، والكمية المقترحة (متبقي الطول، 1، عدد من الـlabel)، والصور الإجبارية.
- [ ] المناطق: رسم polygon أو استيرادها من layer، وتسكين المشرفين والمقاولين.
- [ ] عرض الرسمة على الويب بشكل CAD (نفس ألوان الـlayers والنصوص)، مع إمكانية إخفاء وإظهار الـlayers.

**معيار القبول:** مدير المشروع يقدر يجهز مشروع قليوب كامل من غير ما يلمس قاعدة البيانات.

### المرحلة 3: تطبيق المشرف

- [ ] تسجيل الدخول، واختيار المشروع والمنطقة، وتحميل الـtiles والـfeatures والقواعد والبنود للعمل offline.
- [ ] شاشة الكاد: pan وpinch-zoom وrotate مقفول، وcrosshair، وإحداثيات، وLayers، ووضع نهار/ليل، وتمييز التصميم مقابل الـAs-Built.
- [ ] أداة «تحديث» بالـ6 خطوات، والكميات المقترحة، وتحذيرات تجاوز التصميم، وتحذير بُعد الـGPS.
- [ ] الكاميرا: صور إجبارية حسب النشاط، وGPS ووقت وwatermark، وضغط الصورة (حوالي 1600px، JPEG 80%)، وsha256.
- [ ] بطاقة العنصر: بيانات الرسمة، والبنود المنفذة، والمهمات، والصور، وسجل التحديثات، والحالة.
- [ ] Outbox ومزامنة: retry مع backoff، ورفع الصور منفصل وقابل للاستكمال، وشاشة «في الانتظار».
- [ ] إشعارات: رفض تحديث، أو طلب تعديل.

**معيار القبول:** مشرف بموبايل Android متوسط (4 GB RAM) يسجل 20 تحديث وهو في وضع الطيران، وبعدين يتزامنوا كلهم صح من غير تكرار.

### المرحلة 4: تعديل الرسمة As-Built

- [ ] تحريك رمز بالسحب مع snap (endpoint، vertex، رمز) وهامش 14px.
- [ ] تعديل مسار: grips للنقاط، وgrip نص الضلع لإضافة نقطة، وحذف نقطة، وطول بيتحسب وانت بتسحب.
- [ ] رسم مسار جديد (PLINE) وإضافة رمز (INSERT) من الأنواع المسموحة.
- [ ] تعديل الـLabel (DDEDIT) وعرضه على الرسمة بلون الـAs-Built.
- [ ] تراجع وإعادة في الجلسة، وكل عملية تتحول لـ`geometry_edits` عليها `client_op_id`.
- [ ] على الويب: عرض التصميم والـAs-Built فوق بعض، والأصلي متقطع تحت المعدّل، واعتماد أو رفض كل تعديل.
- [ ] تصدير As-Built DXF: layers أصلية + `ASBUILT_EDITS` + `ASBUILT_ADDED` + نصوص الحالة.

**معيار القبول:** تعديل مسار على الموبايل يظهر على الويب بعد المزامنة، وطوله في الحصر هو طول الـAs-Built المعتمد، والـDXF المصدّر يفتح في AutoCAD سليم.

### المرحلة 5: الاعتماد والحصر والمستخلص

- [ ] صندوق QC (خريطة + قائمة)، واعتماد جماعي، ورفض بسبب، وطلب تعديل كمية.
- [ ] Dashboard: نسبة الإنجاز لكل منطقة ومقاول، والأطوال المنفذة مقابل التصميم، وإنتاجية المشرفين اليومية.
- [ ] الحصر pivot مع drill-down للتحديثات والصور.
- [ ] مستخلص العميل ومستخلص المقاول: الفترة، والسابق والحالي والتراكمي، والقفل كـsnapshot، وتصدير Excel وPDF بقالب قابل للتعديل.
- [ ] تقرير فروقات (مصمم مقابل منفذ) للـvariation orders.
- [ ] تقرير يومي أوتوماتيك لمدير المشروع.

**معيار القبول:** مستخلص قليوب لفترة أسبوع يطلع أرقامه مطابقة لمجموع التحديثات المعتمدة بالظبط، ويتقفل ومايتغيرش بعد تعديل الأسعار.

### الفاتورة والمستخلص (تفصيل المرحلة 5)

الفاتورة والمستخلص جزء أساسي من المنصة، مش إضافة. الحصر (أعمال وMaterial) بيتبني من أول يوم بحيث الفاتورة تطلع منه مباشرة، من غير إعادة إدخال أي كمية.

- [ ] **الحصر مرتبط بالمقايسة (العقد):** كل سطر في الحصر والمستخلص لازم يكون بند من المقايسة المعتمدة (كود، وحدة، كمية تعاقد، سعر). ماينفعش تسجيل كمية على بند مش موجود فيها. الحصر بيعرض لكل بند: كمية التعاقد، السابق، الحالي، التراكمي، المتبقي، ونسبة الإنجاز.
- [ ] **تجاوز كمية التعاقد:** تحذير للمشرف عند الحفظ، وتحذير لـQC عند الاعتماد. وأي شغل خارج المقايسة يتسجل كـ«أمر تغيير» (variation) بدون سعر، وما يدخلش المستخلص إلا بعد اعتماده وإضافته للمقايسة.
- [ ] **حصر الأعمال:** مجموع كميات `update_lines` المعتمدة لكل بند، بفلاتر المنطقة والمقاول والمشرف والفترة.
- [ ] **حصر الـMaterial:** كميات الخامات (مواسير، كابلات، بوكسات، جوينت، جارد) المصروفة أو المركّبة لكل عنصر ومنطقة، ومقارنتها بالتصميم.
- [ ] **مستخلص العميل:** كمية سابقة + حالية = تراكمية × سعر العقد، مع خصم المستخلصات السابقة.
- [ ] **مستخلص المقاول الباطن:** نفس الحصر بأسعار المقاول.
- [ ] **الفاتورة:** تتولد من مستخلص مقفول (رقم، فترة، ضرائب وخصومات قابلة للضبط حسب العميل)، وتتصدّر PDF وExcel.
- [ ] **ربط كل سطر بمصدره:** كل رقم في الفاتورة يفتح التحديثات والصور وGPS اللي طلّعته.
- [ ] **القفل:** المستخلص بعد القفل snapshot ثابت، وأي تحديث متأخر يروح للمستخلص اللي بعده.
- [ ] **جاهزية للتكامل:** API وتصدير منظم (JSON وExcel) علشان الفاتورة تتنقل لاحقًا لنظام محاسبة أو SaaS تاني.

**معيار القبول:** فاتورة قليوب لفترة أسبوع تطلع من الحصر مباشرة، وإجماليها يساوي مجموع التحديثات المعتمدة × الأسعار بالظبط، وتفتح كل سطر لحد صورته.

### ملحوظة عن النطاق: الربط الجغرافي والسيرفي

- **الربط بالـGIS (Georeferencing):** لو الكاد غير مربوط، مدير المشروع يربطه بنقطتين أو 3 معروفين، أو من الـEPSG لو الرسمة بإحداثيات UTM. بعد الربط، صور وGPS كل تحديث تظهر مباشرة على الخريطة وعلى الكاد.
- **مرحلة السيرفي (لاحقًا، خارج الإصدار الأول):** لو عنصر اتغير مكانه فعليًا، يتعمل له Survey منفصل بقياسات دقيقة، على نفس فكرة سيرفي المباني. الإصدار الأول يكتفي بـAs-Built اللي يعدله المشرف على الرسمة.

## المرحلة 6: الاختبارات من كل الزوايا

الاختبارات بتتكتب مع كل مرحلة، مش في الآخر بس. المرحلة 6 بتجمع الاختبارات الشاملة، وبتقفل الفجوات قبل الإطلاق. والهدف إن تغطية الـunit tests للمنطق المالي والهندسي تكون 90% أو أكتر.

| الزاوية | إيه اللي يتختبر | الأدوات | معيار النجاح |
| --- | --- | --- | --- |
| Unit | حساب الأطوال، الـsnap، ربط النصوص بالـregex، قواعد الكميات المقترحة، حساب المستخلص (سابق/حالي/تراكمي) | Vitest، pytest | تغطية 90% أو أكتر للمنطق المالي والهندسي |
| CAD golden files | ملف قليوب + 5 ملفات متنوعة (DXF قديم، MTEXT، blocks بـattributes، ملف تالف، UTM مختلف) | pytest + snapshots | نفس عدد العناصر والأطوال كل مرة (تفاوت 0.01 م) |
| Property-based | geometry: تحريك وإضافة وحذف نقط عشوائي، الطول دايمًا موجب ومتسق | fast-check، hypothesis | صفر حالات فاشلة على 10,000 تجربة |
| Integration / API | كل endpoint بصلاحياته، والـidempotency بـ`client_op_id`، والـPostGIS queries | Supertest + Testcontainers | كل أدوار الـRBAC متغطية |
| Sync و offline | 3 أجهزة بتعدل نفس المنطقة offline وبعدين بتتزامن، وقطع النت في نص رفع صورة، والساعة متلخبطة على الجهاز | Detox + network shaping | مفيش تكرار، ولا فقد، والتعارضات بتروح للـQC |
| E2E ويب | رفع كاد › Mapping › عقد › تحديث › اعتماد › مستخلص | Playwright | السيناريو الكامل أخضر على Chrome وSafari |
| E2E موبايل | تحديث كامل بالصور، وتعديل مسار، ورسم مسار، ورفض ورجوع | Maestro أو Detox على Android وiOS | أخضر على Android 10 أو أحدث، وiOS 16 أو أحدث |
| الأداء | 50,000 مبنى + 2,000 مسار على الموبايل، و100 مستخدم متزامن على الـAPI، ومستخلص فيه 5,000 سطر | k6، Flashlight، React Profiler | 50 fps أو أكتر في الـpan، وp95 للـAPI أقل من 300 ms، والمستخلص أقل من 10 ثواني |
| الأمان | OWASP Top 10، وIDOR (مشرف يحاول يشوف منطقة غيره)، ورفع ملفات خبيثة، وانتهاء الـtokens | ZAP، Semgrep، npm audit، pip-audit | صفر ثغرات high أو critical |
| سلامة البيانات | الحصر = مجموع `update_lines` المعتمدة، والمستخلص المقفول مبيتغيرش، والـevent log كامل | SQL assertions في CI | 100% تطابق |
| UX وقابلية الاستخدام | 5 مشرفين حقيقيين في الموقع، كل واحد يسجل 10 تحديثات | تسجيل شاشة + وقت كل مهمة | التحديث العادي أقل من 30 ثانية، وصفر أخطاء حرجة |
| Accessibility | التباين، وأهداف اللمس، وقارئ الشاشة، وRTL | axe، فحص يدوي | WCAG 2.1 AA في الويب |
| الأجهزة والظروف | GPS ضعيف، وشمس مباشرة، وبطارية أقل من 15%، وتخزين شبه مليان | فحص يدوي بقائمة | التطبيق مايفقدش أي بيانات |
| التوافق مع CAD | فتح الـAs-Built DXF المصدّر في AutoCAD وBricsCAD وQGIS | فحص يدوي + ezdxf audit | يفتح من غير أخطاء، والـlayers سليمة |
| UAT | Pilot على القطاع الأول – قليوب لمدة أسبوعين | قائمة قبول موقعة | مدير المشروع والـQC يوقعوا |

**قواعد لـClaude Code في الاختبارات:**

- أي bug يتصلّح لازم يتكتبله اختبار الأول يفشل، وبعدين يتصلّح.
- ملفات الكاد الحقيقية في `fixtures/cad/` ونتائجها المتوقعة في `fixtures/cad/expected/*.json`.
- ممنوع mock لـPostGIS في اختبارات الـintegration. استخدم Testcontainers.
- تقرير اختبارات في آخر كل مرحلة جوه `docs/PROGRESS.md`.

## المرحلة 7: الإطلاق والتشغيل

الإطلاق بيبدأ بـpilot على منطقة واحدة، وبعده يتعمم على باقي المناطق.

- [ ] بيئات: dev، staging، production، وقاعدة بيانات منفصلة لكل بيئة.
- [ ] استضافة: VPS أو Cloud بـDocker، وPostgres مُدار عليه backups يومية وpoint-in-time recovery، وS3 للصور مع lifecycle.
- [ ] الموبايل: EAS Build، وتوزيع داخلي (Firebase App Distribution أو TestFlight)، وOTA updates للـJS.
- [ ] مراقبة: Sentry للويب والموبايل والـAPI، وطابور الـWorker (عدد الـjobs الفاشلة)، وتنبيه لو مزامنة جهاز اتأخرت أكتر من 24 ساعة.
- [ ] أمان: HTTPS، وتشفير الصور at-rest، وrate limiting، وسجل دخول، وتشفير التخزين المحلي على الموبايل.
- [ ] تدريب: فيديو 5 دقايق للمشرف، ودليل PDF لمدير المشروع والـQC بالعربي.
- [ ] Pilot: القطاع الأول – قليوب، مع 2 مشرف و1 QC لمدة أسبوعين، وجمع feedback يومي.
- [ ] تعميم: باقي المناطق، وبعدها multi-tenancy لو هتتباع كـSaaS لمقاولين تانيين.

**مؤشرات النجاح بعد الـpilot:** نسبة التحديثات اللي اتسجلت من الموقع نفسه (مش من المكتب)، ومتوسط وقت التحديث، ونسبة الرفض من الـQC، والوقت من آخر يوم في الفترة لحد إصدار المستخلص.

## البرومت الافتتاحي لـClaude Code

انسخ البرومت ده كما هو، والصقه كأول رسالة في Claude Code جوه ريبو فاضي فيه `docs/PLAN.md`. البرومت بالإنجليزي علشان المصطلحات التقنية تبقى دقيقة، والواجهة نفسها هتطلع عربي.

```markdown
You are the lead engineer building "FTTH Site Tracker": a web platform + mobile app where field supervisors log daily execution work directly on the project's CAD drawing, edit an As-Built copy of it, and the system produces quantity take-offs and payment certificates (مستخلصات) automatically.

Act as a senior systems architect, senior full-stack engineer, and senior UI/UX designer at once.

## Source of truth
- Read docs/PLAN.md fully before writing any code. It contains the workflow, architecture, data model, UI/UX principles, phases, tasks and acceptance criteria.
- fixtures/cad/General_القطاع_الاول_قليوب.dwg is the reference drawing (AutoCAD 2018, UTM zone 36N). Known content: layer N_DUC_CBL = new duct+cable routes (~25 polylines, ~3,700 m), block "sub" = distribution boxes (17, labelled 1-1…3-3 with B/P/U codes nearby), text "NEW-HHI" on layer RRR = new handholes (6), block "JONT 144" = joints (4), CAP F36 / CAP F144 = free-text cable/duct/length labels, layer tx = Arabic street names in a legacy SHX font (xarb.shx).
- docs/prototype/ contains the interactive prototype (screens, tools, flows). Match its interaction model.

## Non-negotiable rules
1. Work phase by phase (Phase 0 → 7). Do not start a phase until I approve the previous one.
2. At the start of each phase: post a short plan (tasks, files you will touch, risks). At the end: run all tests, update docs/PROGRESS.md (done / not done / test report / known issues), then stop and ask for approval.
3. Design revisions are immutable. As-Built is a separate layer of state keyed by the same feature IDs. Every change is an immutable event.
4. Every mobile write carries a client_op_id (UUID) and the server is idempotent.
5. Store geometry in the project CRS (metric) and compute lengths there; use WGS84 only for display/GPS.
6. Money: integer minor units or decimal, never float. Invoices are frozen snapshots.
7. Arabic RTL first, plus English and French. Codes, numbers and coordinates stay LTR.
8. Tests are part of every task. A bug fix starts with a failing test. Never mock PostGIS in integration tests.
9. Record each significant technical decision as a short ADR in docs/DECISIONS.md.
10. If something in the plan is ambiguous or wrong, say so and propose an alternative before coding. Never invent business rules (prices, units, BOQ codes); ask.

## Stack
pnpm + Turborepo monorepo · apps/api: NestJS + PostgreSQL 16/PostGIS 3 + Redis/BullMQ · workers/cad: Python 3.12, ezdxf, LibreDWG/ODA converter, pyproj, shapely · apps/web: Next.js + Tailwind + shadcn/ui + MapLibre GL + deck.gl · apps/mobile: Expo (dev client) React Native + MapLibre RN + Skia + WatermelonDB · S3/MinIO · Martin/PMTiles · Docker Compose · GitHub Actions.

## Start now
Begin with Phase 0 only. First reply with: (a) the repo tree you will create, (b) the Phase 0 task list with estimates, (c) any questions. Then wait for my go.
```

**أوامر متابعة مفيدة أثناء الشغل:**

- «اعرض حالة المرحلة الحالية من `docs/PROGRESS.md` وإيه اللي فاضل.»
- «شغّل كل الاختبارات وورّيني التقرير قبل ما نقفل المرحلة.»
- «راجع الكود ده كأنك reviewer صعب: أمان، أداء، تعارض offline.»
- «جرّب ملف الكاد الجديد ده في `fixtures/cad/` وقارن الناتج بالمتوقع.»

**أسئلة لسه مفتوحة، لازم تجاوب عليها قبل المرحلة 2:**

- معنى أكواد B وP وU جنب الصناديق.
- قائمة البنود الحقيقية (BOQ) بالأكواد والوحدات والأسعار.
- قالب المستخلص المعتمد عند العميل (Huawei / Orange / WE).
- الحد المسموح لبُعد GPS المشرف عن العنصر.
- هل ملفات الكاد مربوطة بإحداثيات حقيقية (UTM)، ولا بإحداثيات محلية وتحتاج ربط بنقط معروفة؟
- شكل الفاتورة المطلوب: الضرائب والخصومات والحجز (retention) عند العميل.
