# النشر على Staging (سيرفر Hetzner المشترك)

- **الويب:** https://staging.ftthtracker.projectflow.site
- **الـAPI:** https://api.staging.ftthtracker.projectflow.site/health
- **السيرفر:** `49.13.167.124`، وهو نفس السيرفر اللي عليه invoices وapp وn8n.
- **القرار:** ADR-010.
- **الملفات:** `infra/staging/`.

## إزاي بيشتغل
- كل merge على `main` بيشغّل workflow اسمه **Publish images**. الـworkflow بيبني الـimages (api وweb وcad-worker) ويرفعها على GHCR.
- السيرفر بيشيّك كل دقيقتين من خلال `ftth-autodeploy.timer`. لو فيه commit جديد والـimages بتاعته اترفعت، بيشغّله لوحده. لو التشغيل فشل، بيرجع للإصدار اللي قبله تلقائيًا.
- مفيش أي أسرار أو مفاتيح للسيرفر متخزنة في GitHub، ومفيش SSH داخل للسيرفر علشان الـdeploy.
- الـCaddy الموجود على السيرفر هو اللي بيعمل HTTPS، من خلال سطر `import` واحد لملف `/srv/ftth/ftthtracker.caddy`. باقي المواقع مابتتلمسش.
- الـstack بتاعنا اسمه `ftth-staging`، وليه قاعدة بيانات وRedis منفصلين عن باقي التطبيقات. كل حاجة تخصه موجودة في `/srv/ftth`، وبيشتغل بالمستخدم `ftth-deploy`.

## التجهيز: أمر واحد
1. اعمل merge للـPR على `main`، واستنى لحد ما **Publish images** في Actions يبقى ✅.
2. افتح Hetzner Console، وادخل على المشروع اللي فيه السيرفر `49.13.167.124` (Default أو Nile)، واختار السيرفر، واضغط على **`>_` Console**.
   - لو مش عارف باسورد root: افتح تبويب **Rescue**، واضغط **Reset root password**، وخد الباسورد الجديد.
3. ادخل بـ`root`، والصق الأمر ده بعد ما تغيّر الإيميل لإيميلك:
```bash
curl -fsSL https://raw.githubusercontent.com/pillarsolution2026-CM/ftth-site-tracker/main/infra/staging/bootstrap.sh | ADMIN_EMAIL=you@example.com bash
```
في الآخر هيطبع اللينكات، وإيميل الأدمن، و**باسورد بيظهر مرة واحدة بس**، فاحفظه.

### الأمر ده بيعمل إيه
- يفحص إن Docker وCaddy شغالين، وإن البورتات اللي هيستخدمها فاضية. لو أي حاجة ناقصة بيقف من غير ما يغيّر حاجة.
- يعمل المستخدم `ftth-deploy` والفولدر `/srv/ftth`، وينزّل الكود.
- يولّد كلمات سر عشوائية في `/srv/ftth/.env`.
- يربط Caddy، بالترتيب ده:
  - ياخد نسخة احتياطية من `Caddyfile`.
  - يضيف سطر `import` واحد.
  - يعمل `caddy validate`.
  - لو الـvalidate نجح يعمل `reload`. لو فشل يرجّع الملف زي ما كان بالظبط، ومايعملش reload.
- يشغّل الـtimer، وأول deploy، ويعمل أول أدمن.
- لو اتشغّل تاني، مابيكررش حاجة ومابيغيرش كلمات السر.

> لو الـimages لسه ماخلصتش، الأمر هيقول كده. استنى شوية وشغّله تاني علشان يعمل الأدمن.
> لو قال إن الـimages مش public: على GitHub ادخل على Your profile، وبعدين Packages، واختار كل package (api وweb وcad-worker)، وبعدين Package settings، وغيّر الـvisibility لـPublic.

## الموبايل على staging
```bash
EXPO_PUBLIC_API_URL=https://api.staging.ftthtracker.projectflow.site pnpm --filter @ftth/mobile start
```

## صيانة
```bash
journalctl -u ftth-autodeploy -n 50            # سجل الـdeploy
cat /srv/ftth/deployed-sha                      # الـcommit الشغال
runuser -u ftth-deploy -- ftth-autodeploy --force   # إعادة تشغيل الإصدار الحالي
cd /srv/ftth/app && C="docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml"
IMAGE_TAG=$(cat /srv/ftth/deployed-sha) $C ps
IMAGE_TAG=$(cat /srv/ftth/deployed-sha) $C logs -f api
```
النسخ الاحتياطية في `/srv/ftth/backups`: نسخة كل يوم، بتتحفظ 7 أيام.

## إلغاء كل حاجة
```bash
systemctl disable --now ftth-autodeploy.timer
cd /srv/ftth/app && IMAGE_TAG=x docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml down
sed -i '\#import /srv/ftth/ftthtracker.caddy#d; /FTTH Site Tracker staging/d' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
```

## اللي اتجرب قبل الرفع
اتعمل سيرفر تجريبي (Ubuntu 24.04 + Docker + Caddy حقيقي، وCaddyfile فيه موقع تاني بيمثّل invoices)، وجربت عليه:
- `bootstrap.sh` كمّل للآخر: الخدمات كلها بقت healthy، و`/health` رجّع ok، وصفحة الدخول رجّعت 200، والأدمن اتعمل.
- لما اتشغّل تاني ماغيّرش أي حاجة.
- الموقع التاني فضل زي ما هو.
- لما الـCaddyfile كان فيه خطأ، الأمر وقف ورجّع الملف زي ما كان byte-for-byte.
- commit جديد من غير images: الـautodeploy استنى، وماغيّرش الإصدار الشغال.
