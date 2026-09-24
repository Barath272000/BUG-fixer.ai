#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT/backend"
FRONTEND_DIR="$ROOT/frontend"
BACKEND_PORT="${BACKEND_PORT:-4000}"
FRONTEND_PORT="${FRONTEND_PORT:-3000}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd docker
require_cmd npm
require_cmd curl

clear_conflicts() {
  echo "Clearing any conflicting local listeners on ${FRONTEND_PORT} and ${BACKEND_PORT}..."
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${FRONTEND_PORT}/tcp" "${BACKEND_PORT}/tcp" 5432/tcp 6379/tcp 2>/dev/null || true
  fi
}

start_backend() {
  echo "Starting backend services..."
  cd "$BACKEND_DIR"
  docker compose up -d postgres redis api worker

  echo "Waiting for backend health on http://localhost:${BACKEND_PORT}/api/v1/health..."
  for _ in {1..120}; do
    if curl -fsS "http://localhost:${BACKEND_PORT}/api/v1/health" >/dev/null 2>&1; then
      break
    fi
  done

  echo "Backend health:" 
  curl -fsS "http://localhost:${BACKEND_PORT}/api/v1/health"
}

start_frontend() {
  echo "Starting frontend on http://localhost:${FRONTEND_PORT}..."
  cd "$FRONTEND_DIR"
  npm install
  npm run dev -- --host 0.0.0.0 --port "$FRONTEND_PORT"
}

clear_conflicts
start_backend
start_frontend
