#!/usr/bin/env bash
# /usr/local/sbin/amcp-preview-deploy <repo>        (root:root 0755, executed as user amcp)
#
# Forced command for the preview deploy keys in /home/amcp/.ssh/authorized_keys:
#   restrict,command="/usr/local/sbin/amcp-preview-deploy anythingmcp" <key>
#   restrict,command="/usr/local/sbin/amcp-preview-deploy captianmuqimcp" <key>
# Client protocol (SSH_ORIGINAL_COMMAND):
#   deploy <slug> <tag> <actor> <branch>     stdin line 1 = GHCR token
#   destroy <slug>                           stdin line 1 = "-"
# Local (cron, as amcp):  amcp-preview-deploy <repo> gc
# Config: /etc/amcp-preview/<repo>.conf  (root:root 0644, KEY=VALUE)
# Audit:  /var/log/amcp-preview-deploy.log (root:amcp 0620) + journal tag amcp-preview-deploy
# Exit codes: 0 ok, 2 refused, 1 failed. Never touches /etc/amcp-deploy or the production instances.
set -euo pipefail
umask 077

REPO_KEY="${1:-}"
CONF="/etc/amcp-preview/${REPO_KEY}.conf"
LOG=/var/log/amcp-preview-deploy.log
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
export PATH=/usr/local/bin:/usr/bin:/bin
export GIT_TERMINAL_PROMPT=0

INST=""; TAG=""; COMMIT=""; ACTION=""
client="${SSH_CONNECTION:-}"; client="${client%% *}"
audit() {
  local line
  line="$(date -Is) repo=${REPO_KEY:--} action=${ACTION:--} instance=${INST:--} tag=${TAG:--} commit=${COMMIT:--} outcome=$1 client=${client:-local} uid=$(id -u)"
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
  logger -t amcp-preview-deploy -- "$line" 2>/dev/null || true
}
log()    { printf '[preview %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
cleanup_partial() { if [[ -n "${DIR:-}" && -d "$DIR" && ! -f "$DIR/meta.json" ]]; then rm -rf "$DIR" "${PREVIEWS_BASE:-/nonexistent}/dynamic/${INST:-none}.yml"; fi; }
refuse() { audit "refused:$1"; log "REFUSED: $2" >&2; cleanup_partial 2>/dev/null || true; exit 2; }
fail()   { audit "failed:$1";  log "FAILED: $2"  >&2; cleanup_partial; exit 1; }

root_file() { [[ -f "$1" ]] && [[ "$(stat -c '%u %a' "$1")" =~ ^0\ (644|444|640)$ ]]; }
[[ "$REPO_KEY" =~ ^[a-z0-9-]{1,32}$ ]] || refuse usage "repo key missing"
root_file "$CONF" || refuse config "missing or untrusted $CONF"
# shellcheck disable=SC1090
source "$CONF"
: "${REPO_URL:?}" "${IMAGE_REPO:?}" "${HOST_PREFIX:?}" "${DOMAIN:=flowerchatting.com}" "${PREVIEWS_BASE:=/home/amcp/previews}"
: "${DIR_BASE:=$PREVIEWS_BASE/instances}" "${OVERRIDE:=/etc/amcp-preview/preview.override.yml}" "${NETWORK:=amcp-previews}"
: "${MAX_PREVIEWS:=3}" "${TTL_DAYS:=7}" "${HEALTH_WAIT:=240}" "${PREVIEW_INDEX_URL:=https://previews.$DOMAIN/__previews/index.json}"
root_file "$OVERRIDE" || refuse config "missing or untrusted override $OVERRIDE"

# ---- arguments ---------------------------------------------------------------
if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then set -f; set -- $SSH_ORIGINAL_COMMAND; set +f; else shift || true; fi
ACTION="${1:-}"
slugify() { printf '%s' "$1" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' | cut -c1-30 | sed -E 's/-+$//'; }

case "$ACTION" in
  deploy)
    SLUG="${2:-}"; TAG="${3:-}"; ACTOR="${4:-}"; BRANCH="${5:-}"
    [[ "$SLUG"   =~ ^[a-z0-9][a-z0-9-]{0,29}$ ]]   || refuse slug "bad slug"
    [[ "$TAG"    =~ ^sha-[0-9a-f]{7,40}$ ]]         || refuse tag "bad tag"
    [[ "$ACTOR"  =~ ^[A-Za-z0-9._-]{1,64}$ ]]       || refuse actor "bad actor"
    [[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ ]]     || refuse branch "bad branch"
    [[ "$BRANCH" != "main" ]]                        || refuse branch "main is never previewed"
    [[ "$SLUG" == "$(slugify "$BRANCH")" ]]          || refuse slug "slug does not match branch"
    ;;
  destroy)
    SLUG="${2:-}"; [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,29}$ ]] || refuse slug "bad slug" ;;
  gc) [[ -z "${SSH_ORIGINAL_COMMAND:-}" ]] || refuse usage "gc is local only" ;;
  *)  refuse usage "usage: deploy <slug> <tag> <actor> <branch> | destroy <slug>" ;;
