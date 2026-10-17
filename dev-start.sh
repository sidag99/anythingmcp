#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.dev.yml)
LOCK_STAMP="node_modules/.anythingmcp-package-lock.sha256"

fail() {
  echo "Error: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js is not installed (Node.js 22+ is required)."
command -v npm >/dev/null 2>&1 || fail "npm is not installed (npm 9+ is required)."
command -v docker >/dev/null 2>&1 || fail "Docker is not installed."
docker compose version >/dev/null 2>&1 || fail "Docker Compose is not available."

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if ((node_major < 22)); then
  fail "Node.js 22+ is required; found $(node --version)."
fi

[[ -f .env ]] || fail ".env is missing. Run ./setup.sh once and choose Local development."

lock_hash="$(sha256sum package-lock.json | awk '{print $1}')"
installed_hash=""
if [[ -f "$LOCK_STAMP" ]]; then
  installed_hash="$(<"$LOCK_STAMP")"
fi

if [[ ! -x node_modules/.bin/prisma || "$installed_hash" != "$lock_hash" ]]; then
  echo "Installing dependencies from package-lock.json..."
  npm ci
  printf '%s\n' "$lock_hash" > "$LOCK_STAMP"
fi

ln -sfn ../../.env packages/backend/.env
ln -sfn ../../.env packages/frontend/.env

echo "Starting PostgreSQL..."
docker compose "${COMPOSE_FILES[@]}" up -d postgres

for _ in {1..60}; do
  if docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
    pg_isready -U amcp -d anythingmcp >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker compose "${COMPOSE_FILES[@]}" exec -T postgres \
  pg_isready -U amcp -d anythingmcp >/dev/null 2>&1; then
  fail "PostgreSQL did not become ready. Run: docker compose ${COMPOSE_FILES[*]} logs postgres"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

backend_port="${BACKEND_PORT:-${PORT:-4000}}"
frontend_port="${FRONTEND_PORT:-3000}"

port_in_use() {
  local port="$1"
  ss -H -ltn "sport = :$port" 2>/dev/null | grep -q .
}

if port_in_use "$backend_port"; then
  fail "Port $backend_port is already in use. Stop the old backend, then run this script again."
fi

if port_in_use "$frontend_port"; then
  fail "Port $frontend_port is already in use. Stop the old frontend, then run this script again."
fi

echo "Applying database migrations and generating Prisma client..."
(
  cd packages/backend
  npx prisma migrate deploy
  npx prisma generate
)

echo
echo "Starting AnythingMCP development servers:"
echo "  Frontend: http://localhost:$frontend_port"
echo "  Backend:  http://localhost:$backend_port"
echo "Press Ctrl+C to stop the frontend and backend. PostgreSQL will remain running."
echo

exec npm run dev
