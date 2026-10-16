#!/usr/bin/env bash
# Runs a throwaway Apinator stack (control plane + EU data plane) for the
# integration test and the MCP inspector. Maintainers only: it builds the
# backend from the apinator monorepo checkout.
#
#   ./scripts/local-stack.sh up     # start, seed one app, print the env to use
#   ./scripts/local-stack.sh down   # stop and remove everything
#
# It uses its own containers on non-standard ports, so it never touches your
# dev containers (`make dev-infra`) or anything else already listening on
# 5432/6379/8080/8081. The credentials below are local test values only.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_DIR="${BACKEND_DIR:-$HERE/../../backend}"
STATE_DIR="$HERE/.local-stack"

PG_PORT=55433
REDIS_CENTRAL_PORT=56380
REDIS_EU_PORT=56381
API_PORT=58180
REALTIME_PORT=58181
PG_NAME=apinator-mcp-pg
REDIS_CENTRAL_NAME=apinator-mcp-redis-central
REDIS_EU_NAME=apinator-mcp-redis-eu

APP_ID=00000000-0000-0000-0000-00000000a001
APP_KEY=mcp-local-key
APP_SECRET=mcp-local-secret

down() {
  for f in "$STATE_DIR"/*.pid; do
    [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
    rm -f "$f"
  done
  docker rm -f "$PG_NAME" "$REDIS_CENTRAL_NAME" "$REDIS_EU_NAME" >/dev/null 2>&1 || true
}

wait_http() {
  for _ in $(seq 1 60); do
    curl -fsS "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "timed out waiting for $1" >&2
  return 1
}

up() {
  down
  mkdir -p "$STATE_DIR/bin"

  echo "== building backend binaries" >&2
  (cd "$BACKEND_DIR" && go build -o "$STATE_DIR/bin/api" ./cmd/api \
    && go build -o "$STATE_DIR/bin/realtime" ./cmd/realtime \
    && go build -o "$STATE_DIR/bin/migrate" ./cmd/migrate)

  echo "== starting postgres and redis" >&2
  docker run -d --name "$PG_NAME" -e POSTGRES_USER=realtime -e POSTGRES_PASSWORD=realtime \
    -e POSTGRES_DB=realtime -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
  docker run -d --name "$REDIS_CENTRAL_NAME" -p "${REDIS_CENTRAL_PORT}:6379" redis:7-alpine >/dev/null
  docker run -d --name "$REDIS_EU_NAME" -p "${REDIS_EU_PORT}:6379" redis:7-alpine >/dev/null
  # The postgres entrypoint restarts once after init; wait for a real query.
  for _ in $(seq 1 60); do
    docker exec "$PG_NAME" psql -U realtime -d realtime -tAc 'select 1' >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 1

  local db="postgres://realtime:realtime@localhost:${PG_PORT}/realtime?sslmode=disable"

  echo "== migrating and seeding" >&2
  # migrate reads file://internal/database/migrations relative to the cwd.
  (cd "$BACKEND_DIR" && DATABASE_URL="$db" "$STATE_DIR/bin/migrate" -direction up) >"$STATE_DIR/migrate.log" 2>&1
  docker exec -i "$PG_NAME" psql -q -U realtime -d realtime <<SQL
INSERT INTO orgs (id, name, email, password_hash, email_verified_at)
  VALUES ('00000000-0000-0000-0000-00000000f001', 'MCP Local', 'mcp-local@example.com', 'x', now());
INSERT INTO apps (id, org_id, name, region_id)
  VALUES ('$APP_ID', '00000000-0000-0000-0000-00000000f001', 'mcp-local', 'eu');
INSERT INTO api_keys (app_id, key, secret) VALUES ('$APP_ID', '$APP_KEY', '$APP_SECRET');
SQL

  echo "== starting control plane :$API_PORT and data plane :$REALTIME_PORT" >&2
  env DATABASE_URL="$db" REDIS_URL="redis://localhost:${REDIS_CENTRAL_PORT}/0" \
    INTERNAL_API_SECRET=mcp-local-internal JWT_SECRET=mcp-local-jwt PORT="$API_PORT" \
    CONSOLE_URL=http://localhost:3000 EMAIL_OUTPUT_DIR="$STATE_DIR/mail" \
    DATA_PLANE_API_URLS="eu=http://localhost:${REALTIME_PORT}" \
    "$STATE_DIR/bin/api" >"$STATE_DIR/api.log" 2>&1 &
  echo $! >"$STATE_DIR/api.pid"
  wait_http "http://localhost:${API_PORT}/health"

  env REDIS_URL="redis://localhost:${REDIS_EU_PORT}/0" CONTROL_PLANE_URL="http://localhost:${API_PORT}" \
    INTERNAL_API_SECRET=mcp-local-internal REGION_ID=eu NODE_ID=node-mcp-1 PORT="$REALTIME_PORT" \
    PUBLIC_WS_URL="ws://localhost:${REALTIME_PORT}" \
    "$STATE_DIR/bin/realtime" >"$STATE_DIR/realtime.log" 2>&1 &
  echo $! >"$STATE_DIR/realtime.pid"
  wait_http "http://localhost:${REALTIME_PORT}/health"

  cat >"$STATE_DIR/env" <<ENV
APINATOR_APP_ID=$APP_ID
APINATOR_KEY=$APP_KEY
APINATOR_SECRET=$APP_SECRET
APINATOR_CLUSTER=eu
APINATOR_API_URL=http://localhost:${REALTIME_PORT}
APINATOR_WS_URL=ws://localhost:${REALTIME_PORT}
ENV
  echo "== ready; environment written to $STATE_DIR/env" >&2
  cat "$STATE_DIR/env"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
