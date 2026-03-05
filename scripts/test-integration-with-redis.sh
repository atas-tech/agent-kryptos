#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
REDIS_URL_VALUE="${REDIS_URL:-redis://127.0.0.1:6380}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but was not found in PATH" >&2
  exit 1
fi

COMPOSE=(docker compose -f "$COMPOSE_FILE")

cleanup() {
  "${COMPOSE[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[integration] Starting Redis via docker compose..."
"${COMPOSE[@]}" up -d redis

container_id="$("${COMPOSE[@]}" ps -q redis)"
if [[ -z "$container_id" ]]; then
  echo "[integration] Failed to resolve Redis container id" >&2
  exit 1
fi

echo "[integration] Waiting for Redis health..."
for _ in {1..45}; do
  status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$container_id")"
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  sleep 1
done

status="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}unknown{{end}}' "$container_id")"
if [[ "$status" != "healthy" ]]; then
  echo "[integration] Redis did not become healthy (status=$status)" >&2
  exit 1
fi

echo "[integration] Running integration tests with REDIS_URL=$REDIS_URL_VALUE"
REDIS_URL="$REDIS_URL_VALUE" npm run test:integration

echo "[integration] Integration tests passed."
