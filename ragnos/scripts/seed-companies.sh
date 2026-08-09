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

safe_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$compose_env"
}

fleet_mode="$(safe_env_value PAPERCLIP_FLEET_MODE)"
gateway_base_url="$(safe_env_value PAPERCLIP_FLEET_GATEWAY_URL)"
apply_enabled="$(safe_env_value PAPERCLIP_FLEET_APPLY_ENABLED)"
ragnos_key_id="$(safe_env_value RAGNOS_FLEET_KEY_ID)"
aibl_key_id="$(safe_env_value AIBL_FLEET_KEY_ID)"
case "$fleet_mode" in
  real)
    [[ "$gateway_base_url" == "http://host.docker.internal:8771" ]] || {
      echo "ERROR: real local Fleet must use the Docker Desktop host gateway on port 8771" >&2
      exit 1
    }
    [[ "$ragnos_key_id" == "ragnos-mission-control-service-v1" && \
       "$aibl_key_id" == "aibl-deck-service-v1" ]] || {
      echo "ERROR: real local Fleet key IDs do not match the governed local policy" >&2
      exit 1
    }
    ;;
  fake)
    [[ "$gateway_base_url" == "http://fleet-broker:8787" ]] || {
      echo "ERROR: fake Fleet profile must use the internal fake broker" >&2
      exit 1
    }
    [[ "$ragnos_key_id" == "ragnos-paperclip-local-v1" && \
       "$aibl_key_id" == "aibl-paperclip-local-v1" ]] || {
      echo "ERROR: fake Fleet key IDs are invalid" >&2
      exit 1
    }
    ;;
  *)
    echo "ERROR: PAPERCLIP_FLEET_MODE must be real or fake" >&2
    exit 1
    ;;
esac
if [[ "$apply_enabled" != "true" && "$apply_enabled" != "false" ]]; then
  echo "ERROR: PAPERCLIP_FLEET_APPLY_ENABLED must be true or false" >&2
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
  local secrets_json
  local desired_hash
  local desired_description
  local current_description
  secrets_json="$(pc secrets list -C "$company_id")"
  secret_id="$(jq -r --arg key "$secret_key" \
    '.[] | select(.key == $key and .status == "active") | .id' <<<"$secrets_json" | head -1)"
  desired_hash="$("${compose[@]}" exec -T -e VALUE_ENV="$value_env" paperclip node -e '
    const crypto = require("crypto");
    const value = process.env[process.env.VALUE_ENV];
    if (!value) process.exit(2);
    process.stdout.write(crypto.createHash("sha256").update(value).digest("hex"));
  ')"
  desired_description="Fleet key binding paperclip_fleet_binding_sha256:$desired_hash"
  if [[ -z "$secret_id" ]]; then
    secret_id="$(
      pc secrets create -C "$company_id" \
        --name "$secret_name" \
        --key "$secret_key" \
        --provider local_encrypted \
        --value-env "$value_env" \
        --description "$desired_description" \
        | jq -r '.id'
    )"
  else
    current_description="$(jq -r --arg id "$secret_id" \
      '.[] | select(.id == $id) | .description // ""' <<<"$secrets_json")"
    if [[ "$current_description" != "$desired_description" ]]; then
      pc secrets rotate "$secret_id" --value-env "$value_env" >/dev/null
      pc secrets update "$secret_id" --payload-json "$(
        jq -cn --arg description "$desired_description" '{description:$description}'
      )" >/dev/null
    fi
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
  local execution_enabled="$8"
  local agents_json
  local agent_id
  local agent_state
  local adapter_config
  local payload
  local timeout_ms="5000"
  local poll_after_ms="50"

  if [[ "$fleet_mode" == "real" ]]; then
    timeout_ms="900000"
    poll_after_ms="4000"
  fi

  agents_json="$(pc agent list -C "$company_id")"
  agent_id="$(jq -r --arg name "$agent_name" '.[] | select(.name == $name) | .id' <<<"$agents_json" | head -1)"
  agent_state="$(jq -r --arg name "$agent_name" '.[] | select(.name == $name) | .status' <<<"$agents_json" | head -1)"
  adapter_config="$(
    jq -cn \
      --arg gateway_base_url "$gateway_base_url" \
      --arg key_id "$key_id" \
      --arg operation "$operation" \
      --arg secret_id "$secret_id" \
      --argjson poll_after_ms "$poll_after_ms" \
      --argjson timeout_ms "$timeout_ms" \
      '{
        gatewayBaseUrl:$gateway_base_url,
        keyId:$key_id,
        hmacKeyB64:{type:"secret_ref",secretId:$secret_id,version:"latest"},
        operation:$operation,
        paperclipApiUrl:"http://127.0.0.1:3100",
        pollAfterMs:$poll_after_ms,
        timeoutMs:$timeout_ms,
        allowPrivateHttp:true
      }'
  )"
  payload="$(
    jq -cn \
      --arg name "$agent_name" \
      --arg title "$title" \
      --arg capabilities "$capabilities" \
      --arg fleet_mode "$fleet_mode" \
      --arg operation "$operation" \
      --argjson execution_enabled "$execution_enabled" \
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
        permissions:{canAssignTasks:false,canCreateAgents:false,canCreateSkills:false},
        metadata:{
          ragnosFleet:{
            schemaVersion:"paperclip_ragnos_fleet_employee/v1",
            mode:$fleet_mode,
            operation:$operation,
            executionEnabled:$execution_enabled,
            credentialAuthority:"fleet_runtime",
            credentialsInline:false
          }
        }
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
  if [[ "$execution_enabled" == "true" ]]; then
    if [[ "$agent_state" == "paused" ]]; then
      pc agent resume "$agent_id" >/dev/null
    fi
  else
    pc agent pause "$agent_id" >/dev/null
  fi
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
  "$ragnos_company_id" 'RAGnos Proposer' propose "$ragnos_key_id" "$ragnos_secret_id" \
  'Fleet proposal employee' \
  'Creates bounded, non-authoritative Fleet proposals for human review.' true)"
