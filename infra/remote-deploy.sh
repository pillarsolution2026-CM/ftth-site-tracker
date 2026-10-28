#!/usr/bin/env bash
# Runs on the server as user ftthtracker (piped over SSH by .github/workflows/deploy.yml: `bash -s -- <sha>`).
# Unpacks /srv/ftthtracker/incoming/<sha>.tgz into releases/<sha>, switches `current`, restarts web + api
# on 127.0.0.1 and rolls back to the previous release if the health checks fail.
# No root, no Docker, no build: needs Node >= 22 on PATH and /srv/ftthtracker/.env (see infra/ftth.env.example).
set -euo pipefail

SHA="${1:?usage: remote-deploy.sh <sha>}"
case "$SHA" in *[!0-9a-f]*|'') echo "bad sha" >&2; exit 2 ;; esac

ROOT=/srv/ftthtracker
REL="$ROOT/releases/$SHA"
PREV="$(readlink "$ROOT/current" 2>/dev/null || true)"

command -v node >/dev/null || { echo "::error::node is not available for $(whoami)"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "::error::Node >= 22 required, found $(node -v)"; exit 1; }
[ -f "$ROOT/.env" ] || { echo "::error::$ROOT/.env is missing (copy infra/ftth.env.example and fill it in)"; exit 1; }

mkdir -p "$ROOT/releases" "$ROOT/run" "$ROOT/logs" "$ROOT/storage"
rm -rf "$REL" && mkdir -p "$REL"
tar -xzf "$ROOT/incoming/$SHA.tgz" -C "$REL"

stop_one() { # <name>
  local pidf="$ROOT/run/$1.pid"
  [ -f "$pidf" ] || return 0
  local pid; pid="$(cat "$pidf")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid"
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pidf"
}

start_all() {
  set -a; . "$ROOT/.env"; set +a
  WEB_PORT="${WEB_PORT:-3200}"; API_PORT="${API_PORT:-3201}"
  stop_one web; stop_one api
  # API: runs migrations first, same as the Docker image command.
  ( cd "$ROOT/current/api" \
    && NODE_ENV=production PORT="$API_PORT" STORAGE_DRIVER="${STORAGE_DRIVER:-fs}" \
       STORAGE_FS_ROOT="${STORAGE_FS_ROOT:-$ROOT/storage}" APP_VERSION="$SHA" \
       setsid nohup sh -c 'node dist/db/migrate.js && exec node dist/main.js' \
       >>"$ROOT/logs/api.log" 2>&1 < /dev/null & echo $! >"$ROOT/run/api.pid" )
  ( cd "$ROOT/current/web" \
    && NODE_ENV=production PORT="$WEB_PORT" HOSTNAME=127.0.0.1 API_URL="http://127.0.0.1:$API_PORT" \
       setsid nohup node apps/web/server.js \
       >>"$ROOT/logs/web.log" 2>&1 < /dev/null & echo $! >"$ROOT/run/web.pid" )
}

healthy() {
  for _ in $(seq 1 40); do
    if curl -fsS -m 3 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1 \
       && curl -fsS -m 3 -o /dev/null "http://127.0.0.1:${WEB_PORT}/" 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

ln -sfn "$REL" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
start_all
if healthy; then
  echo "deployed $SHA"
  # keep the 5 newest releases and delete uploaded tarballs
  ls -1dt "$ROOT"/releases/* | tail -n +6 | xargs -r rm -rf
  rm -f "$ROOT/incoming/$SHA.tgz"
else
  echo "::error::health check failed for $SHA; last API log lines:"; tail -n 30 "$ROOT/logs/api.log" || true
  if [ -n "$PREV" ] && [ -d "$PREV" ]; then
    ln -sfn "$PREV" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
    start_all; echo "rolled back to $PREV"
  fi
  exit 1
fi
