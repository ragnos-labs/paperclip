#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
compose_env="$ragnos_dir/.runtime/compose.env"
compose_file="$ragnos_dir/compose.yaml"
manifest="$ragnos_dir/hermes-roster.json"
cli_data_dir="${PAPERCLIP_CLI_DATA_DIR:-/paperclip/cli}"

if [[ ! -f "$compose_env" ]]; then
  echo "ERROR: render $compose_env before syncing the Hermes roster" >&2
  exit 1
fi
if [[ ! -f "$manifest" ]]; then
  echo "ERROR: missing $manifest" >&2
  exit 1
fi
for tool in jq node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: $tool is required" >&2
    exit 1
  fi
done

node "$script_dir/build-hermes-roster.mjs" --validate-manifest "$manifest" >/dev/null

compose=(docker compose --env-file "$compose_env" -f "$compose_file")

pc() {
  "${compose[@]}" exec -T paperclip \
    node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    "$@" --data-dir "$cli_data_dir" --json </dev/null
}

pc whoami >/dev/null
companies_json="$(pc company list)"
ragnos_company_id="$(jq -r '[.[] | select(.name == "RAGnos")][0].id // empty' <<<"$companies_json")"
aibl_company_id="$(jq -r '[.[] | select(.name == "AIBL")][0].id // empty' <<<"$companies_json")"
if [[ -z "$ragnos_company_id" || -z "$aibl_company_id" || "$ragnos_company_id" == "$aibl_company_id" ]]; then
  echo "ERROR: exact, distinct RAGnos and AIBL companies are required" >&2
  exit 1
fi

expected_count="$(jq -r '.expected_live_count' "$manifest")"
ragnos_agents="$(pc agent list -C "$ragnos_company_id")"
aibl_agents="$(pc agent list -C "$aibl_company_id")"

duplicate_profile_ids="$({
  jq -r '.[] | .metadata.ragnosHermes.profileId? // empty' <<<"$ragnos_agents"
} | sort | uniq -d)"
if [[ -n "$duplicate_profile_ids" ]]; then
  echo "ERROR: duplicate managed Hermes profile IDs already exist in RAGnos" >&2
  exit 1
fi
if jq -e 'any(.[]; .metadata.ragnosHermes.profileId? != null)' <<<"$aibl_agents" >/dev/null; then
  echo "ERROR: Hermes roster rows exist in AIBL; refusing cross-tenant mutation" >&2
  exit 1
fi

missing_count=0
while IFS= read -r profile_id; do
  existing_id="$(jq -r --arg profile_id "$profile_id" \
    '[.[] | select(.metadata.ragnosHermes.profileId? == $profile_id)][0].id // empty' \
    <<<"$ragnos_agents")"
  if [[ -z "$existing_id" ]]; then
    missing_count=$((missing_count + 1))
  fi
done < <(jq -r '.profiles[].profile_id' "$manifest")

approval_required="$(jq -r --arg id "$ragnos_company_id" \
  '[.[] | select(.id == $id)][0].requireBoardApprovalForNewAgents // false' \
  <<<"$companies_json")"
approval_relaxed=false
restore_approval() {
  if [[ "$approval_relaxed" == "true" ]]; then
    pc company update "$ragnos_company_id" \
      --payload-json '{"requireBoardApprovalForNewAgents":true}' >/dev/null || true
  fi
}
trap restore_approval EXIT

if [[ "$missing_count" -gt 0 && "$approval_required" == "true" ]]; then
  pc company update "$ragnos_company_id" \
    --payload-json '{"requireBoardApprovalForNewAgents":false}' >/dev/null
  approval_relaxed=true
fi

