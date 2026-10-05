import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function validateReviewedReleaseSource({ source, branch, statuses, checks }) {
  if (!/^[0-9a-f]{40}$/.test(source) || branch !== source) throw new Error("Source is not the exact maintenance head");
  for (const context of ["ragnos/fork-source-review", "ragnos/fork-infrastructure-review"]) {
    const latest = statuses.find(status => status.context === context);
    if (!latest || latest.state !== "success" || !latest.url?.endsWith(`/statuses/${source}`) ||
        !latest.target_url?.startsWith("https://github.com/ragnos-labs/paperclip/pull/")) {
      throw new Error(`Missing exact-commit independent review: ${context}`);
    }
  }
  const ci = checks.find(check => check.name === "RAGnos Fork CI");
  if (!ci || ci.head_sha !== source || ci.status !== "completed" || ci.conclusion !== "success") {
    throw new Error("Exact source has no green completed fork CI");
  }
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== "ragnos-labs/paperclip") throw new Error("Fork release requires the named repository");
  const source = process.env.SOURCE_SHA;
  if (!/^[0-9a-f]{40}$/.test(source ?? "")) throw new Error("Exact source SHA required");
  const api = route => JSON.parse(execFileSync("gh", ["api", `repos/ragnos-labs/paperclip/${route}`], { encoding: "utf8" }));
  const branch = api("git/ref/heads/codex/paperclip-stable").object.sha;
  const statuses = api(`commits/${source}/statuses?per_page=100`);
  const checks = api(`commits/${source}/check-runs?per_page=100`).check_runs;
  validateReviewedReleaseSource({ source, branch, statuses, checks });
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== source) throw new Error("Checkout does not match reviewed source");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Release checkout is dirty");
  console.log(`Reviewed maintenance source and fork CI verified: ${source}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
