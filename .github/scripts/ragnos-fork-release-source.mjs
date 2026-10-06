import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function forkCiRunId(checks, source) {
  const ci = checks.find(check => check.name === "RAGnos Fork CI" && check.head_sha === source &&
    check.status === "completed" && check.conclusion === "success" && check.app?.slug === "github-actions");
  return /^https:\/\/github\.com\/ragnos-labs\/paperclip\/actions\/runs\/(\d+)/.exec(ci?.details_url ?? "")?.[1] ?? null;
}

export function validateReleaseSource({ source, branch, checks, workflowRun }) {
  if (!/^[0-9a-f]{40}$/.test(source) || branch !== source) throw new Error("Source is not the exact maintenance head");
  if (!forkCiRunId(checks, source) ||
      !workflowRun || workflowRun.head_sha !== source || workflowRun.conclusion !== "success" ||
      workflowRun.path !== ".github/workflows/ragnos-fork-ci.yml" ||
      workflowRun.repository?.full_name !== "ragnos-labs/paperclip") {
    throw new Error("Exact source has no green completed fork CI");
  }
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== "ragnos-labs/paperclip") throw new Error("Fork release requires the named repository");
  const source = process.env.SOURCE_SHA;
  if (!/^[0-9a-f]{40}$/.test(source ?? "")) throw new Error("Exact source SHA required");
  const api = route => JSON.parse(execFileSync("gh", ["api", `repos/ragnos-labs/paperclip/${route}`], { encoding: "utf8" }));
  const branch = api("git/ref/heads/codex/paperclip-stable").object.sha;
  const checks = api(`commits/${source}/check-runs?per_page=100`).check_runs;
  const runId = forkCiRunId(checks, source);
  if (!runId) throw new Error("Exact source has no green completed fork CI");
  const workflowRun = api(`actions/runs/${runId}`);
  validateReleaseSource({ source, branch, checks, workflowRun });
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== source) throw new Error("Checkout does not match the release source");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Release checkout is dirty");
  console.log(`Maintenance head and fork CI verified: ${source}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
