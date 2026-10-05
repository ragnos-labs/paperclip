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
import { validateIndependentReview, reviewApiRoute } from "./ragnos-fork-release-source.mjs";

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

export function requireIndependentInfrastructureReview(flags, statuses, headSha, review, sourceReview) {
  const receipts = {};
  for (const [scope, evidence] of [["infrastructure", review], ["source", sourceReview]]) {
    try { receipts[scope] = validateIndependentReview(statuses.find(status =>
      status.context === `ragnos/fork-${scope}-review`), headSha, scope, evidence); }
    catch (error) {
      console.error(`[fork-security] ${scope} review rejected: ${error instanceof SyntaxError ? "invalid_receipt_json" : "invalid_review_identity_or_receipt"}; source=${headSha}; status_count=${statuses.length}; matching_status=${statuses.some(status => status.context === `ragnos/fork-${scope}-review`)}; review_present=${Boolean(evidence)}`);
    }
  }
  return flags.filter(flag => {
    if (flag.check === "ci-tampering") return !receipts.infrastructure;
    if (flag.check !== "suspicious-test") return true;
    const scope = flag.file.startsWith(".github/") ? "infrastructure" : "source";
    return !(receipts[scope]?.accepted_findings ?? []).some(finding =>
      finding.check === flag.check && finding.file === flag.file &&
      typeof finding.reason === "string" && finding.reason.length > 0);
  });
}

async function runAuditGate() {
  const baselineUrl = new URL("../ragnos-production-audit-baseline.json", import.meta.url);
  const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
  const { createHash } = await import("node:crypto");
  const lock = await readFile(new URL("../../pnpm-lock.yaml", import.meta.url));
  if (baseline.sourceCommit !== "8f8a0ab7effbd6a0584107d8038736c134ee5047" ||
      baseline.lockfileSha256 !== createHash("sha256").update(lock).digest("hex"))
    throw new Error("Audit baseline does not match the installed upstream lockfile");
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
  const status = statuses.find(status => status.context === "ragnos/fork-infrastructure-review");
  const review = status ? await ghFetch(`/repos/${repo}/${reviewApiRoute(status)}`, token) : null;
  const sourceStatus = statuses.find(status => status.context === "ragnos/fork-source-review");
  const sourceReview = sourceStatus ? await ghFetch(`/repos/${repo}/${reviewApiRoute(sourceStatus)}`, token) : null;
  const flags = requireIndependentInfrastructureReview(detectedFlags, statuses, headSha, review, sourceReview);
  if (flags.length > 0) {
    throw new Error(`read-only source scan failed:\n${JSON.stringify(sanitizeFlags(flags), null, 2)}`);
  }
  console.log(`[fork-security] read-only source scan passed for ${files.length} changed file(s)`);
}

async function runCommitScan() {
  const source = process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!/^[0-9a-f]{40}$/.test(source ?? "") || repo !== "ragnos-labs/paperclip" || !token)
    throw new Error("Exact fork push source and token required");
  const baseline = "8f8a0ab7effbd6a0584107d8038736c134ee5047";
  const git = args => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const files = git(["diff", "--name-only", baseline, source]).trim().split("\n").filter(Boolean)
    .map(filename => ({ filename, patch: git(["diff", "--no-ext-diff", baseline, source, "--", filename]) }));
  const detectedFlags = [scanSecrets, scanCITampering, scanSensitivePaths, scanBuildScripts,
    scanTestPatterns, scanSupplyChain].flatMap(scan => scan(files));
  const statuses = await ghFetch(`/repos/${repo}/commits/${source}/statuses?per_page=100`, token);
  const status = statuses.find(status => status.context === "ragnos/fork-infrastructure-review");
  const review = status ? await ghFetch(`/repos/${repo}/${reviewApiRoute(status)}`, token) : null;
  const sourceStatus = statuses.find(status => status.context === "ragnos/fork-source-review");
  const sourceReview = sourceStatus ? await ghFetch(`/repos/${repo}/${reviewApiRoute(sourceStatus)}`, token) : null;
  const flags = requireIndependentInfrastructureReview(detectedFlags, statuses, source, review, sourceReview);
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
