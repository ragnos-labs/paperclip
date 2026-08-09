import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const composeText = readFileSync(new URL("../compose.yaml", import.meta.url), "utf8");
const seedText = readFileSync(new URL("../scripts/seed-companies.sh", import.meta.url), "utf8");

function parseEnv(text) {
  return Object.fromEntries(text.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

test("real local Compose excludes the fake broker and uses only loopback host bindings", () => {
  assert.match(composeText, /fleet-broker:\n\s+profiles:\n\s+- fake/);
  assert.doesNotMatch(composeText, /depends_on:[\s\S]*fleet-broker:\n\s+condition:/);
  assert.match(composeText, /PAPERCLIP_FLEET_GATEWAY_URL:[^\n]*host\.docker\.internal:8771/);
  assert.match(composeText, /"127\.0\.0\.1:3100:3100"/);
  assert.doesNotMatch(composeText, /(?:^|\s)8771:8771/);
});

test("real Fleet employees allow bounded Codex jobs to outlive fake-broker polling", () => {
  assert.match(seedText, /local timeout_ms="5000"/);
  assert.match(seedText, /local poll_after_ms="50"/);
  assert.match(seedText, /if \[\[ "\$fleet_mode" == "real" \]\]; then\s+timeout_ms="900000"/);
  assert.match(seedText, /timeout_ms="900000"\s+poll_after_ms="4000"/);
  assert.match(seedText, /--argjson poll_after_ms "\$poll_after_ms"/);
  assert.match(seedText, /--argjson timeout_ms "\$timeout_ms"/);
  assert.match(seedText, /pollAfterMs:\$poll_after_ms/);
  assert.match(seedText, /timeoutMs:\$timeout_ms/);
});

test("local Fleet render preserves Paperclip state and imports only canonical HMAC credentials", (t) => {
  const root = mkdtempSync(join(tmpdir(), "paperclip-real-fleet-profile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "ragnos", "scripts");
  const secrets = join(root, "fleet", "secrets");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(secrets, { recursive: true });
  const render = join(scripts, "render-secrets.sh");
  copyFileSync(new URL("../scripts/render-secrets.sh", import.meta.url), render);
  chmodSync(render, 0o755);

  const ragnosKey = Buffer.alloc(32, 17).toString("base64url");
  const aiblKey = Buffer.alloc(32, 29).toString("base64url");
  writeFileSync(join(secrets, "paperclip-ragnos.credential.json"), JSON.stringify({
    hmac_key_b64: ragnosKey,
    key_id: "ragnos-mission-control-service-v1",
  }), { mode: 0o600 });
  writeFileSync(join(secrets, "paperclip-aibl.credential.json"), JSON.stringify({
    hmac_key_b64: aiblKey,
    key_id: "aibl-deck-service-v1",
  }), { mode: 0o600 });
  const prior = join(root, "prior.env");
  writeFileSync(prior, [
    "PAPERCLIP_SESSION_SECRET=session-preserved",
    "PAPERCLIP_AGENT_JWT_SECRET=jwt-preserved",
    "PAPERCLIP_TOOL_SIGNING_SECRET=tool-preserved",
    "PAPERCLIP_DB_PASSWORD=db-preserved",
    "PAPERCLIP_BACKUP_PASSPHRASE=backup-preserved",
    "",
  ].join("\n"), { mode: 0o600 });

  const stdout = execFileSync(render, [
    "--local-fleet-runtime", join(root, "fleet"),
    "--paperclip-env-source", prior,
  ], { encoding: "utf8" });
  const rendered = parseEnv(readFileSync(join(root, "ragnos", ".runtime", "compose.env"), "utf8"));
  assert.equal(rendered.PAPERCLIP_FLEET_MODE, "real");
  assert.equal(rendered.PAPERCLIP_FLEET_GATEWAY_URL, "http://host.docker.internal:8771");
  assert.equal(rendered.PAPERCLIP_FLEET_APPLY_ENABLED, "false");
  assert.equal(rendered.RAGNOS_FLEET_KEY_ID, "ragnos-mission-control-service-v1");
  assert.equal(rendered.AIBL_FLEET_KEY_ID, "aibl-deck-service-v1");
  assert.equal(rendered.RAGNOS_PAPERCLIP_HMAC_KEY_B64, ragnosKey);
  assert.equal(rendered.AIBL_PAPERCLIP_HMAC_KEY_B64, aiblKey);
  assert.equal(rendered.FLEET_FAKE_KEYS_JSON, "{}");
  assert.equal(rendered.PAPERCLIP_SESSION_SECRET, "session-preserved");
  assert.equal(rendered.PAPERCLIP_DB_PASSWORD, "db-preserved");
  assert.doesNotMatch(stdout, new RegExp(ragnosKey));
  assert.doesNotMatch(stdout, /session-preserved|db-preserved/);
});
