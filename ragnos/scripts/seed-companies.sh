#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ragnos_dir="$(cd "$script_dir/.." && pwd)"
compose_env="$ragnos_dir/.runtime/compose.env"
compose_file="$ragnos_dir/compose.yaml"
cli_data_dir="${PAPERCLIP_CLI_DATA_DIR:-/paperclip/cli}"

if [[ ! -f "$compose_env" ]]; then
  echo "ERROR: render $compose_env before seeding companies" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 1
fi

compose=(docker compose --env-file "$compose_env" -f "$compose_file")

pc() {
  "${compose[@]}" exec -T paperclip \
    node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts \
    "$@" --data-dir "$cli_data_dir" --json
}

pc whoami >/dev/null

company_id_by_name() {
  local company_name="$1"
  pc company list | jq -r --arg name "$company_name" '.[] | select(.name == $name) | .id' | head -1
}

ensure_company() {
  local company_name="$1"
  local company_description="$2"
  local company_id
  company_id="$(company_id_by_name "$company_name")"
  if [[ -z "$company_id" ]]; then
    company_id="$(
      pc company create --payload-json "$(
        jq -cn \
          --arg name "$company_name" \
          --arg description "$company_description" \
          '{name:$name,description:$description,budgetMonthlyCents:10000}'
      )" | jq -r '.id'
    )"
  fi
  pc company update "$company_id" --payload-json "$(
    jq -cn \
      --arg description "$company_description" \
      '{description:$description,budgetMonthlyCents:10000}'
  )" >/dev/null
  pc budget company:update -C "$company_id" \
    --payload-json '{"budgetMonthlyCents":10000}' >/dev/null
  printf '%s\n' "$company_id"
}

ensure_secret() {
  local company_id="$1"
  local secret_name="$2"
  local secret_key="$3"
  local value_env="$4"
  local secret_id
  secret_id="$(
    pc secrets list -C "$company_id" \
      | jq -r --arg key "$secret_key" '.[] | select(.key == $key and .status == "active") | .id' \
      | head -1
  )"
  if [[ -z "$secret_id" ]]; then
    secret_id="$(
      pc secrets create -C "$company_id" \
        --name "$secret_name" \
        --key "$secret_key" \
        --provider local_encrypted \
        --value-env "$value_env" \
        --description 'Fleet Broker signing key rendered outside source control.' \
        | jq -r '.id'
    )"
  fi
  printf '%s\n' "$secret_id"
}

clear_agent_error() {
  local agent_id="$1"
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T \
    -e TARGET_AGENT_ID="$agent_id" \
    -e PAPERCLIP_CLI_DATA_DIR="$cli_data_dir" \
    paperclip node -e '
      const fs = require("fs");
      const authPath = `${process.env.PAPERCLIP_CLI_DATA_DIR}/auth.json`;
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      const credential = Object.values(auth.credentials)[0];
      if (!credential) throw new Error("board_cli_credential_missing");
      fetch(`${credential.apiBase}/api/agents/${process.env.TARGET_AGENT_ID}/clear-error`, {
        method: "POST",
        headers: { Authorization: `Bearer ${credential.token}` },
      }).then(async (response) => {
        if (!response.ok) throw new Error(`clear_agent_error_http_${response.status}`);
      });
    '
}

ensure_agent() {
  local company_id="$1"
  local agent_name="$2"
  local operation="$3"
  local key_id="$4"
  local secret_id="$5"
  local title="$6"
  local capabilities="$7"
  local agents_json
  local agent_id
  local agent_state
  local adapter_config
  local payload

  agents_json="$(pc agent list -C "$company_id")"
  agent_id="$(jq -r --arg name "$agent_name" '.[] | select(.name == $name) | .id' <<<"$agents_json" | head -1)"
  agent_state="$(jq -r --arg name "$agent_name" '.[] | select(.name == $name) | .status' <<<"$agents_json" | head -1)"
  adapter_config="$(
    jq -cn \
      --arg key_id "$key_id" \
      --arg operation "$operation" \
      --arg secret_id "$secret_id" \
      '{
        gatewayBaseUrl:"http://fleet-broker:8787",
        keyId:$key_id,
        hmacKeyB64:{type:"secret_ref",secretId:$secret_id,version:"latest"},
        operation:$operation,
        paperclipApiUrl:"http://127.0.0.1:3100",
        timeoutMs:5000,
        allowPrivateHttp:true
      }'
  )"
  payload="$(
    jq -cn \
      --arg name "$agent_name" \
      --arg title "$title" \
      --arg capabilities "$capabilities" \
      --argjson adapter_config "$adapter_config" \
      '{
        name:$name,
        role:"general",
        title:$title,
        capabilities:$capabilities,
        adapterType:"ragnos_fleet",
        adapterConfig:$adapter_config,
        runtimeConfig:{heartbeat:{enabled:false,wakeOnDemand:true,maxConcurrentRuns:1,skipTimerWhenNoActionableWork:true}},
        budgetMonthlyCents:5000,
        permissions:{canAssignTasks:false,canCreateAgents:false,canCreateSkills:false}
      }'
  )"

  if [[ -z "$agent_id" ]]; then
    agent_id="$(pc agent create -C "$company_id" --payload-json "$payload" | jq -r '.id')"
  else
    payload="$(jq -c 'del(.permissions) + {replaceAdapterConfig:false}' <<<"$payload")"
    pc agent update "$agent_id" --payload-json "$payload" >/dev/null
    pc agent permissions:update "$agent_id" \
      --payload-json '{"canAssignTasks":false,"canCreateAgents":false,"canCreateSkills":false}' \
      >/dev/null
    if [[ "$agent_state" == "error" ]]; then
      clear_agent_error "$agent_id"
    fi
  fi
  pc budget agent:update "$agent_id" --payload-json '{"budgetMonthlyCents":5000}' >/dev/null
  printf '%s\n' "$agent_id"
}

