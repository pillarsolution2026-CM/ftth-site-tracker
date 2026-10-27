# النشر على Staging (Hetzner)

بيئة الاختبار: **https://staging.ftthtracker.projectflow.site** (الويب) و **https://api.staging.ftthtracker.projectflow.site** (الـAPI، والموبايل بيكلمه).
القرار: ADR-009 و ADR-010 في `docs/DECISIONS.md`. ملفات التشغيل في `infra/staging/`.

## إزاي بيشتغل
- كل merge على `main` يشغّل `.github/workflows/deploy-staging.yml`: يبني 3 images (api، web، cad-worker) ويرفعها على GHCR، وبعدين يدخل السيرفر بـSSH ويعمل `docker compose pull && up -d`، ويختبر `/health` وصفحة الدخول.
- الـworkflow مش بيشتغل إلا لو متغير الريبو `STAGING_HOST` متظبط، فمفيش حاجة بتفشل قبل التجهيز.
- على السيرفر: Caddy بس اللي فاتح 80/443 وبيطلع شهادات Let's Encrypt تلقائي. Postgres/PostGIS وRedis جوه شبكة Docker الداخلية ومش مكشوفين.
- نسخة احتياطية يومية (`pg_dump`) في `/opt/ftth/backups` لمدة 7 أيام. النسخ الخارجي وPITR في المرحلة 7.
- الـmigrations بتتطبق تلقائي مع كل تشغيل للـAPI. الـseed التجريبي **مش** بيتشغل على staging.

## التجهيز لأول مرة (مرة واحدة)

### 1) مفتاح SSH للـdeploy
على جهازك:
```bash
ssh-keygen -t ed25519 -f ftth-staging-deploy -C github-actions-staging -N ''
```
- `ftth-staging-deploy.pub` → يتحط في cloud-init (الخطوة 2).
- `ftth-staging-deploy` (الخاص) → GitHub Secret (الخطوة 4). ماتبعتهوش في أي شات.

### 2) إنشاء السيرفر على Hetzner Cloud
- Console → Project جديد `ftth` → Add Server.
- Location: Falkenstein أو Nuremberg. Image: **Ubuntu 24.04**. Type: **CPX21** (3 vCPU / 4 GB) كفاية لـstaging.
- SSH key: مفتاحك الشخصي.
- **Cloud config:** الصق محتوى `infra/staging/cloud-init.yaml` بعد ما تحط المفتاحين (الشخصي ومفتاح الـdeploy العام).
- Firewalls → Create: inbound TCP 22، TCP 80، TCP 443، UDP 443 بس، واربطه بالسيرفر.
- خد الـIPv4 بتاع السيرفر.

### 3) الدومين (DNS عند مسجّل projectflow.site)
| Type | Name | Value |
| --- | --- | --- |
| A | `staging.ftthtracker` | IPv4 السيرفر |
| A | `api.staging.ftthtracker` | IPv4 السيرفر |

(اختياري AAAA بالـIPv6.) استنى لحد ما `dig +short staging.ftthtracker.projectflow.site` يرجّع الـIP.

### 4) إعدادات GitHub (Settings → Secrets and variables → Actions)
- **Variables:** `STAGING_HOST` = الـIPv4 أو `staging.ftthtracker.projectflow.site`.
- **Secrets:**
  - `STAGING_SSH_KEY` = محتوى الملف الخاص `ftth-staging-deploy`.
  - `STAGING_SSH_KNOWN_HOSTS` = ناتج `ssh-keyscan -t ed25519 <IP>` (من جهازك بعد ما السيرفر يقوم).
- Settings → Environments → `staging` (بيتعمل تلقائي أول مرة؛ ممكن تضيف required reviewers لو عايز موافقة قبل كل deploy).

### 5) ملف الأسرار على السيرفر
```bash
ssh deploy@<IP>
cd /opt/ftth
nano .env        # انسخ infra/staging/.env.example واملأ القيم
chmod 600 .env
```
ولّد كل كلمة سر بـ: `openssl rand -base64 48 | tr -d '\n/+='`.
بيانات S3 (Hetzner Object Storage) مش مستخدمة لحد المرحلة 1، بس لازم تبقى مالية؛ اعمل bucket `ftth-staging` من Console → Object Storage وحط مفاتيحه.

### 6) أول deploy
GitHub → Actions → **Deploy staging** → Run workflow (أو merge على `main`). بعد ما يخلص:
```bash
curl https://api.staging.ftthtracker.projectflow.site/health   # {"status":"ok","db":"ok"}
```

### 7) إنشاء أول Admin
```bash
ssh deploy@<IP>
cd /opt/ftth
docker compose run --rm -e ADMIN_EMAIL=you@company.com -e ADMIN_PASSWORD='<12+ حرف>' -e ADMIN_NAME='اسمك' api node dist/db/create-admin.js
```
الأمر مابيعدلش أي مستخدم موجود. بعدها ادخل على https://staging.ftthtracker.projectflow.site.

## الموبايل على staging
```bash
EXPO_PUBLIC_API_URL=https://api.staging.ftthtracker.projectflow.site pnpm --filter @ftth/mobile start
```

## تشغيل يدوي وصيانة
```bash
cd /opt/ftth
docker compose ps
docker compose logs -f api
IMAGE_TAG=<commit-sha> docker compose up -d     # الرجوع لإصدار سابق
docker compose exec -T postgis pg_restore -U ftth -d ftth --clean < backups/ftth-YYYY-MM-DD.dump   # استرجاع
```

## اللي اتأكد منه قبل الرفع
الـstack ده اتشغّل كامل محليًا بنفس الملفات (بدومينات `*.localhost`): كل الخدمات healthy، `/health` = ok، صفحة الدخول 200 عبر Caddy، تسجيل الدخول بأدمن اتعمل بـ`create-admin` نجح وطلّع cookies بـ`Secure; HttpOnly`، `/docs` = 404 في production، طلب login cross-site = 403، والنسخة الاحتياطية اتعملت.
