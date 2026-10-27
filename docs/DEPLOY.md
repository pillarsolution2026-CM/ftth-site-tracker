# النشر على Staging (سيرفر Hetzner المشترك)

بيئة الاختبار: **https://staging.ftthtracker.projectflow.site** (الويب) و **https://api.staging.ftthtracker.projectflow.site** (الـAPI، والموبايل بيكلمه).
السيرفر: `49.13.167.124`، وهو نفس السيرفر اللي عليه invoices وapp وn8n. القرار في ADR-010، والملفات في `infra/staging/`.

## الفكرة
- **Caddy الموجود على السيرفر** هو اللي بيعمل HTTPS ويوجّه الدومينات. إحنا بنضيف له سطر `import` واحد لملف `ftthtracker.caddy`، بنفس طريقة `invoices.caddy`. مفيش Caddy تاني ومفيش بورتات جديدة على الإنترنت.
- الـstack بتاعنا (`ftth-staging`) فيه قاعدة بيانات وRedis خاصين بيه، منفصلين تمامًا عن invoices. الويب والـAPI بيفتحوا بس على `127.0.0.1:3310` و`127.0.0.1:3311`.
- كل حاجة تخصنا في `/srv/ftth`، ومستخدم مخصوص اسمه `ftth-deploy` مالوش صلاحية غير أمر الـdeploy (forced command)، زي `invoices-deploy` بالظبط.
- كل merge على `main` بيبني الـimages ويرفعها على GHCR، وبعدين يعمل SSH بمفتاح الـdeploy: `deploy <sha>`. السكربت بيعمل checkout للـcommit، ثم `docker compose pull`، ثم `up --wait`.
- الـworkflow مش بيشتغل إلا لو `STAGING_HOST` متظبط.
- فيه نسخة احتياطية يومية (`pg_dump`) في `/srv/ftth/backups` بتتحفظ 7 أيام. الـmigrations بتتطبق تلقائي، والـseed التجريبي ممنوع.

## التجهيز لأول مرة (مرة واحدة، بمستخدم عنده sudo أو root)

### 0) الدخول للسيرفر
بالمستخدم الإداري اللي بتستخدمه لإعداد invoices، أو من Hetzner Console: افتح السيرفر واضغط `>_` Console. لو باسورد root مش معاك: Rescue → Reset root password.

### 1) اتأكد إن البورتات فاضية
```bash
ss -tlnp | grep -E ':(3310|3311) ' || echo "free"
```
لو مستخدمين: غيّر `WEB_PORT`/`API_PORT` في `.env` (الخطوة 4)، وغيّر الرقمين في `infra/staging/ftthtracker.caddy`.

### 2) المستخدم والفولدرات والكود
```bash
sudo adduser --disabled-password --gecos "" ftth-deploy
sudo usermod -aG docker ftth-deploy
sudo install -d -o ftth-deploy -g ftth-deploy -m 755 /srv/ftth
sudo install -d -o ftth-deploy -g ftth-deploy -m 750 /srv/ftth/backups
sudo -u ftth-deploy git clone https://github.com/pillarsolution2026-CM/ftth-site-tracker.git /srv/ftth/app
sudo install -o root -g root -m 755 /srv/ftth/app/infra/staging/deploy.sh /usr/local/bin/ftth-deploy
```

### 3) مفتاح الـdeploy (forced command)
على جهازك:
```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\ftth_staging_deploy -C github-actions-ftth -N '""'
type $env:USERPROFILE\.ssh\ftth_staging_deploy.pub
```
وعلى السيرفر، حط المفتاح **العام** مع القيود دي:
```bash
sudo install -d -o ftth-deploy -g ftth-deploy -m 700 /home/ftth-deploy/.ssh
echo 'restrict,command="/usr/local/bin/ftth-deploy" ssh-ed25519 AAAA...الصق_المفتاح_العام... github-actions-ftth' | sudo tee /home/ftth-deploy/.ssh/authorized_keys
sudo chown ftth-deploy:ftth-deploy /home/ftth-deploy/.ssh/authorized_keys && sudo chmod 600 /home/ftth-deploy/.ssh/authorized_keys
```

