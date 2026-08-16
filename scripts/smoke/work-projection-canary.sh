#!/usr/bin/env bash
set -euo pipefail

image_ref=""
company_id="11111111-1111-4111-8111-111111111111"
run_id=""
run_id_label_key="com.paperclipai.work-projection-canary.run-id"
run_id_label=""
network_name=""
network_id=""
server_names=()
server_ids=()
ownership_started=0
cleanup_verified=0

generate_run_id() {
  LC_ALL=C od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]'
}

initialize_run() {
  run_id="$(generate_run_id)"
  if [[ ! "$run_id" =~ ^[0-9a-f]{32}$ ]]; then
    echo "Failed to generate a 128-bit canary run ID." >&2
    return 1
  fi
  run_id_label="${run_id_label_key}=${run_id}"
  network_name="paperclip-wp-canary-${run_id}"
  server_names=("paperclip-wp-empty-${run_id}" "paperclip-wp-synthetic-${run_id}")
  network_id=""
  server_ids=()
  ownership_started=0
  cleanup_verified=0
}

preflight_target_names() {
  local existing_networks
  local existing_containers
  local existing
  local target

  if ! existing_networks="$(docker network ls --format '{{.Name}}')"; then
    echo "Could not list Docker networks for collision preflight." >&2
    return 1
  fi
  if ! existing_containers="$(docker container ls --all --format '{{.Names}}')"; then
    echo "Could not list Docker containers for collision preflight." >&2
    return 1
  fi

  while IFS= read -r existing; do
    if [ "$existing" = "$network_name" ]; then
      echo "Refusing to use pre-existing Docker network: ${network_name}" >&2
      return 1
    fi
  done <<< "$existing_networks"
  for target in "${server_names[@]}"; do
    while IFS= read -r existing; do
      if [ "$existing" = "$target" ]; then
        echo "Refusing to use pre-existing Docker container: ${target}" >&2
        return 1
      fi
    done <<< "$existing_containers"
  done
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

network_exists() {
  docker network inspect "$1" >/dev/null 2>&1
}

container_has_run_label() {
  [ "$(docker container inspect "$1" --format "{{ index .Config.Labels \"${run_id_label_key}\" }}")" = "$run_id" ]
}

network_has_run_label() {
  [ "$(docker network inspect "$1" --format "{{ index .Labels \"${run_id_label_key}\" }}")" = "$run_id" ]
}

append_unique() {
  local candidate="$1"
  shift
  local existing
  for existing in "$@"; do
    if [ "$existing" = "$candidate" ]; then
      return 1
    fi
  done
  return 0
}

cleanup_owned_resources() {
  local cleanup_status=0
  local discovered_container_ids=""
  local discovered_network_ids=""
  local resource_id
  local -a container_candidates=()
  local -a network_candidates=()

  if [ "$ownership_started" -eq 0 ]; then
    return 0
  fi

  for resource_id in "${server_ids[@]:-}"; do
    [ -n "$resource_id" ] && container_candidates+=("$resource_id")
  done

  if ! discovered_container_ids="$(docker ps --all --quiet --filter "label=${run_id_label}")"; then
    echo "Could not list run-labeled Docker containers during cleanup." >&2
    cleanup_status=1
  else
    for resource_id in $discovered_container_ids; do
      if append_unique "$resource_id" "${container_candidates[@]:-}"; then
        container_candidates+=("$resource_id")
      fi
    done
  fi

  if [ -n "$network_id" ]; then
    network_candidates+=("$network_id")
  fi
  if ! discovered_network_ids="$(docker network ls --quiet --filter "label=${run_id_label}")"; then
    echo "Could not list run-labeled Docker networks during cleanup." >&2
    cleanup_status=1
  else
    for resource_id in $discovered_network_ids; do
      if append_unique "$resource_id" "${network_candidates[@]:-}"; then
        network_candidates+=("$resource_id")
      fi
    done
  fi

  for resource_id in "${container_candidates[@]:-}"; do
    [ -n "$resource_id" ] || continue
    if ! container_exists "$resource_id"; then
      continue
    fi
    if ! container_has_run_label "$resource_id"; then
      echo "Refusing to remove container without expected run label: ${resource_id}" >&2
      cleanup_status=1
      continue
    fi
    if ! docker rm --force "$resource_id" >/dev/null; then
      echo "Failed to remove owned canary container: ${resource_id}" >&2
      cleanup_status=1
    fi
  done

  for resource_id in "${network_candidates[@]:-}"; do
    [ -n "$resource_id" ] || continue
    if ! network_exists "$resource_id"; then
      continue
    fi
    if ! network_has_run_label "$resource_id"; then
      echo "Refusing to remove network without expected run label: ${resource_id}" >&2
      cleanup_status=1
      continue
    fi
    if ! docker network rm "$resource_id" >/dev/null; then
      echo "Failed to remove owned canary network: ${resource_id}" >&2
      cleanup_status=1
    fi
  done

  return "$cleanup_status"
}

verify_owned_resources_absent() {
  local verification_status=0
  local resource_id
  local remaining

  if [ "$ownership_started" -eq 0 ]; then
    return 0
  fi

  for resource_id in "${server_ids[@]:-}"; do
    if container_exists "$resource_id"; then
      echo "Owned canary container remains after cleanup: ${resource_id}" >&2
      verification_status=1
    fi
  done
  if [ -n "$network_id" ] && network_exists "$network_id"; then
    echo "Owned canary network remains after cleanup: ${network_id}" >&2
    verification_status=1
  fi

  if ! remaining="$(docker ps --all --quiet --filter "label=${run_id_label}")"; then
    echo "Could not verify run-labeled Docker containers are absent." >&2
    verification_status=1
  elif [ -n "$remaining" ]; then
    echo "Run-labeled Docker containers remain after cleanup: ${remaining}" >&2
    verification_status=1
  fi
  if ! remaining="$(docker network ls --quiet --filter "label=${run_id_label}")"; then
    echo "Could not verify run-labeled Docker networks are absent." >&2
    verification_status=1
  elif [ -n "$remaining" ]; then
    echo "Run-labeled Docker networks remain after cleanup: ${remaining}" >&2
    verification_status=1
  fi

  return "$verification_status"
}

cleanup_and_verify() {
  local cleanup_status=0
  cleanup_owned_resources || cleanup_status=$?
  verify_owned_resources_absent || cleanup_status=$?
  if [ "$cleanup_status" -eq 0 ]; then
    cleanup_verified=1
  fi
  return "$cleanup_status"
}

handle_exit() {
  local exit_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  if [ "$cleanup_verified" -ne 1 ]; then
    cleanup_and_verify || cleanup_status=$?
    if [ "$exit_status" -eq 0 ] && [ "$cleanup_status" -ne 0 ]; then
      exit_status="$cleanup_status"
    fi
  fi
  exit "$exit_status"
}

handle_signal() {
  local exit_status="$1"
  trap - INT TERM
  exit "$exit_status"
}

install_cleanup_traps() {
  trap handle_exit EXIT
  trap 'handle_signal 130' INT
  trap 'handle_signal 143' TERM
}

create_canary_network() {
  local created_id
  if ! created_id="$(docker network create \
    --internal \
    --label "$run_id_label" \
    "$network_name")"; then
    echo "Failed to create canary network: ${network_name}" >&2
    return 1
  fi
  network_id="$created_id"
  ownership_started=1
  if ! network_has_run_label "$network_id"; then
    echo "Created canary network is missing its expected run label." >&2
    return 1
  fi
}

derive_token() {
  local fixture="$1"
  docker run --rm \
    --label "$run_id_label" \
    --network none \
    --read-only \
    --user 65532:65532 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --entrypoint node \
    -e CANARY_COMPANY_ID="$company_id" \
    -e CANARY_FIXTURE="$fixture" \
    -e TSX_DISABLE_CACHE=1 \
    "$image_ref" \
    --import ./server/node_modules/tsx/dist/loader.mjs \
    --input-type=module \
    --eval 'import { deriveCompanyWorkProjectionCanaryToken as derive } from "./server/dist/canary/company-work-projection-app.js"; process.stdout.write(derive(process.env.CANARY_COMPANY_ID, process.env.CANARY_FIXTURE));'
}

http_get() {
  local server_name="$1"
  local path="$2"
  local token="${3:-}"
  local output
  local args=(
    --rm
    --network "$network_name"
    --read-only
    --user 65532:65532
    --cap-drop ALL
    --security-opt no-new-privileges
    --entrypoint curl
    "$image_ref"
    --silent
    --show-error
    --write-out $'\n%{http_code}'
  )
  if [ -n "$token" ]; then
    args+=(--header "Authorization: Bearer ${token}")
  fi
  args+=("http://${server_name}:3100${path}")
  output="$(docker run --label "$run_id_label" "${args[@]}")"
  HTTP_STATUS="${output##*$'\n'}"
  HTTP_BODY="${output%$'\n'*}"
}

assert_status() {
  local expected="$1"
  if [ "$HTTP_STATUS" != "$expected" ]; then
    echo "Expected HTTP ${expected}, received ${HTTP_STATUS}: ${HTTP_BODY}" >&2
    exit 1
  fi
}

run_fixture() {
  local fixture="$1"
  local token
  local server_name="paperclip-wp-${fixture}-${run_id}"
  local server_id
  local before_body
  local before_diff
  local first_body
  local cursor
  local encoded_cursor
  token="$(derive_token "$fixture")"

  if ! server_id="$(docker run --detach \
    --label "$run_id_label" \
    --name "$server_name" \
    --network "$network_name" \
    --read-only \
    --user 65532:65532 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --pids-limit 64 \
    --memory 256m \
    --entrypoint node \
    -e HOST=0.0.0.0 \
    -e PORT=3100 \
    -e TSX_DISABLE_CACHE=1 \
    -e PAPERCLIP_INSTANCE_ID=work-projection-canary \
    -e PAPERCLIP_WORK_PROJECTION_CANARY_ACK=NON_PRODUCTION_GET_ONLY \
    -e PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID="$company_id" \
    -e PAPERCLIP_WORK_PROJECTION_CANARY_FIXTURE="$fixture" \
    -e PAPERCLIP_WORK_PROJECTION_CANARY_TOKEN="$token" \
    "$image_ref" \
    --import ./server/node_modules/tsx/dist/loader.mjs \
    server/dist/canary/work-projection-server.js)"; then
    echo "Failed to create canary server container: ${server_name}" >&2
    return 1
  fi
  server_ids+=("$server_id")
  if ! container_has_run_label "$server_id"; then
    echo "Created canary server is missing its expected run label." >&2
    return 1
  fi

  if [ "$(docker container inspect "$server_id" --format '{{.HostConfig.ReadonlyRootfs}}')" != "true" ]; then
    echo "Canary root filesystem is not read-only." >&2
    exit 1
  fi
  if [ "$(docker container inspect "$server_id" --format '{{len .Mounts}}')" != "0" ]; then
    echo "Canary container unexpectedly has mounts." >&2
    exit 1
  fi
  if [ "$(docker container inspect "$server_id" --format '{{.Config.User}}')" != "65532:65532" ]; then
    echo "Canary container is not running as the requested non-root user." >&2
    exit 1
  fi

  for _attempt in $(seq 1 30); do
    if http_get "$server_name" "/api/health" 2>/dev/null && [ "$HTTP_STATUS" = "200" ]; then
      break
    fi
    sleep 1
  done
  assert_status 200
  before_body="$HTTP_BODY"
  before_diff="$(docker diff "$server_id")"
  jq -e --arg fixture "$fixture" '
    .status == "ok"
    and .canary.fixture == $fixture
    and .canary.database == {connections: 0, tables: 0, writes: 0}
    and .canary.filesystem == {persistentFiles: 0, writes: 0}
    and .canary.providerMutations == 0
    and .canary.schedulerTasks == 0
  ' <<< "$before_body" >/dev/null

  http_get "$server_name" "/api/v2/companies/${company_id}/work-projection"
  assert_status 401
  jq -e '.code == "WORK_PROJECTION_UNAUTHORIZED"' <<< "$HTTP_BODY" >/dev/null

  http_get "$server_name" "/api/v2/companies/${company_id}/work-projection" "pcwp_v2_ffffffffffffffffffffffffffffffffffffffffffffffff"
  assert_status 401
  jq -e '.code == "WORK_PROJECTION_UNAUTHORIZED"' <<< "$HTTP_BODY" >/dev/null

  http_get "$server_name" "/api/v2/companies/99999999-9999-4999-8999-999999999999/work-projection" "$token"
  assert_status 403
  jq -e '.code == "WORK_PROJECTION_FORBIDDEN"' <<< "$HTTP_BODY" >/dev/null

  http_get "$server_name" "/api/v1/companies/${company_id}/work-projection" "$token"
  assert_status 403
  jq -e '.code == "WORK_PROJECTION_FORBIDDEN"' <<< "$HTTP_BODY" >/dev/null

  if [ "$fixture" = "empty" ]; then
    http_get "$server_name" "/api/v2/companies/${company_id}/work-projection" "$token"
    assert_status 200
    jq -e '
      .apiVersion == "paperclip.company-work-projection/v2"
      and .items == []
      and .page == {size: 0, hasMore: false, nextCursor: null, completeness: "complete"}
    ' <<< "$HTTP_BODY" >/dev/null
  else
    http_get "$server_name" "/api/v2/companies/${company_id}/work-projection?pageSize=2" "$token"
    assert_status 200
    first_body="$HTTP_BODY"
    jq -e '
      .snapshot == {revision: "3", issuedAt: "2026-08-16T00:00:00.000Z", expiresAt: "2026-08-16T00:05:00.000Z"}
      and (.items | map(.identifier)) == ["CANARY-1", "CANARY-2"]
      and .page.size == 2
      and .page.hasMore == true
      and .page.completeness == "partial"
      and (.page.nextCursor | type) == "string"
      and (.items | map(.packetContext.sourceReceipt.issuedAt)) == ["2026-08-16T00:00:01.000Z", "2026-08-16T00:00:02.000Z"]
    ' <<< "$first_body" >/dev/null

    http_get "$server_name" "/api/v2/companies/${company_id}/work-projection?pageSize=2" "$token"
    assert_status 200
    if [ "$(jq -S . <<< "$HTTP_BODY")" != "$(jq -S . <<< "$first_body")" ]; then
      echo "Synthetic first-page replay was not deterministic." >&2
      exit 1
    fi

    cursor="$(jq -r '.page.nextCursor' <<< "$first_body")"
    encoded_cursor="$(jq -rn --arg value "$cursor" '$value | @uri')"
    http_get "$server_name" "/api/v2/companies/${company_id}/work-projection?cursor=${encoded_cursor}" "$token"
    assert_status 200
    jq -e '
      (.items | map(.identifier)) == ["CANARY-3"]
      and .page == {size: 1, hasMore: false, nextCursor: null, completeness: "complete"}
    ' <<< "$HTTP_BODY" >/dev/null
  fi

  http_get "$server_name" "/api/health"
  assert_status 200
  jq -e --arg digest "$(jq -r '.canary.stateDigest' <<< "$before_body")" '
    .canary.stateDigest == $digest
    and .canary.database == {connections: 0, tables: 0, writes: 0}
    and .canary.filesystem == {persistentFiles: 0, writes: 0}
    and .canary.providerMutations == 0
    and .canary.schedulerTasks == 0
    and (.canary.requestMethods | keys) == ["GET"]
    and all(.canary.requestPaths[];
      . == "/api/health"
      or test("^/api/v[12]/companies/[0-9a-f-]+/work-projection$")
    )
  ' <<< "$HTTP_BODY" >/dev/null

  if [ "$(docker diff "$server_id")" != "$before_diff" ] || [ -n "$before_diff" ]; then
    echo "Canary container filesystem changed." >&2
    docker diff "$server_id" >&2
    exit 1
  fi

  docker stop --time 5 "$server_id" >/dev/null
  docker logs "$server_id" | jq -e -s '
    any(.[]; .event == "work_projection_canary_ready")
    and any(.[];
      .event == "work_projection_canary_stopped"
      and .databaseConnections == 0
      and .databaseWrites == 0
      and .persistentFileWrites == 0
      and .providerMutations == 0
      and .schedulerTasks == 0
    )
  ' >/dev/null
}

emit_pass_receipt() {
  jq -n \
  --arg contract "paperclip.company-work-projection-canary/v1" \
  --arg image "$image_ref" \
  --arg companyId "$company_id" \
  --arg runId "$run_id" \
  '{
    status: "passed",
    contract: $contract,
    image: $image,
    companyId: $companyId,
    runId: $runId,
    fixtures: ["empty", "synthetic"],
    transport: "internal-container-network-only",
    user: "65532:65532",
    hostMounts: 0,
    requestMethods: ["GET"],
    databaseConnections: 0,
    databaseTables: 0,
    databaseWrites: 0,
    persistentFileWrites: 0,
    providerMutations: 0,
    schedulerTasks: 0,
    cleanup: {
      status: "verified",
      containersRemaining: 0,
      networksRemaining: 0
    }
  }'
}

complete_success() {
  if ! cleanup_and_verify; then
    echo "Canary cleanup or absence verification failed; no pass receipt emitted." >&2
    return 1
  fi
  trap - EXIT INT TERM
  emit_pass_receipt
}

main() {
  image_ref="${1:?usage: scripts/smoke/work-projection-canary.sh IMAGE_REFERENCE}"
  company_id="${PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID:-11111111-1111-4111-8111-111111111111}"
  initialize_run
  install_cleanup_traps
  preflight_target_names
  create_canary_network

  if [ "$(docker network inspect "$network_id" --format '{{.Internal}}')" != "true" ]; then
    echo "Canary network is not internal." >&2
    return 1
  fi

  run_fixture empty
  run_fixture synthetic
  complete_success
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
