#!/bin/bash
set -euo pipefail

for port in 3000 3001 4000 5432 6379; do
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
done

cd /workspaces/BUG-fixer.ai/backend

docker compose down --remove-orphans || true

echo "Stopped backend and cleared local ports: 3000, 3001, 4000, 5432, 6379"
