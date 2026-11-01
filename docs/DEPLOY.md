# النشر على Staging (سيرفر Hetzner المشترك)

- **الويب:** https://staging.ftthtracker.projectflow.site
- **الـAPI:** https://api.staging.ftthtracker.projectflow.site/health
- **السيرفر:** `49.13.167.124`، وهو نفس السيرفر اللي عليه invoices وapp وn8n.
- **القرار:** ADR-010.
- **الملفات:** `infra/staging/`.

## إزاي بيشتغل
- كل merge على `main` بيشغّل workflow اسمه **Publish images**. الـworkflow بيبني الـimages (api وweb وcad-worker) ويرفعها على GHCR.
- السيرفر بيشيّك كل دقيقتين من خلال `ftth-autodeploy.timer`. لو فيه commit جديد والـimages بتاعته اترفعت، بيشغّله لوحده. لو التشغيل فشل، بيرجع للإصدار اللي قبله تلقائيًا.
- **بالإضافة لكده فيه نشر بالـSSH (قرار المالك 2026-10-30، ADR-022):** بعد ما **Publish images** يخلص بنجاح على `main`، بيشتغل workflow اسمه **Deploy (SSH)**. الـworkflow ده بيدخل السيرفر بالـSSH، ويشغّل `infra/staging/ssh-deploy.sh`، اللي بيعمل كده حسب صلاحية المستخدم:
  - لو root أو عنده sudo من غير باسورد: يشغّل `bootstrap.sh` بتاع نفس الـcommit. ده بيعمل التجهيز أول مرة وبعدها النشر، وآمن لو اتكرر.
  - لو المستخدم هو `ftth-deploy`: يشغّل `ftth-autodeploy` بس.
  - غير كده: بيقف ويقول الصلاحية الناقصة إيه.
  - الـtimer بيفضل شغال كاحتياطي. الاتنين مستخدمين نفس الـlock، فمايتصادموش.
- الـsecrets بتاعة GitHub (Settings ← Secrets and variables ← Actions):
  - **إجباري:** `FTTH_HOST` و`FTTH_USER` (يفضّل `root`) و`FTTH_SSH_KEY` و`FTTH_KNOWN_HOSTS`.
  - **اختياري، علشان أول أدمن:** `FTTH_ADMIN_EMAIL` و`FTTH_ADMIN_PASSWORD` (12 حرف على الأقل). الباسورد بيتبعت على stdin، ومابيتطبعش في الـlog، لأن الـlogs بتاعة الريبو ده public.
- تقدر تشغّله بإيدك من Actions ← **Deploy (SSH)** ← **Run workflow**.
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

### تغيير باسورد الأدمن (لو ضاع)
1. في GitHub: Settings ← Secrets and variables ← Actions، حط `FTTH_ADMIN_EMAIL` (إيميل الأدمن) و`FTTH_ADMIN_PASSWORD` (الباسورد الجديد، 12 حرف على الأقل).
2. Actions ← **Deploy (SSH)** ← **Run workflow**، وعلّم على `reset_admin_password`.

الباسورد بيتغير للأدمن الموجود بس (مابيعملش يوزر جديد ولا بيلمس يوزر مش أدمن)، وكل الجلسات المفتوحة بتاعته بتتقفل. مابيتطبعش في الـlog. محتاج `FTTH_USER` يكون root أو عنده sudo من غير باسورد.

الملفات المرفوعة (رسومات الكاد DWG/DXF وملفات PDF وإكسل أوامر التكليف) على staging بتتخزن على volume اسمه `ftth-storage` (مثبّت على `/var/lib/ftth/storage` في الـapi والـworker). الـvolume ده **مش داخل في نسخة قاعدة البيانات الليلية**، فلازم يتاخد منه نسخة احتياطية بنفس الاهتمام (مثلاً `docker run --rm -v ftth-staging_ftth-storage:/data -v /srv/ftth/backups:/out alpine tar czf /out/storage-$(date +%F).tgz -C /data .`). لما نعدي على object storage هنغيّر `STORAGE_DRIVER` لـ`s3`.

## Tiles (Phase 1b, ADR-031)
Martin على staging بيشتغل لوحده مع كل deploy من `bootstrap.sh`، ومفيش خطوات يدوية ولا سجل DNS:
- **الأسرار:** `bootstrap.sh` بيضيف `TILE_URL_SECRET` و`FTTH_TILES_PASSWORD` و`TILES_PUBLIC_URL` و`MARTIN_PORT` لـ`/srv/ftth/.env` لو ناقصين، ومابيغيّرش الموجود. لو `TILE_URL_SECRET` اتغيّر، اللينكات اللي اتطلعت قبل كده بتبطل (ساعة صلاحية أصلًا).
- **الـrole:** بيحط كلمة سر `ftth_tiles` من نفس الملف بعد الـdeploy.
- **المسار:** `https://api.staging.ftthtracker.projectflow.site/design_features/{z}/{x}/{y}?...`، وCaddy بيسأل `/tiles/verify` في الـAPI قبل ما الطلب يوصل لـMartin. البورت على `127.0.0.1` بس.
- **لو Martin وقع:** البرنامج مابيتأثرش ومفيش rollback، لأنه في compose profile لوحده (`tiles`). الـlog بيطلع تحذير بس.

**التأكيد:** log بتاع Deploy (SSH) في خطوة «Tile server» لازم يطلع: catalog فيه `design_features`، ومن غير توقيع 401، وبتوقيع 200 أو 204، و`ftth_tiles cannot read tables: ok`.

للوجز على السيرفر:
```bash
cd /srv/ftth/app && IMAGE_TAG=$(cat /srv/ftth/deployed-sha) docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml --profile tiles logs martin
```

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