esac

# token: first stdin line, never logged, never in argv
TOKEN=""
if [[ "$ACTION" != "gc" ]]; then
  IFS= read -r -t 60 TOKEN || refuse token "no token line on stdin within 60s"
fi

inst_of() { printf '%s-%s' "$HOST_PREFIX" "$1"; }
compose() { docker compose -p "$INST" -f "$DIR/docker-compose.yml" -f "$OVERRIDE" --env-file "$DIR/.env" "$@"; }

do_destroy() {
  INST="$(inst_of "$1")"; DIR="$DIR_BASE/$INST"
  [[ -d "$DIR" ]] || refuse missing "no such preview $INST"
  log "destroying $INST"
  if [[ -f "$DIR/docker-compose.yml" && -f "$DIR/.env" ]]; then compose down -v --remove-orphans >/dev/null 2>&1 || true; fi
  docker ps -aq --filter "label=com.docker.compose.project=$INST" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=$INST" | xargs -r docker volume rm >/dev/null 2>&1 || true
  rm -rf "$DIR" "$PREVIEWS_BASE/dynamic/$INST.yml"
  PREVIEWS_BASE="$PREVIEWS_BASE" bash "$PREVIEWS_BASE/gen-index.sh"
}

if [[ "$ACTION" == "destroy" ]]; then do_destroy "$SLUG"; audit ok; log "done: $INST destroyed"; exit 0; fi

if [[ "$ACTION" == "gc" ]]; then
  now=$(date +%s); n=0
  for meta in "$DIR_BASE/$HOST_PREFIX"-*/meta.json; do
    [[ -f "$meta" ]] || continue
    ts=$(python3 -c 'import json,sys,datetime; d=json.load(open(sys.argv[1])); print(int(datetime.datetime.fromisoformat(d["updatedAt"].replace("Z","+00:00")).timestamp()))' "$meta" 2>/dev/null || echo 0)
    if (( now - ts > TTL_DAYS*86400 )); then
      s=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["slug"])' "$meta"); ACTION=gc; do_destroy "$s"; audit "ok:expired"; n=$((n+1))
    fi
  done
  log "gc: $n expired preview(s) removed"; exit 0
fi

# ---- deploy ------------------------------------------------------------------
INST="$(inst_of "$SLUG")"; HOST="$INST.$DOMAIN"; URL="https://$HOST"; DIR="$DIR_BASE/$INST"
existing=$(find "$DIR_BASE" -maxdepth 2 -mindepth 2 -type f -name meta.json -path "$DIR_BASE/$HOST_PREFIX-*" ! -path "$DIR/*" 2>/dev/null | wc -l)
if (( existing >= MAX_PREVIEWS )); then
  log "existing previews for $REPO_KEY:"; find "$DIR_BASE" -maxdepth 2 -mindepth 2 -type f -name meta.json -path "$DIR_BASE/$HOST_PREFIX-*" -printf '  %h\n' | sed 's#.*/##'
  refuse capacity "MAX_PREVIEWS=$MAX_PREVIEWS reached; destroy one first (delete its branch)"
fi
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
mkdir -p "$DIR" "$PREVIEWS_BASE/dynamic" "$PREVIEWS_BASE/public/__previews"

# source: fixed repo URL, the tag's commit must be reachable from origin/<branch>
SRC="$DIR/src"
if [[ ! -d "$SRC/.git" ]]; then git clone -q --no-checkout --filter=blob:none "$REPO_URL" "$SRC" || fail fetch "clone failed"; fi
git -C "$SRC" remote set-url origin "$REPO_URL"
git -C "$SRC" fetch -q --prune origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" || fail fetch "fetch origin/$BRANCH failed"
COMMIT="$(git -C "$SRC" rev-parse --verify --quiet "${TAG#sha-}^{commit}" || true)"
[[ -n "$COMMIT" ]] || refuse commit "tag $TAG does not resolve to a commit on origin/$BRANCH"
git -C "$SRC" merge-base --is-ancestor "$COMMIT" "origin/$BRANCH" || refuse commit "commit $COMMIT is not on origin/$BRANCH"
git -C "$SRC" checkout -q --detach "$COMMIT" -- 2>/dev/null || git -C "$SRC" checkout -q --detach "$COMMIT"
[[ -f "$SRC/docker-compose.yml" ]] || refuse compose "repo has no docker-compose.yml"
cp "$SRC/docker-compose.yml" "$DIR/docker-compose.yml"
log "deploy $INST  $TAG ($COMMIT) branch=$BRANCH actor=$ACTOR"

# .env: secrets generated once and kept; everything else rewritten on every deploy
SECRETS="$DIR/secrets.env"
if [[ ! -f "$SECRETS" ]]; then
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
    printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'COOKIE_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'NEXTAUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  } >"$SECRETS"
