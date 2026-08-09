#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 [--local-fixtures | --local-fleet-runtime PATH [--paperclip-env-source PATH]]" >&2
}

mode="infisical"
fleet_runtime_root=""
paperclip_env_source=""
if [[ "${1:-}" == "--local-fixtures" && $# -eq 1 ]]; then
  mode="local_fixtures"
elif [[ "${1:-}" == "--local-fleet-runtime" && ( $# -eq 2 || $# -eq 4 ) ]]; then
  mode="local_fleet_runtime"
  fleet_runtime_root="$2"
  if [[ $# -eq 4 ]]; then
    [[ "$3" == "--paperclip-env-source" ]] || {
      usage
      exit 64
    }
    paperclip_env_source="$4"
  fi
elif [[ $# -gt 0 ]]; then
  usage
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
runtime_dir="$ragnos_dir/.runtime"
source_file="${RAGNOS_INFISICAL_ENV_FILE:-$HOME/.infisical/ragnos.env}"

private_file_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

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
  fleet_mode="fake"
  fleet_gateway_url="http://fleet-broker:8787"
  ragnos_key_id="ragnos-paperclip-local-v1"
  aibl_key_id="aibl-paperclip-local-v1"
  fleet_apply_enabled="false"
elif [[ "$mode" == "local_fixtures" ]]; then
  session_secret="$(openssl rand -hex 32)"
  agent_jwt_secret="$(openssl rand -hex 32)"
  tool_secret="$(openssl rand -hex 32)"
  db_password="$(openssl rand -base64 36 | tr -d '\n' | tr '/+' '_-')"
  backup_passphrase="$(openssl rand -base64 48 | tr -d '\n')"
  ragnos_key="$(openssl rand -base64 32 | tr -d '\n')"
  aibl_key="$(openssl rand -base64 32 | tr -d '\n')"
  fleet_mode="fake"
  fleet_gateway_url="http://fleet-broker:8787"
  ragnos_key_id="ragnos-paperclip-local-v1"
  aibl_key_id="aibl-paperclip-local-v1"
  fleet_apply_enabled="false"
else
  if [[ "$fleet_runtime_root" != /* || -L "$fleet_runtime_root" || ! -d "$fleet_runtime_root" ]]; then
    echo "ERROR: --local-fleet-runtime must be an existing absolute, non-symlink directory" >&2
    exit 1
  fi
  ragnos_credential="$fleet_runtime_root/secrets/paperclip-ragnos.credential.json"
  aibl_credential="$fleet_runtime_root/secrets/paperclip-aibl.credential.json"
  for credential in "$ragnos_credential" "$aibl_credential"; do
    if [[ -L "$credential" || ! -f "$credential" ]]; then
      echo "ERROR: local Fleet Paperclip credential is missing or unsafe" >&2
      exit 1
    fi
    if [[ "$(private_file_mode "$credential")" != "600" ]]; then
      echo "ERROR: local Fleet Paperclip credential must have mode 600" >&2
      exit 1
    fi
  done
  credential_fields="$({
    RAGNOS_CREDENTIAL="$ragnos_credential" AIBL_CREDENTIAL="$aibl_credential" node -e '
      const fs = require("fs");
      const expected = [
        [process.env.RAGNOS_CREDENTIAL, "ragnos-mission-control-service-v1"],
        [process.env.AIBL_CREDENTIAL, "aibl-deck-service-v1"],
      ];
      const fields = [];
      for (const [path, keyId] of expected) {
        const value = JSON.parse(fs.readFileSync(path, "utf8"));
        if (value.key_id !== keyId || typeof value.hmac_key_b64 !== "string") process.exit(2);
        const bytes = Buffer.from(value.hmac_key_b64, "base64url");
        if (bytes.length !== 32) process.exit(3);
        fields.push(value.key_id, value.hmac_key_b64);
      }
      process.stdout.write(fields.join("\t"));
    '
  } 2>/dev/null)" || {
    echo "ERROR: local Fleet Paperclip credentials are invalid" >&2
    exit 1
  }
  IFS=$'\t' read -r ragnos_key_id ragnos_key aibl_key_id aibl_key <<<"$credential_fields"
  session_secret="$(openssl rand -hex 32)"
  agent_jwt_secret="$(openssl rand -hex 32)"
  tool_secret="$(openssl rand -hex 32)"
  db_password="$(openssl rand -base64 36 | tr -d '\n' | tr '/+' '_-')"
  backup_passphrase="$(openssl rand -base64 48 | tr -d '\n')"
  if [[ -n "$paperclip_env_source" ]]; then
    if [[ "$paperclip_env_source" != /* || -L "$paperclip_env_source" || \
          ! -f "$paperclip_env_source" ]]; then
      echo "ERROR: --paperclip-env-source must be an existing absolute, non-symlink file" >&2
      exit 1
    fi
    if [[ "$(private_file_mode "$paperclip_env_source")" != "600" ]]; then
      echo "ERROR: --paperclip-env-source must have mode 600" >&2
      exit 1
    fi
    preserved_fields="$({
      PAPERCLIP_ENV_SOURCE="$paperclip_env_source" node -e '
        const fs = require("fs");
        const values = {};
        for (const line of fs.readFileSync(process.env.PAPERCLIP_ENV_SOURCE, "utf8").split(/\r?\n/)) {
          if (!line || line.startsWith("#")) continue;
          const index = line.indexOf("=");
          if (index < 1) process.exit(2);
          values[line.slice(0, index)] = line.slice(index + 1);
        }
        const keys = [
          "PAPERCLIP_SESSION_SECRET",
          "PAPERCLIP_AGENT_JWT_SECRET",
          "PAPERCLIP_TOOL_SIGNING_SECRET",
          "PAPERCLIP_DB_PASSWORD",
          "PAPERCLIP_BACKUP_PASSPHRASE",
        ];
        const selected = keys.map((key) => values[key]);
        if (selected.some((value) => typeof value !== "string" || !value || /[\t\r\n]/.test(value))) process.exit(3);
        process.stdout.write(selected.join("\t"));
      '
    } 2>/dev/null)" || {
      echo "ERROR: existing Paperclip environment cannot preserve local state" >&2
      exit 1
    }
    IFS=$'\t' read -r session_secret agent_jwt_secret tool_secret db_password backup_passphrase \
      <<<"$preserved_fields"
  fi
  fleet_mode="real"
  fleet_gateway_url="http://host.docker.internal:8771"
  if [[ -f "$fleet_runtime_root/secrets/github-app-key.pem" && \
        -f "$fleet_runtime_root/secrets/github-app-installations.json" ]]; then
    fleet_apply_enabled="true"
  else
    fleet_apply_enabled="false"
  fi
fi

temp_env="$(mktemp "$runtime_dir/compose.env.XXXXXX")"
temp_receipt="$(mktemp "$runtime_dir/secret-render-receipt.json.XXXXXX")"
cleanup() {
  rm -f "$temp_env" "$temp_receipt"
}
trap cleanup EXIT

keys_json='{}'
if [[ "$fleet_mode" == "fake" ]]; then
  keys_json="$(
    RAGNOS_KEY_ID="$ragnos_key_id" RAGNOS_KEY="$ragnos_key" \
      AIBL_KEY_ID="$aibl_key_id" AIBL_KEY="$aibl_key" node -e '
      process.stdout.write(JSON.stringify({
        [process.env.RAGNOS_KEY_ID]: {tenant_id: "ragnos", key_b64: process.env.RAGNOS_KEY},
        [process.env.AIBL_KEY_ID]: {tenant_id: "aibl", key_b64: process.env.AIBL_KEY},
      }));
    '
  )"
fi

{
  printf 'PAPERCLIP_SESSION_SECRET=%s\n' "$session_secret"
  printf 'PAPERCLIP_AGENT_JWT_SECRET=%s\n' "$agent_jwt_secret"
  printf 'PAPERCLIP_TOOL_SIGNING_SECRET=%s\n' "$tool_secret"
  printf 'PAPERCLIP_DB_PASSWORD=%s\n' "$db_password"
  printf 'PAPERCLIP_BACKUP_PASSPHRASE=%s\n' "$backup_passphrase"
  printf 'PAPERCLIP_FLEET_MODE=%s\n' "$fleet_mode"
  printf 'PAPERCLIP_FLEET_GATEWAY_URL=%s\n' "$fleet_gateway_url"
  printf 'PAPERCLIP_FLEET_APPLY_ENABLED=%s\n' "$fleet_apply_enabled"
  printf 'RAGNOS_FLEET_KEY_ID=%s\n' "$ragnos_key_id"
  printf 'AIBL_FLEET_KEY_ID=%s\n' "$aibl_key_id"
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
    key_count: 13,
    env_sha256: process.env.FILE_SHA,
    rendered_at: new Date().toISOString(),
  }, null, 2)}\n`);
' > "$temp_receipt"
chmod 600 "$temp_receipt"

mv "$temp_env" "$runtime_dir/compose.env"
mv "$temp_receipt" "$runtime_dir/secret-render-receipt.json"
trap - EXIT
echo "Rendered 13 secret bindings in $mode mode. Values were not printed."
