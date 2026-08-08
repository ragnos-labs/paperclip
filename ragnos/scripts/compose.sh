#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
env_file="$ragnos_dir/.runtime/compose.env"

if [[ ! -f "$env_file" ]]; then
  echo "ERROR: render $env_file first with scripts/render-secrets.sh" >&2
  exit 1
fi

exec docker compose \
  --env-file "$env_file" \
  -f "$ragnos_dir/compose.yaml" \
  "$@"
