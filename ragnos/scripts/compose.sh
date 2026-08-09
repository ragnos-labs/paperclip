#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
env_file="$ragnos_dir/.runtime/compose.env"

if [[ ! -f "$env_file" ]]; then
  echo "ERROR: render $env_file first with scripts/render-secrets.sh" >&2
  exit 1
fi

fleet_mode="$(awk -F= '$1 == "PAPERCLIP_FLEET_MODE" {sub(/^[^=]*=/, ""); print; exit}' "$env_file")"
if [[ "$fleet_mode" != "real" && "$fleet_mode" != "fake" ]]; then
  echo "ERROR: PAPERCLIP_FLEET_MODE must be real or fake" >&2
  exit 1
fi

profile_args=()
if [[ "$fleet_mode" == "fake" ]]; then
  profile_args=(--profile fake)
fi

exec docker compose \
  --env-file "$env_file" \
  -f "$ragnos_dir/compose.yaml" \
  "${profile_args[@]}" \
  "$@"
