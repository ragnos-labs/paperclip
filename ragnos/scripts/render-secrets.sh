#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--local-fixtures]" >&2
}

mode="infisical"
if [[ "${1:-}" == "--local-fixtures" ]]; then
  mode="local_fixtures"
elif [[ $# -gt 0 ]]; then
  usage
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
runtime_dir="$ragnos_dir/.runtime"
source_file="${RAGNOS_INFISICAL_ENV_FILE:-$HOME/.infisical/ragnos.env}"

umask 077
mkdir -p "$runtime_dir"

if [[ "$mode" == "infisical" ]]; then
  if [[ ! -f "$source_file" ]]; then
    echo "ERROR: Infisical render is unavailable at $source_file" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$source_file"
  set +a
  required=(
    PAPERCLIP_MVP_SESSION_SECRET
    PAPERCLIP_MVP_AGENT_JWT_SECRET
    PAPERCLIP_MVP_TOOL_SIGNING_SECRET
    PAPERCLIP_MVP_DB_PASSWORD
    PAPERCLIP_MVP_BACKUP_PASSPHRASE
    PAPERCLIP_MVP_RAGNOS_HMAC_KEY_B64
    PAPERCLIP_MVP_AIBL_HMAC_KEY_B64
  )
  for name in "${required[@]}"; do
    if [[ -z "${!name:-}" ]]; then
      echo "ERROR: Infisical-rendered variable $name is missing" >&2
      exit 1
    fi
  done
  session_secret="$PAPERCLIP_MVP_SESSION_SECRET"
  agent_jwt_secret="$PAPERCLIP_MVP_AGENT_JWT_SECRET"
  tool_secret="$PAPERCLIP_MVP_TOOL_SIGNING_SECRET"
  db_password="$PAPERCLIP_MVP_DB_PASSWORD"
  backup_passphrase="$PAPERCLIP_MVP_BACKUP_PASSPHRASE"
  ragnos_key="$PAPERCLIP_MVP_RAGNOS_HMAC_KEY_B64"
  aibl_key="$PAPERCLIP_MVP_AIBL_HMAC_KEY_B64"
else
  session_secret="$(openssl rand -hex 32)"
  agent_jwt_secret="$(openssl rand -hex 32)"
  tool_secret="$(openssl rand -hex 32)"
  db_password="$(openssl rand -base64 36 | tr -d '\n' | tr '/+' '_-')"
  backup_passphrase="$(openssl rand -base64 48 | tr -d '\n')"
  ragnos_key="$(openssl rand -base64 32 | tr -d '\n')"
  aibl_key="$(openssl rand -base64 32 | tr -d '\n')"
fi

temp_env="$(mktemp "$runtime_dir/compose.env.XXXXXX")"
temp_receipt="$(mktemp "$runtime_dir/secret-render-receipt.json.XXXXXX")"
cleanup() {
  rm -f "$temp_env" "$temp_receipt"
}
trap cleanup EXIT

keys_json="$(
  RAGNOS_KEY="$ragnos_key" AIBL_KEY="$aibl_key" node -e '
    process.stdout.write(JSON.stringify({
      "ragnos-paperclip-local-v1": {tenant_id: "ragnos", key_b64: process.env.RAGNOS_KEY},
      "aibl-paperclip-local-v1": {tenant_id: "aibl", key_b64: process.env.AIBL_KEY},
    }));
  '
)"

{
  printf 'PAPERCLIP_SESSION_SECRET=%s\n' "$session_secret"
  printf 'PAPERCLIP_AGENT_JWT_SECRET=%s\n' "$agent_jwt_secret"
  printf 'PAPERCLIP_TOOL_SIGNING_SECRET=%s\n' "$tool_secret"
  printf 'PAPERCLIP_DB_PASSWORD=%s\n' "$db_password"
  printf 'PAPERCLIP_BACKUP_PASSPHRASE=%s\n' "$backup_passphrase"
  printf 'RAGNOS_PAPERCLIP_HMAC_KEY_B64=%s\n' "$ragnos_key"
  printf 'AIBL_PAPERCLIP_HMAC_KEY_B64=%s\n' "$aibl_key"
  printf 'FLEET_FAKE_KEYS_JSON=%s\n' "$keys_json"
} > "$temp_env"
chmod 600 "$temp_env"

file_sha="$(shasum -a 256 "$temp_env" | awk '{print $1}')"
# shellcheck disable=SC2016
RENDER_MODE="$mode" FILE_SHA="$file_sha" node -e '
  process.stdout.write(`${JSON.stringify({
    schema_version: "paperclip_secret_render_receipt/v1",
    mode: process.env.RENDER_MODE,
    key_count: 8,
    env_sha256: process.env.FILE_SHA,
    rendered_at: new Date().toISOString(),
  }, null, 2)}\n`);
' > "$temp_receipt"
chmod 600 "$temp_receipt"

mv "$temp_env" "$runtime_dir/compose.env"
mv "$temp_receipt" "$runtime_dir/secret-render-receipt.json"
trap - EXIT
echo "Rendered 8 secret bindings in $mode mode. Values were not printed."
