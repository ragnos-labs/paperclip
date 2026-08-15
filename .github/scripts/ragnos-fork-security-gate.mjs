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

export function sanitizeFlags(flags) {
  return flags.map(({ check, file, pattern, packages, advisoryPath }) => ({
    check,
    file,
    pattern,
    packages,
    advisoryPath,
  }));
}

async function runAuditGate() {
  const baselineUrl = new URL("../ragnos-production-audit-baseline.json", import.meta.url);
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  const result = spawnSync("pnpm", ["audit", "--prod", "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;

  let audit;
  try {
    audit = JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm audit did not return JSON: ${result.stderr || result.stdout}`);
  }

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

  const files = await fetchAllPullRequestFiles(ghFetch, repo, prNumber, token);
  const flags = [
    ...scanSecrets(files),
    ...scanCITampering(files),
    ...scanBuildScripts(files),
    ...scanSupplyChain(files),
    ...scanTestPatterns(files),
    ...scanSensitivePaths(files),
  ];
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
