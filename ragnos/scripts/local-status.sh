#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
compose_env="$ragnos_dir/.runtime/compose.env"
compose_file="$ragnos_dir/compose.yaml"
manifest="$ragnos_dir/hermes-roster.json"
cli_data_dir="${PAPERCLIP_CLI_DATA_DIR:-/paperclip/cli}"

if [[ ! -f "$compose_env" || ! -f "$manifest" ]]; then
  echo "ERROR: rendered Compose environment and Hermes roster are required" >&2
  exit 1
fi
for tool in curl docker jq node; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "ERROR: $tool is required" >&2
    exit 1
  }
done

safe_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$compose_env"
}

fleet_mode="$(safe_env_value PAPERCLIP_FLEET_MODE)"
apply_enabled="$(safe_env_value PAPERCLIP_FLEET_APPLY_ENABLED)"
[[ "$fleet_mode" == "real" ]] || {
  echo "ERROR: local launch status requires the real Fleet profile" >&2
  exit 1
}
[[ "$apply_enabled" == "true" || "$apply_enabled" == "false" ]] || {
  echo "ERROR: invalid apply-enabled binding" >&2
  exit 1
}

compose=(docker compose --env-file "$compose_env" -f "$compose_file")
pc() {
  "${compose[@]}" exec -T paperclip \
    node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    "$@" --data-dir "$cli_data_dir" --json </dev/null
}

node "$script_dir/build-hermes-roster.mjs" --validate-manifest "$manifest" >/dev/null
paperclip_health="$(curl -fsS --max-time 3 http://127.0.0.1:3100/api/health)"
gateway_health="$(curl -fsS --max-time 3 http://127.0.0.1:8771/health)"
gateway_ready="$(curl -fsS --max-time 3 http://127.0.0.1:8771/ready)"
pc whoami >/dev/null

companies_json="$(pc company list)"
ragnos_company_id="$(jq -r '[.[] | select(.name == "RAGnos Labs")][0].id // empty' <<<"$companies_json")"
aibl_company_id="$(jq -r '[.[] | select(.name == "AIBL")][0].id // empty' <<<"$companies_json")"
if [[ -z "$ragnos_company_id" || -z "$aibl_company_id" || "$ragnos_company_id" == "$aibl_company_id" ]]; then
  echo "ERROR: exact, distinct RAGnos Labs and AIBL companies are required" >&2
  exit 1
fi

ragnos_agents="$(pc agent list -C "$ragnos_company_id")"
aibl_agents="$(pc agent list -C "$aibl_company_id")"
expected_count="$(jq -r '.expected_live_count' "$manifest")"
expected_internal_links="$(jq -r '.internal_reporting_link_count' "$manifest")"
managed="$(jq -c '[.[] | select(.metadata.ragnosHermes.rosterState? == "live_paused")]' <<<"$ragnos_agents")"
managed_count="$(jq 'length' <<<"$managed")"
paused_count="$(jq '[.[] | select(.status == "paused")] | length' <<<"$managed")"
chief_ids="$(jq -c '[.[] | select(.metadata.ragnosHermes.org.role? == "department_chief") | .id]' <<<"$managed")"
chief_count="$(jq 'length' <<<"$chief_ids")"
chief_of_staff_count="$(jq '[.[] | select(.metadata.ragnosHermes.org.role? == "chief_of_staff")] | length' <<<"$managed")"
workers_under_chiefs="$(jq --argjson chiefs "$chief_ids" \
  '[.[] | select(.reportsTo as $manager | $chiefs | index($manager))] | length' <<<"$managed")"
chief_of_staff_id="$(jq -r '[.[] | select(.metadata.ragnosHermes.org.role? == "chief_of_staff")][0].id // empty' <<<"$managed")"
direct_staff_count="$(jq --arg chief "$chief_of_staff_id" \
  '[.[] | select(.reportsTo == $chief and .metadata.ragnosHermes.org.role? != "department_chief")] | length' <<<"$managed")"
managed_ids="$(jq -c '[.[].id]' <<<"$managed")"
internal_links="$(jq --argjson ids "$managed_ids" \
  '[.[] | select(.reportsTo != null and (.reportsTo as $manager | $ids | index($manager)))] | length' <<<"$managed")"
