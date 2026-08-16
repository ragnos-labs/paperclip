#!/usr/bin/env bash
set -euo pipefail

image_ref="${1:?usage: scripts/smoke/work-projection-canary.sh IMAGE_REFERENCE}"
company_id="${PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID:-11111111-1111-4111-8111-111111111111}"
resource_suffix="${PAPERCLIP_WORK_PROJECTION_CANARY_RESOURCE_SUFFIX:-$$}"
network_name="paperclip-wp-canary-${resource_suffix}"
server_names=()

cleanup() {
  local server_name
  for server_name in "${server_names[@]:-}"; do
    if docker inspect "$server_name" >/dev/null 2>&1; then
      docker stop --time 5 "$server_name" >/dev/null 2>&1 || true
      docker rm "$server_name" >/dev/null 2>&1 || true
    fi
  done
  if docker network inspect "$network_name" >/dev/null 2>&1; then
    docker network rm "$network_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

docker network create --internal "$network_name" >/dev/null
if [ "$(docker network inspect "$network_name" --format '{{.Internal}}')" != "true" ]; then
  echo "Canary network is not internal." >&2
  exit 1
fi

derive_token() {
  local fixture="$1"
  docker run --rm \
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
  output="$(docker run "${args[@]}")"
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
  local server_name="paperclip-wp-${fixture}-${resource_suffix}"
  local before_body
  local before_diff
  local first_body
  local cursor
  local encoded_cursor
  token="$(derive_token "$fixture")"
  server_names+=("$server_name")

  docker run --detach \
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
    server/dist/canary/work-projection-server.js >/dev/null

  if [ "$(docker inspect "$server_name" --format '{{.HostConfig.ReadonlyRootfs}}')" != "true" ]; then
    echo "Canary root filesystem is not read-only." >&2
    exit 1
  fi
  if [ "$(docker inspect "$server_name" --format '{{len .Mounts}}')" != "0" ]; then
    echo "Canary container unexpectedly has mounts." >&2
    exit 1
  fi
  if [ "$(docker inspect "$server_name" --format '{{.Config.User}}')" != "65532:65532" ]; then
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
  before_diff="$(docker diff "$server_name")"
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

  if [ "$(docker diff "$server_name")" != "$before_diff" ] || [ -n "$before_diff" ]; then
    echo "Canary container filesystem changed." >&2
    docker diff "$server_name" >&2
    exit 1
  fi

  docker stop --time 5 "$server_name" >/dev/null
  docker logs "$server_name" | jq -e -s '
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
  docker rm "$server_name" >/dev/null
}

run_fixture empty
run_fixture synthetic

jq -n \
  --arg contract "paperclip.company-work-projection-canary/v1" \
  --arg image "$image_ref" \
  --arg companyId "$company_id" \
  '{
    status: "passed",
    contract: $contract,
    image: $image,
    companyId: $companyId,
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
    schedulerTasks: 0
  }'
