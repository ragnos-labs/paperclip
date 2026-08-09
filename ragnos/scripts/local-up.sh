#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--fleet-runtime-root PATH] [--paperclip-env-source PATH]" >&2
}

fleet_runtime_root="${HOME}/.ragnos/paperclip-fleet-local"
paperclip_env_source=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --fleet-runtime-root)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      fleet_runtime_root="$2"
      shift 2
      ;;
    --paperclip-env-source)
      [[ $# -ge 2 ]] || { usage; exit 64; }
      paperclip_env_source="$2"
      shift 2
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
compose_env="$ragnos_dir/.runtime/compose.env"

for tool in curl jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: $tool is required" >&2
    exit 1
  }
done

if [[ "$fleet_runtime_root" != /* ]]; then
  echo "ERROR: --fleet-runtime-root must be absolute" >&2
  exit 1
fi
curl -fsS --max-time 3 http://127.0.0.1:8771/health >/dev/null
ready="$(curl -fsS --max-time 3 http://127.0.0.1:8771/ready)"
if [[ "$(jq -r '.ready // false' <<<"$ready")" != "true" ]]; then
  echo "ERROR: real local Fleet gateway is not ready" >&2
  exit 1
fi

if [[ -z "$paperclip_env_source" && -f "$compose_env" ]]; then
  paperclip_env_source="$compose_env"
fi
render_args=(--local-fleet-runtime "$fleet_runtime_root")
if [[ -n "$paperclip_env_source" ]]; then
  render_args+=(--paperclip-env-source "$paperclip_env_source")
fi
"$script_dir/render-secrets.sh" "${render_args[@]}"
"$script_dir/compose.sh" config --quiet
"$script_dir/compose.sh" up --build -d db paperclip

healthy=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 http://127.0.0.1:3100/api/health >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
done
if [[ "$healthy" != "true" ]]; then
  echo "ERROR: Paperclip did not become healthy" >&2
  exit 1
fi

"$script_dir/seed-companies.sh" >/dev/null
"$script_dir/sync-hermes-roster.sh" >/dev/null
exec "$script_dir/local-status.sh"
