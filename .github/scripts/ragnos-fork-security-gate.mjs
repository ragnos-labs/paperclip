#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

export function requireIndependentInfrastructureReview(flags, statuses, headSha) {
  const infrastructure = flags.filter(flag => flag.check === "ci-tampering");
  const remaining = flags.filter(flag => flag.check !== "ci-tampering");
  if (!infrastructure.length) return remaining;
  const receipt = statuses.find(status => status.context === "ragnos/fork-infrastructure-review");
  if (!receipt || receipt.state !== "success" || !receipt.url?.endsWith(`/statuses/${headSha}`) ||
      !receipt.target_url?.startsWith("https://github.com/ragnos-labs/paperclip/pull/")) return flags;
  return remaining;
}

async function runAuditGate() {
  const baselineUrl = new URL("../ragnos-production-audit-baseline.json", import.meta.url);
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
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
  const detectedFlags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];
  if (pullRequestBefore?.head?.sha !== pullRequestAfter?.head?.sha) throw new Error("PR head moved during review");
  const headSha = pullRequestAfter.head.sha;
  const statuses = detectedFlags.some(flag => flag.check === "ci-tampering")
    ? await ghFetch(`/repos/${repo}/commits/${headSha}/statuses?per_page=100`, token) : [];
  const flags = requireIndependentInfrastructureReview(detectedFlags, statuses, headSha);
  if (flags.length > 0) {
    throw new Error(`read-only source scan failed:\n${JSON.stringify(sanitizeFlags(flags), null, 2)}`);
  }
  console.log(`[fork-security] read-only source scan passed for ${files.length} changed file(s)`);
}

async function main() {
  await runAuditGate();
  if (!process.argv.includes("--audit-only")) await runPullRequestScan();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[fork-security] ${error.message}`);
    process.exit(1);
  });
}
