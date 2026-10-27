#!/usr/bin/env bash
# Pull-based staging deploy (ADR-010). Runs every 2 minutes as ftth-deploy via ftth-autodeploy.timer.
# When origin/main moves and that commit's images exist on GHCR, it checks the commit out and restarts
# the stack. On failure it rolls back to the previously deployed commit. Usage: ftth-autodeploy [--force]
set -euo pipefail

readonly ROOT="${FTTH_ROOT:-/srv/ftth}"
readonly BRANCH="${FTTH_BRANCH:-main}"
readonly APP="$ROOT/app"
readonly ENV_FILE="$ROOT/.env"
readonly STATE_FILE="$ROOT/deployed-sha"
readonly COMPOSE_FILE="$APP/infra/staging/docker-compose.yml"
readonly IMAGES=(api web cad-worker)

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

exec 9>"$ROOT/autodeploy.lock"
flock -n 9 || exit 0

registry="$(sed -n 's/^IMAGE_REGISTRY=//p' "$ENV_FILE" | tail -n 1)"
[[ -n "$registry" ]] || { log "IMAGE_REGISTRY missing in $ENV_FILE"; exit 1; }

git -C "$APP" fetch --quiet origin "$BRANCH"
target="$(git -C "$APP" rev-parse "origin/$BRANCH")"
current="$(cat "$STATE_FILE" 2>/dev/null || true)"
if [[ "$target" == "$current" && "${1:-}" != --force ]]; then
  exit 0
fi

# Images are public on GHCR; a missing tag means CI has not published this commit yet.
for image in "${IMAGES[@]}"; do
  ref="$registry/$image:$target"
  if ! docker image inspect "$ref" >/dev/null 2>&1 && ! docker pull --quiet "$ref" >/dev/null 2>&1; then
    log "waiting for $ref (not published yet or not public); will retry"
    exit 0
  fi
done

compose() { IMAGE_TAG="$1" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "${@:2}"; }

deploy() {
  git -C "$APP" checkout --quiet --detach "$1"
  compose "$1" up -d --remove-orphans --wait --wait-timeout 300
}

log "deploying $target (was ${current:-none})"
if deploy "$target"; then
  printf '%s\n' "$target" >"$STATE_FILE"
  docker image prune -f >/dev/null
  log "deployed $target"
  exit 0
fi

log "deploy of $target failed"
if [[ -n "$current" ]]; then
  log "rolling back to $current"
  deploy "$current" || log "rollback failed; check: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE ps"
fi
exit 1