cross_tenant_rows="$(jq '[.[] | select(.metadata.ragnosHermes.profileId? != null)] | length' <<<"$aibl_agents")"
ragnos_fleet_agents="$(jq '[.[] | select(.metadata.ragnosFleet.schemaVersion? == "paperclip_ragnos_fleet_employee/v1")] | length' <<<"$ragnos_agents")"
aibl_fleet_agents="$(jq '[.[] | select(.metadata.ragnosFleet.schemaVersion? == "paperclip_ragnos_fleet_employee/v1")] | length' <<<"$aibl_agents")"
disabled_appliers="$(jq '[.[] | select(.metadata.ragnosFleet.operation? == "apply" and .metadata.ragnosFleet.executionEnabled? == false and .status == "paused")] | length' \
  <<<"$(jq -c -s 'add' <(printf '%s' "$ragnos_agents") <(printf '%s' "$aibl_agents"))")"
fake_broker_running=false
if [[ -n "$("${compose[@]}" ps -q fleet-broker 2>/dev/null)" ]]; then
  fake_broker_running=true
fi

status="ok"
if [[ "$(jq -r '.status // empty' <<<"$paperclip_health")" != "ok" || \
      "$(jq -r '.status // empty' <<<"$gateway_health")" != "ok" || \
      "$(jq -r '.ready // false' <<<"$gateway_ready")" != "true" || \
      "$managed_count" -ne "$expected_count" || "$paused_count" -ne "$expected_count" || \
      "$chief_count" -ne 9 || "$chief_of_staff_count" -ne 1 || \
      "$workers_under_chiefs" -ne 26 || "$direct_staff_count" -ne 1 || \
      "$internal_links" -ne "$expected_internal_links" || "$cross_tenant_rows" -ne 0 || \
      "$ragnos_fleet_agents" -ne 2 || "$aibl_fleet_agents" -ne 2 || \
      "$fake_broker_running" != "false" ]]; then
  status="failed"
fi
if [[ "$apply_enabled" == "false" && "$disabled_appliers" -ne 2 ]]; then
  status="failed"
fi

jq -n \
  --arg status "$status" \
  --arg fleet_mode "$fleet_mode" \
  --argjson apply_enabled "$apply_enabled" \
  --argjson paperclip_health "$paperclip_health" \
  --argjson gateway_health "$gateway_health" \
  --argjson gateway_ready "$gateway_ready" \
  --arg ragnos_company_id "$ragnos_company_id" \
  --arg aibl_company_id "$aibl_company_id" \
  --argjson roster_count "$managed_count" \
  --argjson paused_roster_count "$paused_count" \
  --argjson chief_of_staff_count "$chief_of_staff_count" \
  --argjson department_chief_count "$chief_count" \
  --argjson workers_under_chiefs "$workers_under_chiefs" \
  --argjson direct_staff_count "$direct_staff_count" \
  --argjson internal_reporting_links "$internal_links" \
  --argjson cross_tenant_rows "$cross_tenant_rows" \
  --argjson ragnos_fleet_agents "$ragnos_fleet_agents" \
  --argjson aibl_fleet_agents "$aibl_fleet_agents" \
  --argjson disabled_appliers "$disabled_appliers" \
  --argjson fake_broker_running "$fake_broker_running" \
  '{
    schema_version:"paperclip_ragnos_local_status/v1",
    status:$status,
    fleet_mode:$fleet_mode,
    apply_enabled:$apply_enabled,
    bindings:{paperclip:"127.0.0.1:3100",fleet_gateway:"127.0.0.1:8771"},
    health:{paperclip:$paperclip_health,gateway:$gateway_health,ready:$gateway_ready},
    companies:{ragnos:$ragnos_company_id,aibl:$aibl_company_id},
    roster:{
      live_profiles:$roster_count,
      paused_profiles:$paused_roster_count,
      chief_of_staff:$chief_of_staff_count,
      department_chiefs:$department_chief_count,
      workers_under_chiefs:$workers_under_chiefs,
      direct_staff:$direct_staff_count,
      internal_reporting_links:$internal_reporting_links,
      cross_tenant_rows:$cross_tenant_rows
    },
    fleet_agents:{ragnos:$ragnos_fleet_agents,aibl:$aibl_fleet_agents,disabled_appliers:$disabled_appliers},
    fake_broker_running:$fake_broker_running,
    credentials_printed:false
  }'

[[ "$status" == "ok" ]]
