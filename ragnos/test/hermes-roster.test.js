import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../hermes-roster.json", import.meta.url), "utf8"));
const dockerignore = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8");

test("excludes nested runtime material from the Docker build context", () => {
  assert.match(dockerignore, /^\*\*\/\.runtime\/$/m);
});

test("selects exactly the frozen live Hermes roster without duplicates", () => {
  assert.equal(manifest.schema_version, "paperclip_ragnos_hermes_roster/v1");
  assert.equal(manifest.expected_live_count, 37);
  assert.equal(manifest.profiles.length, 37);
  const ids = manifest.profiles.map((profile) => profile.profile_id);
  assert.equal(new Set(ids).size, 37);
  assert.ok(manifest.profiles.every((profile) => profile.lifecycle.includes("live")));
});

test("keeps non-live profiles outside the imported roster", () => {
  const live = new Set(manifest.profiles.map((profile) => profile.profile_id));
  assert.ok(manifest.excluded_profiles.length > 0);
  assert.ok(manifest.excluded_profiles.every((profile) => !live.has(profile.profile_id)));
  assert.equal(
    new Set(manifest.excluded_profiles.map((profile) => profile.profile_id)).size,
    manifest.excluded_profiles.length,
  );
  assert.deepEqual(
    manifest.excluded_profiles
      .filter((profile) => profile.source_section === "archived_profiles")
      .map((profile) => profile.profile_id),
    [
      "finance_plaid_pull_coordinator",
      "finance_plaid_pull_effectiveness_monitor",
      "red_team_run_review",
    ],
  );
});

test("preserves the canonical reporting tree and external human root", () => {
  const live = new Set(manifest.profiles.map((profile) => profile.profile_id));
  const internal = manifest.profiles.filter((profile) => live.has(profile.org.reports_to));
  const external = manifest.profiles.filter((profile) =>
    profile.org.reports_to && !live.has(profile.org.reports_to));
  assert.equal(internal.length, 36);
  assert.deepEqual(external.map((profile) => [profile.profile_id, profile.org.reports_to]), [
    ["keez_request_router", "hunter"],
  ]);
  assert.equal(manifest.internal_reporting_link_count, 36);
});

test("preserves one Chief of Staff, nine chiefs, their workers, and the direct staff writer", () => {
  const chiefOfStaff = manifest.profiles.filter((profile) => profile.org.role === "chief_of_staff");
  const chiefs = manifest.profiles.filter((profile) => profile.org.role === "department_chief");
  const chiefIds = new Set(chiefs.map((profile) => profile.profile_id));
  const workers = manifest.profiles.filter((profile) => chiefIds.has(profile.org.reports_to));
  const directStaff = manifest.profiles.filter((profile) =>
    profile.org.reports_to === chiefOfStaff[0]?.profile_id && profile.org.role !== "department_chief");
  assert.equal(chiefOfStaff.length, 1);
  assert.equal(chiefs.length, 9);
  assert.equal(workers.length, 26);
  assert.deepEqual(directStaff.map((profile) => profile.profile_id), ["keez_clickup_task_writer"]);
});

test("contains policy visibility but no execution homes or credential material", () => {
  for (const profile of manifest.profiles) {
    assert.ok(profile.label);
    assert.ok(profile.org.role);
    assert.ok(profile.org.hub);
    assert.ok(profile.org.accountability_signal);
    assert.ok(profile.org.stakes_tier);
    assert.ok(profile.write_policy.mode);
    assert.ok(Object.hasOwn(profile.budgets, "max_spend_usd"));
    assert.ok(Array.isArray(profile.permissions.forbidden_actions));
  }
  const keys = [];
  const collectKeys = (value) => {
    if (Array.isArray(value)) {
      value.forEach(collectKeys);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      collectKeys(child);
    }
  };
  collectKeys(manifest);
  for (const forbiddenKey of [
    "runtime_profile",
    "clickup_mirror",
    "apiKey",
    "credentialHome",
    "private_receipt",
    "unrestricted_log",
  ]) {
    assert.equal(keys.includes(forbiddenKey), false, forbiddenKey);
  }
});
