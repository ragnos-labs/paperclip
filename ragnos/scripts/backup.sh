#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
env_file="$ragnos_dir/.runtime/compose.env"
backup_dir="$ragnos_dir/.runtime/backups"

if [[ ! -f "$env_file" ]]; then
  echo "ERROR: missing rendered environment" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
umask 077
mkdir -p "$backup_dir"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$backup_dir/paperclip-$timestamp.dump.enc"
receipt_path="$backup_path.receipt.json"

"$script_dir/compose.sh" exec -T db \
  pg_dump -U paperclip -d paperclip -Fc \
  | openssl enc -aes-256-cbc -salt -pbkdf2 \
      -pass env:PAPERCLIP_BACKUP_PASSPHRASE \
      -out "$backup_path"

backup_sha="$(shasum -a 256 "$backup_path" | awk '{print $1}')"
# shellcheck disable=SC2016
BACKUP_PATH="$(basename "$backup_path")" BACKUP_SHA="$backup_sha" node -e '
  process.stdout.write(`${JSON.stringify({
    schema_version: "paperclip_local_backup_receipt/v1",
    backup_file: process.env.BACKUP_PATH,
    encryption: "aes-256-cbc-pbkdf2",
    sha256: process.env.BACKUP_SHA,
    created_at: new Date().toISOString(),
  }, null, 2)}\n`);
' > "$receipt_path"
chmod 600 "$backup_path" "$receipt_path"
echo "$receipt_path"
