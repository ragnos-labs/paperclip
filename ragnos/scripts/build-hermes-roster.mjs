#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_SCHEMA = "paperclip_ragnos_hermes_roster/v1";
const require = createRequire(import.meta.url);

function yamlLoad(text) {
  try {
    return require("js-yaml").load(text);
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.pnpm");
    const packageDir = readdirSync(packageRoot)
      .filter((entry) => entry.startsWith("js-yaml@"))
      .sort()[0];
    if (!packageDir) fail("js-yaml is unavailable; run pnpm install first");
    return require(join(packageRoot, packageDir, "node_modules/js-yaml/index.js")).load(text);
  }
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail(`unexpected argument ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${key} requires a value`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function humanize(value) {
  return String(value)
    .split("_")
    .filter(Boolean)
    .map((part) => part.length <= 3 && ["rd", "crm", "slo"].includes(part)
      ? part.toUpperCase()
      : `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function safeProfile(profileId, raw, migrationDefault) {
  const org = object(raw.org);
  return {
    profile_id: profileId,
    label: humanize(profileId),
    description: String(raw.description || ""),
    lifecycle: array(raw.lifecycle).map(String),
    governance_lifecycle: String(raw.governance_lifecycle || migrationDefault),
    org: {
      role: String(org.role || ""),
      hub: String(org.hub || ""),
      team: String(org.team || ""),
      reports_to: String(org.reports_to || ""),
      stakes_tier: String(org.stakes_tier || ""),
      accountability_signal: String(org.accountability_signal || ""),
      escalation_owner: String(org.escalation_owner || ""),
    },
    permissions: {
      allowed_actions: array(raw.allowed_actions).map(String),
      allowed_adapters: array(raw.allowed_adapters).map(String),
      forbidden_actions: array(raw.forbidden_actions).map(String),
      scopes: object(raw.scopes),
    },
    budgets: object(raw.budget_caps),
    write_policy: object(raw.write_policy),
    schedule: object(raw.schedule),
    source_pointers: {
      soul_doc: String(raw.soul_doc || ""),
      evidence_sources: array(raw.evidence_sources).map(String),
      telemetry_sinks: array(raw.telemetry_sinks).map(String),
    },
  };
}

function verifiedSource(sourcePath, sourceCommit) {
  const absolutePath = resolve(sourcePath);
  let repositoryRoot;
  let committedBytes;
  try {
    repositoryRoot = execFileSync(
      "git",
      ["-C", dirname(absolutePath), "rev-parse", "--show-toplevel"],
      { encoding: "utf8" },
    ).trim();
  } catch {
    fail("--source must be inside a Git worktree");
  }
  const repositoryPath = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
  if (repositoryPath !== "config/hermes_profiles.yaml") {
    fail("--source must resolve to the canonical config/hermes_profiles.yaml path");
  }
  try {
    committedBytes = execFileSync(
      "git",
      ["-C", repositoryRoot, "show", `${sourceCommit}:${repositoryPath}`],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    );
  } catch {
    fail("--source-commit does not contain the canonical Hermes registry");
  }
  const sourceBytes = readFileSync(absolutePath);
  if (!sourceBytes.equals(committedBytes)) {
    fail("working-tree Hermes registry differs from --source-commit");
  }
  return sourceBytes;
}

function buildManifest(sourcePath, sourceCommit) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    fail("--source-commit must be an exact 40-character lowercase Git SHA");
  }
  const sourceBytes = verifiedSource(sourcePath, sourceCommit);
  const registry = yamlLoad(sourceBytes.toString("utf8"));
  const lanes = object(registry.governance_lanes);
  const expectedLiveCount = Number(registry.live_lane_freeze?.expected_live_count);
  const migrationDefault = String(
    registry.governance_lifecycle_schema?.migration_default || "active_advisory",
  );
  if (!Number.isInteger(expectedLiveCount) || expectedLiveCount < 1) {
    fail("registry live_lane_freeze.expected_live_count is invalid");
  }

  const entries = Object.entries(lanes).sort(([left], [right]) => left.localeCompare(right));
  const live = entries
    .filter(([, profile]) => array(profile.lifecycle).includes("live"))
    .map(([profileId, profile]) => safeProfile(profileId, profile, migrationDefault));
  const nonLiveExcluded = entries
    .filter(([, profile]) => !array(profile.lifecycle).includes("live"))
    .map(([profileId, profile]) => ({
      profile_id: profileId,
      lifecycle: array(profile.lifecycle).map(String),
      governance_lifecycle: String(profile.governance_lifecycle || migrationDefault),
      source_section: "governance_lanes",
    }));
  const archivedExcluded = Object.entries(object(registry.archived_profiles))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([profileId, profile]) => ({
      profile_id: profileId,
      lifecycle: array(profile.previous_lifecycle).map(String),
      governance_lifecycle: "archived",
      archived_status: String(profile.status || "archived"),
      replacement_profile: profile.replacement_profile == null
        ? null
        : String(profile.replacement_profile),
      source_section: "archived_profiles",
    }));
  const excluded = [...nonLiveExcluded, ...archivedExcluded]
    .sort((left, right) => left.profile_id.localeCompare(right.profile_id));

  if (live.length !== expectedLiveCount) {
    fail(`registry expected ${expectedLiveCount} live profiles but selected ${live.length}`);
  }
  const liveIds = new Set(live.map((profile) => profile.profile_id));
  const duplicates = live.filter((profile, index) =>
    live.findIndex((candidate) => candidate.profile_id === profile.profile_id) !== index);
  if (duplicates.length > 0) fail("registry contains duplicate live profile IDs");

  const internalLinks = live.filter((profile) => liveIds.has(profile.org.reports_to)).length;
  const externalLinks = live
    .filter((profile) => profile.org.reports_to && !liveIds.has(profile.org.reports_to))
    .map((profile) => ({
      profile_id: profile.profile_id,
      reports_to: profile.org.reports_to,
    }));

  return {
    schema_version: MANIFEST_SCHEMA,
    source: {
      repository: "ragnos",
      path: "config/hermes_profiles.yaml",
      commit: sourceCommit,
      sha256: createHash("sha256").update(sourceBytes).digest("hex"),
      registry_schema_version: String(registry.schema_version || ""),
    },
    expected_live_count: expectedLiveCount,
    internal_reporting_link_count: internalLinks,
    external_reporting_links: externalLinks,
    profiles: live,
    excluded_profiles: excluded,
  };
}

function validateManifest(manifest) {
  if (manifest.schema_version !== MANIFEST_SCHEMA) fail("manifest schema version is not supported");
  if (!Number.isInteger(manifest.expected_live_count)) fail("manifest expected_live_count is invalid");
  if (!Array.isArray(manifest.profiles)) fail("manifest profiles must be an array");
  if (manifest.profiles.length !== manifest.expected_live_count) {
    fail("manifest live profile count does not match expected_live_count");
  }
  const ids = manifest.profiles.map((profile) => profile.profile_id);
  if (new Set(ids).size !== ids.length) fail("manifest contains duplicate live profile IDs");
  const excludedIds = new Set((manifest.excluded_profiles || []).map((profile) => profile.profile_id));
  if (excludedIds.size !== (manifest.excluded_profiles || []).length) {
    fail("manifest contains duplicate excluded profile IDs");
  }
  if (ids.some((profileId) => excludedIds.has(profileId))) {
    fail("manifest includes a profile in both live and excluded sets");
  }
  const liveIds = new Set(ids);
  const internalLinks = manifest.profiles.filter((profile) =>
    liveIds.has(profile.org?.reports_to)).length;
  if (internalLinks !== manifest.internal_reporting_link_count) {
    fail("manifest internal reporting link count is inconsistent");
  }
  for (const profile of manifest.profiles) {
    if (!profile.lifecycle?.includes("live")) fail(`${profile.profile_id} is not live`);
    if (!profile.label || !profile.org?.role || !profile.org?.hub) {
      fail(`${profile.profile_id} is missing required visibility metadata`);
    }
  }
  return manifest;
}

const args = parseArgs(process.argv.slice(2));
if (args["validate-manifest"]) {
  const manifestPath = resolve(args["validate-manifest"]);
  validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(JSON.stringify({ status: "valid", manifest: manifestPath }));
  process.exit(0);
}

if (!args.source || !args.output || !args["source-commit"]) {
  fail("usage: build-hermes-roster.mjs --source PATH --source-commit SHA --output PATH");
}
const manifest = validateManifest(buildManifest(resolve(args.source), args["source-commit"]));
writeFileSync(resolve(args.output), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  status: "written",
  output: resolve(args.output),
  live_profiles: manifest.profiles.length,
  excluded_profiles: manifest.excluded_profiles.length,
  source_sha256: manifest.source.sha256,
}));