ensure_project() {
  local company_id="$1"
  local project_name="$2"
  local project_description="$3"
  local project_id
  project_id="$(
    pc project list -C "$company_id" \
      | jq -r --arg name "$project_name" '.[] | select(.name == $name) | .id' \
      | head -1
  )"
  if [[ -z "$project_id" ]]; then
    project_id="$(
      pc project create -C "$company_id" \
        --name "$project_name" \
        --description "$project_description" \
        --status in_progress \
        | jq -r '.id'
    )"
  fi
  printf '%s\n' "$project_id"
}

ragnos_company_id="$(ensure_company \
  'RAGnos' \
  'Human-managed RAGnos work with approval-gated Fleet proposals and applies.')"
aibl_company_id="$(ensure_company \
  'AIBL' \
  'Human-managed AIBL work with tenant-isolated Fleet proposals and applies.')"

ragnos_secret_id="$(ensure_secret \
  "$ragnos_company_id" 'RAGnos Fleet HMAC' ragnos_fleet_hmac RAGNOS_PAPERCLIP_HMAC_KEY_B64)"
aibl_secret_id="$(ensure_secret \
  "$aibl_company_id" 'AIBL Fleet HMAC' aibl_fleet_hmac AIBL_PAPERCLIP_HMAC_KEY_B64)"

ragnos_proposer_id="$(ensure_agent \
  "$ragnos_company_id" 'RAGnos Proposer' propose ragnos-paperclip-local-v1 "$ragnos_secret_id" \
  'Fleet proposal employee' \
  'Creates bounded, non-authoritative Fleet proposals for human review.')"
ragnos_applier_id="$(ensure_agent \
  "$ragnos_company_id" 'RAGnos Applier' apply ragnos-paperclip-local-v1 "$ragnos_secret_id" \
  'Approval-gated Fleet apply employee' \
  'Applies only an approved structured Fleet proposal.')"
aibl_proposer_id="$(ensure_agent \
  "$aibl_company_id" 'AIBL Proposer' propose aibl-paperclip-local-v1 "$aibl_secret_id" \
  'Fleet proposal employee' \
  'Creates bounded, non-authoritative Fleet proposals for human review.')"
aibl_applier_id="$(ensure_agent \
  "$aibl_company_id" 'AIBL Applier' apply aibl-paperclip-local-v1 "$aibl_secret_id" \
  'Approval-gated Fleet apply employee' \
  'Applies only an approved structured Fleet proposal.')"

ragnos_project_id="$(ensure_project \
  "$ragnos_company_id" 'RAGnos Fleet Cutover' \
  'Human-controlled proposal, approval, and apply flow for RAGnos.')"
aibl_project_id="$(ensure_project \
  "$aibl_company_id" 'AIBL Fleet Cutover' \
  'Human-controlled proposal, approval, and apply flow for AIBL.')"

pc company update "$ragnos_company_id" \
  --payload-json '{"requireBoardApprovalForNewAgents":true}' >/dev/null
pc company update "$aibl_company_id" \
  --payload-json '{"requireBoardApprovalForNewAgents":true}' >/dev/null

jq -n \
  --arg ragnos_company_id "$ragnos_company_id" \
  --arg aibl_company_id "$aibl_company_id" \
  --arg ragnos_proposer_id "$ragnos_proposer_id" \
  --arg ragnos_applier_id "$ragnos_applier_id" \
  --arg aibl_proposer_id "$aibl_proposer_id" \
  --arg aibl_applier_id "$aibl_applier_id" \
  --arg ragnos_project_id "$ragnos_project_id" \
  --arg aibl_project_id "$aibl_project_id" \
  '{
    schema_version:"paperclip_ragnos_local_seed/v1",
    companies:{ragnos:$ragnos_company_id,aibl:$aibl_company_id},
    agents:{
      ragnos:{proposer:$ragnos_proposer_id,applier:$ragnos_applier_id},
      aibl:{proposer:$aibl_proposer_id,applier:$aibl_applier_id}
    },
    projects:{ragnos:$ragnos_project_id,aibl:$aibl_project_id},
    secret_values_printed:false,
    production_gateway_used:false
  }'