### 4) ملف الأسرار
```bash
sudo -u ftth-deploy cp /srv/ftth/app/infra/staging/.env.example /srv/ftth/.env
sudo -u ftth-deploy chmod 600 /srv/ftth/.env
sudo -u ftth-deploy nano /srv/ftth/.env
```
ولّد كل كلمة سر بالأمر `openssl rand -base64 48 | tr -d '\n/+='`. بيانات S3 مش مستخدمة لحد المرحلة 1، بس لازم تكون موجودة: اعمل bucket `ftth-staging` من Hetzner Console → Object Storage.

### 5) ربط Caddy
```bash
sudo cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%F-%H%M)
echo 'import /srv/ftth/app/infra/staging/ftthtracker.caddy' | sudo tee -a /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && sudo systemctl reload caddy
```
لو الـvalidate فشل، **ماتعملش reload**. رجّع النسخة: `sudo cp -a /etc/caddy/Caddyfile.bak.<التاريخ> /etc/caddy/Caddyfile`.

### 6) GitHub (Settings → Secrets and variables → Actions)
- **Variable** باسم `STAGING_HOST` وقيمته `49.13.167.124`.
- **Secret** باسم `STAGING_SSH_KEY` وقيمته محتوى الملف الخاص `ftth_staging_deploy` كامل.
- **Secret** باسم `STAGING_SSH_KNOWN_HOSTS` وقيمته ناتج `ssh-keyscan -t ed25519 49.13.167.124`. قارن البصمة بناتج `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` على السيرفر.

### 7) أول deploy
من GitHub: Actions → **Deploy staging** → Run workflow، أو اعمل merge على `main`. بعدها:
```bash
curl https://api.staging.ftthtracker.projectflow.site/health   # {"status":"ok","db":"ok"}
```

### 8) أول Admin
```bash
cd /srv/ftth/app
sudo -u ftth-deploy docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml \
  run --rm -e ADMIN_EMAIL=you@company.com -e ADMIN_PASSWORD='<12+ حرف>' -e ADMIN_NAME='اسمك' \
  api node dist/db/create-admin.js
```
الأمر مابيعدلش أي مستخدم موجود.

## الموبايل على staging
```bash
EXPO_PUBLIC_API_URL=https://api.staging.ftthtracker.projectflow.site pnpm --filter @ftth/mobile start
```

## صيانة
```bash
cd /srv/ftth/app
C="docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml"
$C ps; $C logs -f api
IMAGE_TAG=<commit-sha> $C up -d                                    # الرجوع لإصدار سابق
$C exec -T postgis pg_restore -U ftth -d ftth --clean < /srv/ftth/backups/ftth-YYYY-MM-DD.dump
```
لو `deploy.sh` اتغير في الريبو، لازم تعيد تثبيته يدويًا (الخطوة 2، السطر الأخير)، لأن النسخة المثبتة بتاعة root ومحدش يقدر يغيرها غيره. ونفس الكلام لأي تعديل في `ftthtracker.caddy`: مش هيشتغل غير بعد `caddy validate` و`systemctl reload caddy`.

## اللي اتأكد منه قبل الرفع
- الـstack اتشغّل محليًا بنفس الملفات. كل الخدمات بقت healthy، و`127.0.0.1:3311/health` رجّع ok، و`127.0.0.1:3310/ar/login` رجّع 200.
- ملف `ftthtracker.caddy` بعد ما اتعمله import جوه Caddyfile فيه موقع تاني عدّى `caddy validate`.
- `deploy.sh` بيرفض أي أمر غير `deploy <sha كامل> <user>`، وبيرفض لو مفيش token.
- النسخة الأولى من الـstack (بـCaddy خاص بيها) كان اتجرب فيها كمان: تسجيل الدخول عبر HTTPS، والـcookies طالعة `Secure; HttpOnly`، و`/docs` بترجع 404، وطلب login من موقع تاني بيترفض (CSRF).
