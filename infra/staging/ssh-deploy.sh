#!/usr/bin/env bash
# Runs on the staging server as the SSH deploy user, uploaded and started by .github/workflows/deploy.yml:
#   bash ssh-deploy.sh <sha> [reset-admin-password]
#   (stdin: line 1 = admin email, line 2 = admin password; both may be empty)
# reset-admin-password sets the existing admin's password to the supplied one (root/sudo only).
# With root or passwordless sudo it runs bootstrap.sh of <sha> (idempotent: first setup, Caddy, timer, deploy,
# first admin). As ftth-deploy it runs ftth-autodeploy. Otherwise it stops and says what access is missing.
# Never prints secrets: GitHub Actions logs of this public repository are public.
set -euo pipefail

SHA="${1:?usage: ssh-deploy.sh <sha>}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::bad sha" >&2; exit 2; }
RESET_ADMIN=""
case "${2:-}" in
  "") ;;
  reset-admin-password) RESET_ADMIN=1 ;;
  *) echo "::error::unknown option: $2" >&2; exit 2 ;;
esac
readonly BOOTSTRAP_URL="https://raw.githubusercontent.com/pillarsolution2026-CM/ftth-site-tracker/$SHA/infra/staging/bootstrap.sh"

IFS= read -r admin_email || true
IFS= read -r admin_password || true

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

echo "ssh user: $(id -un) on $(hostname)"
privileged=""
sudo=()
if [[ $EUID -eq 0 ]]; then
  privileged=1
elif command -v sudo >/dev/null && sudo -n true 2>/dev/null; then
  privileged=1
  sudo=(sudo -n)
fi

if [[ -n "$privileged" ]]; then
  curl -fsSL "$BOOTSTRAP_URL" -o "$work/bootstrap.sh"
  args=()
  if [[ -n "$admin_email" && -n "$admin_password" ]]; then
    (umask 077; printf '%s' "$admin_password" >"$work/admin-password")
    args=(ADMIN_EMAIL="$admin_email" ADMIN_PASSWORD_FILE="$work/admin-password")
  elif [[ -n "$RESET_ADMIN" ]]; then
    echo "::error::reset-admin-password needs the FTTH_ADMIN_EMAIL and FTTH_ADMIN_PASSWORD secrets."
    exit 1
  else
    echo "FTTH_ADMIN_EMAIL / FTTH_ADMIN_PASSWORD secrets not set: the first admin is not created in this run."
  fi
  [[ -z "$RESET_ADMIN" ]] || args+=(ADMIN_RESET_PASSWORD=1)
  "${sudo[@]}" env "${args[@]}" bash "$work/bootstrap.sh"
  exit 0
fi

if [[ -n "$RESET_ADMIN" ]]; then
  echo "::error::reset-admin-password needs root or passwordless sudo (FTTH_USER)."
  exit 1
fi
if [[ "$(id -un)" == ftth-deploy && -x /usr/local/bin/ftth-autodeploy ]]; then
  /usr/local/bin/ftth-autodeploy
  echo "deployed: $(cat /srv/ftth/deployed-sha 2>/dev/null || echo none)"
  exit 0
fi

echo "::error::SSH works, but user '$(id -un)' has neither root nor passwordless sudo, and the server is not bootstrapped for it."
echo "::error::Set the FTTH_USER secret to root (or a user with passwordless sudo) and authorise FTTH_SSH_KEY for it."
exit 1
