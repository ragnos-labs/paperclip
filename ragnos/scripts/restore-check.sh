#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <encrypted-backup>" >&2
  exit 64
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
env_file="$ragnos_dir/.runtime/compose.env"
backup_path="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
restore_db="paperclip_restore_check"

if [[ ! -f "$env_file" || ! -f "$backup_path" ]]; then
  echo "ERROR: rendered environment or backup is missing" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

"$script_dir/compose.sh" exec -T db dropdb -U paperclip --if-exists "$restore_db"
"$script_dir/compose.sh" exec -T db createdb -U paperclip "$restore_db"
openssl enc -d -aes-256-cbc -pbkdf2 \
  -pass env:PAPERCLIP_BACKUP_PASSPHRASE \
  -in "$backup_path" \
  | "$script_dir/compose.sh" exec -T db pg_restore \
      -U paperclip -d "$restore_db" --no-owner --no-privileges

table_count="$(
  "$script_dir/compose.sh" exec -T db psql -U paperclip -d "$restore_db" -Atqc \
    "select count(*) from information_schema.tables where table_schema = 'public';"
)"
"$script_dir/compose.sh" exec -T db dropdb -U paperclip "$restore_db"
echo "Restore check passed with $table_count public tables; scratch database removed."