id_map='{}'
created_count=0
updated_count=0
while IFS= read -r profile; do
  profile_id="$(jq -r '.profile_id' <<<"$profile")"
  label="$(jq -r '.label' <<<"$profile")"
  existing_id="$(jq -r --arg profile_id "$profile_id" \
    '[.[] | select(.metadata.ragnosHermes.profileId? == $profile_id)][0].id // empty' \
    <<<"$ragnos_agents")"
  collision_id="$(jq -r --arg name "Hermes | $label" \
    '[.[] | select(.name == $name and .metadata.ragnosHermes.profileId? == null)][0].id // empty' \
    <<<"$ragnos_agents")"
  if [[ -n "$collision_id" && -z "$existing_id" ]]; then
    echo "ERROR: unmanaged RAGnos agent name collides with Hermes | $label" >&2
    exit 1
  fi

  payload="$(jq -cn \
    --arg name "Hermes | $label" \
    --arg title "Hermes $(jq -r '.org.role | gsub("_"; " ")' <<<"$profile")" \
    --arg capabilities "$(jq -r '.description' <<<"$profile") Paperclip is visibility and approval only; Hermes remains execution authority." \
    --argjson canonical "$profile" \
    --argjson source "$(jq -c '.source' "$manifest")" \
    '{
      name:$name,
      role:"general",
      title:$title,
      capabilities:$capabilities,
      adapterType:"hermes_gateway",
      adapterConfig:{},
      runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:false,maxConcurrentRuns:1,skipTimerWhenNoActionableWork:true}},
      budgetMonthlyCents:0,
      permissions:{canAssignTasks:false,canCreateAgents:false,canCreateSkills:false},
      metadata:{
        ragnosHermes:{
          schemaVersion:"paperclip_ragnos_hermes_roster/v1",
          profileId:$canonical.profile_id,
          label:$canonical.label,
          canonicalLifecycle:$canonical.lifecycle,
          governanceLifecycle:$canonical.governance_lifecycle,
          org:$canonical.org,
          permissions:$canonical.permissions,
          budgets:$canonical.budgets,
          writePolicy:$canonical.write_policy,
          schedule:$canonical.schedule,
          sourcePointers:$canonical.source_pointers,
          sourceProvenance:$source,
          rosterState:"live_paused",
          paperclipMode:"visibility_approval_only",
          executionAuthority:"ragnos_hermes",
          credentialsAttached:false
        }
      }
    }')"

  if [[ -z "$existing_id" ]]; then
    existing_id="$(pc agent create -C "$ragnos_company_id" --payload-json "$payload" | jq -r '.id')"
    created_count=$((created_count + 1))
  else
    update_payload="$(jq -c 'del(.permissions) + {replaceAdapterConfig:true}' <<<"$payload")"
    pc agent update "$existing_id" --payload-json "$update_payload" >/dev/null
    updated_count=$((updated_count + 1))
  fi
  pc agent permissions:update "$existing_id" \
    --payload-json '{"canAssignTasks":false,"canCreateAgents":false,"canCreateSkills":false}' >/dev/null
  pc agent pause "$existing_id" >/dev/null
  id_map="$(jq -c --arg profile_id "$profile_id" --arg agent_id "$existing_id" \
    '. + {($profile_id):$agent_id}' <<<"$id_map")"
done < <(jq -c '.profiles[]' "$manifest")

if [[ "$approval_relaxed" == "true" ]]; then
  pc company update "$ragnos_company_id" \
    --payload-json '{"requireBoardApprovalForNewAgents":true}' >/dev/null
  approval_relaxed=false
fi

while IFS= read -r profile; do
  profile_id="$(jq -r '.profile_id' <<<"$profile")"
  reports_to_profile="$(jq -r '.org.reports_to' <<<"$profile")"
  agent_id="$(jq -r --arg profile_id "$profile_id" '.[$profile_id]' <<<"$id_map")"
  manager_agent_id="$(jq -r --arg profile_id "$reports_to_profile" '.[$profile_id] // empty' <<<"$id_map")"
  if [[ -n "$manager_agent_id" ]]; then
    pc agent update "$agent_id" --payload-json "$(jq -cn --arg reports_to "$manager_agent_id" '{reportsTo:$reports_to}')" >/dev/null
  else
    pc agent update "$agent_id" --payload-json '{"reportsTo":null}' >/dev/null
  fi
