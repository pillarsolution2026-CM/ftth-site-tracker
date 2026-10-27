#!/usr/bin/env bash
# Staging deploy, run as the SSH forced command of user ftth-deploy:
#   authorized_keys: restrict,command="/usr/local/bin/ftth-deploy" ssh-ed25519 AAAA... github-actions
# GitHub Actions calls: printf '%s\n' "$GHCR_TOKEN" | ssh ftth-deploy@host "deploy <commit-sha> <github-actor>"
# Installed root-owned (not writable by ftth-deploy): sudo install -m 755 deploy.sh /usr/local/bin/ftth-deploy
set -euo pipefail

readonly ROOT=/srv/ftth
readonly APP="$ROOT/app"
readonly ENV_FILE="$ROOT/.env"
readonly COMPOSE_FILE="$APP/infra/staging/docker-compose.yml"

read -r command sha actor extra <<<"${SSH_ORIGINAL_COMMAND:-}"
if [[ "$command" != deploy || ! "$sha" =~ ^[0-9a-f]{40}$ || ! "$actor" =~ ^[A-Za-z0-9-]{1,39}$ || -n "${extra:-}" ]]; then
  echo "usage: deploy <40-char commit sha> <github user>" >&2
  exit 2
fi

IFS= read -r ghcr_token || true
if [[ -z "$ghcr_token" ]]; then
  echo "missing registry token on stdin" >&2
  exit 2
fi

exec 9>"$ROOT/deploy.lock"
flock -n 9 || { echo "another deploy is running" >&2; exit 1; }

echo "==> checkout $sha"
git -C "$APP" fetch --quiet origin "$sha"
git -C "$APP" checkout --quiet --detach "$sha"

compose() {
  IMAGE_TAG="$sha" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "==> pull images"
printf '%s\n' "$ghcr_token" | docker login ghcr.io -u "$actor" --password-stdin >/dev/null
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
compose pull --quiet

echo "==> restart stack"
compose up -d --remove-orphans --wait --wait-timeout 180
docker image prune -f >/dev/null

echo "==> deployed $sha"
