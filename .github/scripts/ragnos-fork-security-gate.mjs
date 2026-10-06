#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  scanBuildScripts,
  scanCITampering,
  scanSecrets,
  scanSensitivePaths,
  scanSupplyChain,
  scanTestPatterns,
} from "./check-pr-security.mjs";
import { fetchAllPullRequestFiles } from "./fetch-pr-files.mjs";
import { ghFetch } from "./get-bot-token.mjs";

const severityRank = new Map([
  ["info", 0],
  ["low", 1],
  ["moderate", 2],
  ["high", 3],
  ["critical", 4],
]);

export function compareAuditToBaseline(audit, baseline) {
  const failures = [];
  const advisories = audit?.advisories ?? {};
  const allowed = baseline?.advisories ?? {};

  for (const [id, advisory] of Object.entries(advisories)) {
    const severity = advisory?.severity;
    const allowedSeverity = allowed[id];
    if (!severityRank.has(severity)) {
      failures.push(`advisory ${id} has unknown severity ${String(severity)}`);
      continue;
    }
    if (!allowedSeverity) {
      failures.push(`new ${severity} advisory ${id}`);
      continue;
    }
    if (severityRank.get(severity) > severityRank.get(allowedSeverity)) {
      failures.push(`advisory ${id} increased from ${allowedSeverity} to ${severity}`);
    }
  }

  return failures;
}

export function validateAuditCommandResult(result) {
  if (result.error) throw new Error("pnpm audit could not start");
  if (result.signal) throw new Error("pnpm audit was interrupted");
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`pnpm audit failed with unexpected status ${String(result.status)}`);
  }

  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    throw new Error("pnpm audit did not return valid JSON");
  }

  if (!audit || typeof audit !== "object" || Array.isArray(audit) || audit.error) {
    throw new Error("pnpm audit returned an error response");
  }
  if (!audit.advisories || typeof audit.advisories !== "object" || Array.isArray(audit.advisories)) {
    throw new Error("pnpm audit response is missing the advisories map");
  }
  const counts = audit.metadata?.vulnerabilities;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("pnpm audit response is missing vulnerability counts");
  }
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    if (!Number.isInteger(counts[severity]) || counts[severity] < 0) {
      throw new Error(`pnpm audit response has an invalid ${severity} count`);
    }
  }
  return audit;
}

export function sanitizeFlags(flags) {
  return flags.map(({ check, file, pattern, packages, advisoryPath }) => ({
    check,
    file,
    pattern,
    packages,
    advisoryPath,
  }));
}

const reportedOnly = new Set(["ci-tampering", "suspicious-test"]);

export function blockingFlags(flags) {
  const reported = flags.filter(flag => reportedOnly.has(flag.check));
  if (reported.length > 0) {
    console.log(`[fork-security] reported for the change author, not blocking:\n${JSON.stringify(sanitizeFlags(reported), null, 2)}`);
  }
  return flags.filter(flag => !reportedOnly.has(flag.check));
}

export function validateAuditBaseline(baseline) {
  // The hash identifies the inherited upstream lock, not the repaired current lock.
  if (baseline?.schemaVersion !== 1 ||
      baseline.sourceCommit !== "8f8a0ab7effbd6a0584107d8038736c134ee5047" ||
      baseline.lockfileSha256 !== "d7d96cf0d98cf0946f6195e29ba173b03711a947a1c38f312b67cda56c254c22" ||
      !baseline.advisories || typeof baseline.advisories !== "object" || Array.isArray(baseline.advisories) ||
      Object.entries(baseline.advisories).some(([id, severity]) => !/^\d+$/.test(id) || !severityRank.has(severity)))
    throw new Error("Invalid inherited upstream audit baseline");
}

export async function runAuditGate() {
  const baselineUrl = new URL("../ragnos-production-audit-baseline.json", import.meta.url);
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  validateAuditBaseline(baseline);
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const audit = validateAuditCommandResult(result);

  const counts = audit.metadata?.vulnerabilities ?? {};
  console.log(`[fork-security] production audit counts: ${JSON.stringify(counts)}`);
  const failures = compareAuditToBaseline(audit, baseline);
  if (failures.length > 0) {
    throw new Error(`production audit regression:\n${failures.map((item) => `- ${item}`).join("\n")}`);
  }
}

async function runPullRequestScan() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const prNumber = Number(process.env.PR_NUMBER);
  if (!token || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("GITHUB_TOKEN, GITHUB_REPOSITORY, and a positive PR_NUMBER are required");
  }

  const pullRequestBefore = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  const files = await fetchAllPullRequestFiles(ghFetch, repo, prNumber, token);
  const pullRequestAfter = await ghFetch(`/repos/${repo}/pulls/${prNumber}`, token);
  if (pullRequestBefore?.head?.sha !== pullRequestAfter?.head?.sha) throw new Error("PR head moved during review");
  const base = pullRequestBefore?.base?.sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? "")) throw new Error("Exact PR base SHA required");
  if (base !== pullRequestAfter?.base?.sha) throw new Error("PR base moved during review");
  const baseLockfile = files.some(file => file.filename === "pnpm-lock.yaml" && file.patch)
    ? execFileSync("git", ["show", `${base}:pnpm-lock.yaml`], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
    : undefined;
  const detectedFlags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files, baseLockfile),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];
  const flags = blockingFlags(detectedFlags);
  if (flags.length > 0) {
    throw new Error(`read-only source scan failed:\n${JSON.stringify(sanitizeFlags(flags), null, 2)}`);
  }
  console.log(`[fork-security] read-only source scan passed for ${files.length} changed file(s)`);
}

async function runCommitScan() {
  const source = process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(source ?? "") || repo !== "ragnos-labs/paperclip")
    throw new Error("Exact fork push source required");
  const baseline = "8f8a0ab7effbd6a0584107d8038736c134ee5047";
  const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const files = git(["diff", "--name-only", baseline, source]).trim().split("\n").filter(Boolean)
    .map(filename => ({ filename, patch: git(["diff", "--no-ext-diff", baseline, source, "--", filename]) }));
  const baseLockfile = files.some(file => file.filename === "pnpm-lock.yaml" && file.patch)
    ? git(["show", `${baseline}:pnpm-lock.yaml`]) : undefined;
  const detectedFlags = [
    ...[scanSecrets, scanCITampering, scanSensitivePaths, scanBuildScripts, scanTestPatterns].flatMap(scan => scan(files)),
    ...scanSupplyChain(files, baseLockfile),
  ];
  const flags = blockingFlags(detectedFlags);
  if (flags.length) throw new Error(`read-only source scan failed: ${JSON.stringify(sanitizeFlags(flags))}`);
  console.log(`[fork-security] exact push source scan passed for ${files.length} changed files`);
}

async function main() {
  await runAuditGate();
  if (process.env.GITHUB_EVENT_NAME === "push") await runCommitScan();
  else await runPullRequestScan();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[fork-security] ${error.message}`);
    process.exit(1);
  });
}