ragnos_applier_id="$(ensure_agent \
  "$ragnos_company_id" 'RAGnos Applier' apply "$ragnos_key_id" "$ragnos_secret_id" \
  'Approval-gated Fleet apply employee' \
  'Applies only an approved structured Fleet proposal.' "$apply_enabled")"
aibl_proposer_id="$(ensure_agent \
  "$aibl_company_id" 'AIBL Proposer' propose "$aibl_key_id" "$aibl_secret_id" \
  'Fleet proposal employee' \
  'Creates bounded, non-authoritative Fleet proposals for human review.' true)"
aibl_applier_id="$(ensure_agent \
  "$aibl_company_id" 'AIBL Applier' apply "$aibl_key_id" "$aibl_secret_id" \
  'Approval-gated Fleet apply employee' \
  'Applies only an approved structured Fleet proposal.' "$apply_enabled")"

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
  --arg fleet_mode "$fleet_mode" \
  --arg gateway_base_url "$gateway_base_url" \
  --argjson apply_enabled "$apply_enabled" \
  '{
    schema_version:"paperclip_ragnos_local_seed/v1",
    companies:{ragnos:$ragnos_company_id,aibl:$aibl_company_id},
    agents:{
      ragnos:{proposer:$ragnos_proposer_id,applier:$ragnos_applier_id},
      aibl:{proposer:$aibl_proposer_id,applier:$aibl_applier_id}
    },
    projects:{ragnos:$ragnos_project_id,aibl:$aibl_project_id},
    fleet_mode:$fleet_mode,
    gateway_base_url:$gateway_base_url,
    apply_enabled:$apply_enabled,
    secret_values_printed:false,
    production_gateway_used:false,
    fake_gateway_used:($fleet_mode == "fake")
  }'
