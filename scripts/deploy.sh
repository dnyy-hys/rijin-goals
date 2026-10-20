#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo 'Install Docker Engine and the Docker Compose plugin before deploying.' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo 'Create .env from .env.example and set DOMAIN and ADMIN_EMAIL first.' >&2
  exit 1
fi
docker compose config --quiet
docker compose build --pull
docker compose up -d --wait --wait-timeout 180
origin="$(docker compose exec -T app node -p 'process.env.PUBLIC_ORIGIN')"
if command -v curl >/dev/null 2>&1; then
  curl --fail --show-error --silent --retry 6 --retry-all-errors --retry-delay 5 --max-time 20 "${origin}/api/health"
  echo
else
  echo 'HTTPS has not been checked: curl is unavailable.' >&2
  exit 1
fi
echo "HTTPS health check passed: ${origin}"