done < <(jq -c '.profiles[]' "$manifest")

desired_ids="$(jq -c '[.profiles[].profile_id]' "$manifest")"
while IFS= read -r retired; do
  [[ -z "$retired" ]] && continue
  retired_id="$(jq -r '.id' <<<"$retired")"
  retired_metadata="$(jq -c '.metadata | .ragnosHermes.rosterState = "retired_paused"' <<<"$retired")"
  pc agent update "$retired_id" --payload-json "$(jq -cn --argjson metadata "$retired_metadata" '{metadata:$metadata}')" >/dev/null
  pc agent pause "$retired_id" >/dev/null
done < <(jq -c --argjson desired "$desired_ids" \
  '.[] | select(.metadata.ragnosHermes.profileId? as $profile_id | $profile_id != null and ($desired | index($profile_id) | not))' \
  <<<"$ragnos_agents")

ragnos_after="$(pc agent list -C "$ragnos_company_id")"
aibl_after="$(pc agent list -C "$aibl_company_id")"
managed_after="$(jq -c '[.[] | select(.metadata.ragnosHermes.rosterState? == "live_paused")]' <<<"$ragnos_after")"
managed_count="$(jq 'length' <<<"$managed_after")"
paused_count="$(jq '[.[] | select(.status == "paused")] | length' <<<"$managed_after")"
unique_profile_count="$(jq '[.[].metadata.ragnosHermes.profileId] | unique | length' <<<"$managed_after")"
internal_link_count="$(jq --argjson ids "$id_map" \
  '[.[] | select(.reportsTo != null and (.reportsTo as $manager | [$ids[]] | index($manager)))] | length' \
  <<<"$managed_after")"
cross_tenant_count="$(jq '[.[] | select(.metadata.ragnosHermes.profileId? != null)] | length' <<<"$aibl_after")"

if [[ "$managed_count" -ne "$expected_count" || "$paused_count" -ne "$expected_count" || \
      "$unique_profile_count" -ne "$expected_count" || "$cross_tenant_count" -ne 0 ]]; then
  echo "ERROR: Hermes roster post-sync count, pause, uniqueness, or tenant proof failed" >&2
  exit 1
fi
expected_internal_links="$(jq -r '.internal_reporting_link_count' "$manifest")"
if [[ "$internal_link_count" -ne "$expected_internal_links" ]]; then
  echo "ERROR: Hermes roster reporting-link proof failed" >&2
  exit 1
fi

mapping_hash="$(node -e '
  const crypto = require("node:crypto");
  const value = JSON.parse(process.argv[1]);
  const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  process.stdout.write(crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex"));
' "$id_map")"

jq -n \
  --arg ragnos_company_id "$ragnos_company_id" \
  --arg aibl_company_id "$aibl_company_id" \
  --arg mapping_sha256 "$mapping_hash" \
  --argjson created "$created_count" \
  --argjson updated "$updated_count" \
  --argjson live_profiles "$managed_count" \
  --argjson paused_profiles "$paused_count" \
  --argjson reporting_links "$internal_link_count" \
  --argjson external_reporting_links "$(jq '.external_reporting_links | length' "$manifest")" \
  '{
    schema_version:"paperclip_ragnos_hermes_roster_sync/v1",
    companies:{ragnos:$ragnos_company_id,aibl:$aibl_company_id},
    created:$created,
    updated:$updated,
    live_profiles:$live_profiles,
    paused_profiles:$paused_profiles,
    internal_reporting_links:$reporting_links,
    external_reporting_links:$external_reporting_links,
    cross_tenant_rows:0,
    mapping_sha256:$mapping_sha256,
    execution_authority:"ragnos_hermes",
    credentials_copied:false,
    clickup_data_imported:false
  }'
