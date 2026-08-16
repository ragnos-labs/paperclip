import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("./work-projection-canary.sh", import.meta.url));
const scriptSource = readFileSync(scriptPath, "utf8");

function runBash(body) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "paperclip-wp-canary-test-"));
  const result = spawnSync("/bin/bash", ["-c", body], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      CANARY_SCRIPT_PATH: scriptPath,
      DOCKER_LOG: path.join(tempDir, "docker.log"),
    },
  });
  const dockerLog = readFileSync(path.join(tempDir, "docker.log"), {
    encoding: "utf8",
    flag: "a+",
  });
  rmSync(tempDir, { recursive: true, force: true });
  return { ...result, dockerLog };
}

const sourceHarness = 'source "$CANARY_SCRIPT_PATH"\ninitialize_run';

test("run IDs are non-overridable collision-resistant 128-bit values", () => {
  const result = runBash(`
    ${sourceHarness}
    first="$run_id"
    initialize_run
    printf '%s\\n%s\\n' "$first" "$run_id"
  `);

  assert.equal(result.status, 0, result.stderr);
  const [first, second] = result.stdout.trim().split("\n");
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.match(second, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second);
  assert.doesNotMatch(scriptSource, /PAPERCLIP_WORK_PROJECTION_CANARY_RESOURCE_SUFFIX/);
});

test("pre-existing network and container names fail closed without removal", () => {
  for (const collision of ["network", "container"]) {
    const result = runBash(`
      docker() {
        printf '%s\\n' "$*" >> "$DOCKER_LOG"
        if [ "$1 $2" = "network ls" ]; then
          [ "${collision}" = network ] && printf '%s\\n' "$network_name"
          return 0
        fi
        if [ "$1 $2" = "container ls" ]; then
          [ "${collision}" = container ] && printf '%s\\n' "\${server_names[0]}"
          return 0
        fi
        return 1
      }
      ${sourceHarness}
      if preflight_target_names; then
        echo "collision was accepted" >&2
        exit 90
      fi
    `);

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.dockerLog, /(^| )(rm|stop)( |$)/m);
    assert.doesNotMatch(result.stdout, /"status":\s*"passed"/);
  }
});

test("a failed network create never records or removes the colliding network", () => {
  const result = runBash(`
    docker() {
      printf '%s\\n' "$*" >> "$DOCKER_LOG"
      if [ "$1 $2" = "network ls" ] || [ "$1 $2" = "container ls" ]; then return 0; fi
      if [ "$1 $2" = "network create" ]; then return 1; fi
      return 1
    }
    ${sourceHarness}
    preflight_target_names
    if create_canary_network; then exit 91; fi
    cleanup_and_verify
    [ -z "$network_id" ]
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.dockerLog, /network rm/);
});

test("a create-time server name collision removes only the already-owned network", () => {
  const result = runBash(`
    owned_network_exists=1
    docker() {
      printf '%s\\n' "$*" >> "$DOCKER_LOG"
      if [ "$1 $2" = "run --rm" ]; then printf '%s\\n' synthetic-token; return 0; fi
      if [ "$1 $2" = "run --detach" ]; then return 1; fi
      if [ "$1 $2" = "network inspect" ] && [ "$3" = owned-network-id ]; then
        [ "$owned_network_exists" -eq 1 ] || return 1
        if [ "\${4:-}" = --format ]; then printf '%s\\n' "$run_id"; fi
        return 0
      fi
      if [ "$1 $2" = "network rm" ] && [ "$3" = owned-network-id ]; then
        owned_network_exists=0
        return 0
      fi
      if [ "$1 $2" = "network ls" ]; then
        [ "$owned_network_exists" -eq 1 ] && printf '%s\\n' owned-network-id
        return 0
      fi
      if [ "$1" = ps ]; then return 0; fi
      return 1
    }
    ${sourceHarness}
    image_ref=test-image
    network_id=owned-network-id
    ownership_started=1
    if run_fixture empty; then exit 93; fi
    cleanup_and_verify
    [ "\${#server_ids[@]}" -eq 0 ]
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.dockerLog, /run --detach/);
  assert.match(result.dockerLog, /network rm owned-network-id/);
  assert.doesNotMatch(result.dockerLog, /rm --force/);
});

test("cleanup failure prevents a pass receipt", () => {
  const result = runBash(`
    docker() {
      printf '%s\\n' "$*" >> "$DOCKER_LOG"
      if [ "$1 $2" = "network inspect" ] && [ "$3" = owned-network-id ]; then
        if [ "\${4:-}" = --format ]; then printf '%s\\n' "$run_id"; fi
        return 0
      fi
      if [ "$1 $2" = "network rm" ]; then return 1; fi
      if [ "$1 $2" = "network ls" ]; then printf '%s\\n' owned-network-id; return 0; fi
      if [ "$1" = ps ]; then return 0; fi
      return 1
    }
    ${sourceHarness}
    image_ref=test-image
    network_id=owned-network-id
    ownership_started=1
    complete_success
  `);

  assert.notEqual(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /"status":\s*"passed"/);
  assert.match(result.dockerLog, /network rm owned-network-id/);
});

