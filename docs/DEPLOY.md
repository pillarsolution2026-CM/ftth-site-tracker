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

الملفات المرفوعة (رسومات الكاد DWG/DXF وملفات PDF وإكسل أوامر التكليف) على staging بتتخزن على volume اسمه `ftth-storage` (مثبّت على `/var/lib/ftth/storage` في الـapi والـworker). الـvolume ده **مش داخل في نسخة قاعدة البيانات الليلية**، فلازم يتاخد منه نسخة احتياطية بنفس الاهتمام (مثلاً `docker run --rm -v ftth-staging_ftth-storage:/data -v /srv/ftth/backups:/out alpine tar czf /out/storage-$(date +%F).tgz -C /data .`). لما نعدي على object storage هنغيّر `STORAGE_DRIVER` لـ`s3`.

## Tiles (Phase 1b)
**مش متفعّلة على staging دلوقتي** (ADR-010 وADR-021). الـAPI من غير `TILE_URL_SECRET` و`TILES_PUBLIC_URL` بيرد 404 على `tile-url` وبيرفض أي طلب على `/tiles/verify`، وتنزيل ملف الـPMTiles (`tiles.pmtiles`) شغال عادي من غير Martin. لما نحب نفعّل Martin على staging، الخطوات دي بالترتيب. **ماتعملش حاجة منها قبل ما الـmigration `0005` تتطبّق** (الـAPI بيطبّقها لوحده عند التشغيل)، لأن الـrole `ftth_tiles` بيتعمل فيها.

1. **الأسرار** (على السيرفر في `/srv/ftth/.env`، من غير ما تتسجّل في أي مكان تاني):
   ```bash
   echo "TILE_URL_SECRET=$(openssl rand -base64 48 | tr -d '\n')" >> /srv/ftth/.env
   echo "FTTH_TILES_PASSWORD=$(openssl rand -hex 24)" >> /srv/ftth/.env
   echo "TILES_PUBLIC_URL=https://tiles.staging.ftthtracker.projectflow.site" >> /srv/ftth/.env
   ```
   الـ`TILE_URL_SECRET` لازم يكون 32 حرف على الأقل. لو اتغيّر، كل اللينكات اللي اتطلعت قبل كده بتبطل (ساعة صلاحية أصلًا).
2. **كلمة سر الـrole**: الـrole `ftth_tiles` بيتعمل من غير login. من داخل الـpostgres بتاع staging (بصلاحية الأدمن بتاعه):
   ```bash
   cd /srv/ftth/app && C="docker compose --env-file /srv/ftth/.env -f infra/staging/docker-compose.yml"
   set -a; . /srv/ftth/.env; set +a
   echo "ALTER ROLE ftth_tiles LOGIN PASSWORD :'pw'" | IMAGE_TAG=$(cat /srv/ftth/deployed-sha) $C exec -T postgres \
     psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v pw="$FTTH_TILES_PASSWORD"
   ```
   (اسم الـservice وأسماء المتغيرات حسب `infra/staging/docker-compose.yml`؛ راجعهم قبل التشغيل.)
3. **خدمة Martin في compose بتاع staging**: أضف service جديد زي `martin` في `infra/docker-compose.yml`:
   - الـimage: `ghcr.io/maplibre/martin` بإصدار محدد (جرّب إصدار وثبّته بعد أول تشغيل ناجح؛ في dev هو `latest` لأن مفيش إصدار اتأكدنا منه).
   - الأمر: `--config /config/config.yaml`، والـvolume: `infra/martin/config.yaml` للقراءة بس.
   - المتغير: `TILES_DATABASE_URL=postgres://ftth_tiles:${FTTH_TILES_PASSWORD}@<service-postgres>:5432/${POSTGRES_DB}`.
   - البورت: `127.0.0.1:<MARTIN_PORT>:3000` (loopback بس، ومن غير ما يتنشر على أي interface تاني). متغيرات `TILE_URL_SECRET` و`TILES_PUBLIC_URL` تتضاف كمان لـservice الـapi.
4. **Caddy**: أضف في `infra/staging/ftthtracker.caddy.template` موقع جديد (وبعدها شغّل `bootstrap.sh` تاني، هو اللي بيعمل validate وreload وrollback):
   ```
   tiles.staging.ftthtracker.projectflow.site {
   	import ftth_headers
   	forward_auth 127.0.0.1:__API_PORT__ {
   		uri /tiles/verify
   	}
   	reverse_proxy 127.0.0.1:__MARTIN_PORT__
   }
   ```
   وضيف سجل DNS للدومين ده. مثال production كامل في `infra/ftth.caddy`.
5. **تأكيد**:
   - `curl -i https://tiles.../design_features/14/1/1` من غير توقيع لازم يرجّع 401.
   - اطلب `POST /projects/<p>/design-revisions/<r>/tile-url` بتوكن PM، واستبدل `{z}/{x}/{y}` بأرقام، ولازم يرجّع 200 بملف MVT (أو tile فاضي برا الرسم).
   - تأكد إن `ftth_tiles` مش بيقرا جداول: `psql "postgres://ftth_tiles:...@.../db" -c "select 1 from users"` لازم يفشل بـ`permission denied`.

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