fi
{
  cat "$SECRETS"
  cat <<ENV
NODE_ENV=production
COMPOSE_PROJECT_NAME=$INST
IMAGE_REPO=$IMAGE_REPO
APP_TAG=$TAG
SERVER_URL=$URL
FRONTEND_URL=$URL
NEXT_PUBLIC_API_URL=$URL
NEXTAUTH_URL=$URL
CORS_ORIGIN=$URL
MCP_AUTH_MODE=oauth2
ALLOW_OPEN_REGISTRATION=true
APP_BIND_IP=127.0.0.1
NODE_MAX_OLD_SPACE_MB=512
PREVIEW_INDEX_URL=$PREVIEW_INDEX_URL
ENV
} >"$DIR/.env"

# static compose check on the RENDERED config (active services only)
rendered="$(compose config --format json 2>/dev/null)" || fail compose "docker compose config failed"
python3 - "$rendered" <<'PY' || refuse compose "compose static check failed (see above)"
import json, sys
cfg = json.loads(sys.argv[1]); bad = []
for name, svc in (cfg.get("services") or {}).items():
    if svc.get("privileged"): bad.append(f"{name}: privileged")
    if svc.get("cap_add"): bad.append(f"{name}: cap_add")
    if svc.get("network_mode") == "host": bad.append(f"{name}: network_mode host")
    if svc.get("pid") == "host" or svc.get("ipc") == "host": bad.append(f"{name}: pid/ipc host")
    for p in svc.get("ports") or []: bad.append(f"{name}: publishes port {p}")
    for v in svc.get("volumes") or []:
        if isinstance(v, dict):
            if v.get("type") == "bind": bad.append(f"{name}: bind mount {v.get('source')}")
        elif isinstance(v, str) and (v.startswith("/") or v.startswith(".")): bad.append(f"{name}: bind mount {v}")
        if isinstance(v, dict) and "docker.sock" in str(v.get("source", "")): bad.append(f"{name}: docker.sock")
    if not svc.get("mem_limit") and not (svc.get("deploy") or {}).get("resources", {}).get("limits", {}).get("memory"):
        bad.append(f"{name}: no mem_limit")
    if (svc.get("logging") or {}).get("driver") not in ("json-file", "local"): bad.append(f"{name}: no log rotation")
if bad:
    print("compose static check:", *bad, sep="\n  ", file=sys.stderr); sys.exit(1)
PY

# image
printf '%s\n' "$TOKEN" | docker login ghcr.io -u "$ACTOR" --password-stdin >/dev/null 2>&1 || fail login "ghcr login failed"
trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
compose pull -q app || fail pull "image pull failed: $IMAGE_REPO:$TAG"
docker logout ghcr.io >/dev/null 2>&1 || true; trap - EXIT

compose up -d --no-build --remove-orphans || fail up "compose up failed"

# health: the image's own HEALTHCHECK
waited=0
until [[ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$INST-app" 2>/dev/null)" == "healthy" ]]; do
  st="$(docker inspect --format '{{.State.Status}}' "$INST-app" 2>/dev/null || echo missing)"
  if [[ "$st" == "exited" || "$st" == "dead" ]] || (( waited >= HEALTH_WAIT )); then
    compose logs --no-color --tail=60 app >&2 || true
    fail health "$INST-app not healthy after ${waited}s (state=$st)"
  fi
  sleep 5; waited=$((waited+5))
done
log "healthy after ~${waited}s"

# route + index
sed -e "s/\${INSTANCE}/$INST/g" -e "s/\${HOST}/$HOST/g" "$PREVIEWS_BASE/instance.yml.tmpl" >"$PREVIEWS_BASE/dynamic/$INST.yml.tmp"
mv "$PREVIEWS_BASE/dynamic/$INST.yml.tmp" "$PREVIEWS_BASE/dynamic/$INST.yml"
python3 - "$DIR/meta.json" "$REPO_KEY" "$BRANCH" "$SLUG" "$URL" "$COMMIT" "$TAG" "$ACTOR" <<'PY'
import json, sys, datetime
p, repo, branch, slug, url, commit, tag, actor = sys.argv[1:]
json.dump({"repo": repo, "branch": branch, "slug": slug, "url": url, "commit": commit[:7], "tag": tag,
           "actor": actor, "updatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
          open(p, "w"))
PY
PREVIEWS_BASE="$PREVIEWS_BASE" bash "$PREVIEWS_BASE/gen-index.sh"
docker image prune -f >/dev/null 2>&1 || true
audit ok
log "done: $URL  ($INST $TAG)"
echo "::notice::preview ready: $URL"