test("successful completion removes owned resources and preserves an unrelated container", () => {
  const result = runBash(`
    owned_container_exists=1
    owned_network_exists=1
    foreign_container_exists=1
    docker() {
      printf '%s\\n' "$*" >> "$DOCKER_LOG"
      if [ "$1 $2" = "container inspect" ]; then
        if [ "$3" = owned-container-id ]; then
          [ "$owned_container_exists" -eq 1 ] || return 1
          if [ "\${4:-}" = --format ]; then printf '%s\\n' "$run_id"; fi
          return 0
        fi
        if [ "$3" = foreign-container-id ]; then
          [ "$foreign_container_exists" -eq 1 ] || return 1
          if [ "\${4:-}" = --format ]; then printf '%s\\n' foreign-run-id; fi
          return 0
        fi
        return 1
      fi
      if [ "$1 $2" = "network inspect" ] && [ "$3" = owned-network-id ]; then
        [ "$owned_network_exists" -eq 1 ] || return 1
        if [ "\${4:-}" = --format ]; then printf '%s\\n' "$run_id"; fi
        return 0
      fi
      if [ "$1 $2" = "rm --force" ] && [ "$3" = owned-container-id ]; then
        owned_container_exists=0
        return 0
      fi
      if [ "$1 $2" = "network rm" ] && [ "$3" = owned-network-id ]; then
        owned_network_exists=0
        return 0
      fi
      if [ "$1" = ps ]; then
        [ "$owned_container_exists" -eq 1 ] && printf '%s\\n' owned-container-id
        return 0
      fi
      if [ "$1 $2" = "network ls" ]; then
        [ "$owned_network_exists" -eq 1 ] && printf '%s\\n' owned-network-id
        return 0
      fi
      return 1
    }
    ${sourceHarness}
    image_ref=test-image
    server_ids=(owned-container-id)
    network_id=owned-network-id
    ownership_started=1
    complete_success
    container_exists foreign-container-id
    [ "$owned_container_exists" -eq 0 ]
    [ "$owned_network_exists" -eq 0 ]
    [ "$foreign_container_exists" -eq 1 ]
  `);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"status":\s*"passed"/);
  assert.match(result.stdout, /"status":\s*"verified"/);
  assert.match(result.dockerLog, /rm --force owned-container-id/);
  assert.match(result.dockerLog, /network rm owned-network-id/);
  assert.match(result.dockerLog, /container inspect foreign-container-id/);
  assert.doesNotMatch(result.dockerLog, /rm --force foreign-container-id/);
  assert.ok(
    result.dockerLog.lastIndexOf("network ls") > result.dockerLog.indexOf("network rm owned-network-id"),
    "absence verification must run after removal",
  );
});

test("TERM exits after cleanup and cannot continue to a pass receipt", () => {
  const result = runBash(`
    owned_network_exists=1
    docker() {
      printf '%s\\n' "$*" >> "$DOCKER_LOG"
      if [ "$1 $2" = "network inspect" ] && [ "$3" = owned-network-id ]; then
        [ "$owned_network_exists" -eq 1 ] || return 1
        if [ "\${4:-}" = --format ]; then printf '%s\\n' "$run_id"; fi
        return 0
      fi
      if [ "$1 $2" = "network rm" ]; then owned_network_exists=0; return 0; fi
      if [ "$1 $2" = "network ls" ]; then
        [ "$owned_network_exists" -eq 1 ] && printf '%s\\n' owned-network-id
        return 0
      fi
      if [ "$1" = ps ]; then return 0; fi
      return 1
    }
    ${sourceHarness}
    network_id=owned-network-id
    ownership_started=1
    install_cleanup_traps
    kill -TERM $$
    echo 'continued-after-signal'
    complete_success
  `);

  assert.equal(result.status, 143, result.stderr);
  assert.match(result.dockerLog, /network rm owned-network-id/);
  assert.doesNotMatch(result.stdout, /continued-after-signal|"status":\s*"passed"/);
});

test("every canary Docker resource creation carries the exact run label", () => {
  assert.match(scriptSource, /docker network create[\s\S]*?--label "\$run_id_label"/);
  const dockerRuns = [...scriptSource.matchAll(/docker run /g)];
  const labeledRuns = [...scriptSource.matchAll(/docker run[\s\S]*?--label "\$run_id_label"/g)];
  assert.ok(dockerRuns.length >= 3, "token, HTTP, and server containers must be present");
  assert.equal(labeledRuns.length, dockerRuns.length);
});
