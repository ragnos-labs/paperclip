import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function validateIndependentReview(status, source, scope, review) {
  const context = `ragnos/fork-${scope}-review`;
  const match = /^https:\/\/github\.com\/ragnos-labs\/paperclip\/pull\/(\d+)#pullrequestreview-(\d+)$/.exec(status?.target_url ?? "");
  if (!status || status.context !== context || status.state !== "success" ||
      status.url !== `https://api.github.com/repos/ragnos-labs/paperclip/statuses/${source}` || !match ||
      !review || review.html_url !== status.target_url || review.commit_id !== source ||
      !["COMMENTED", "APPROVED"].includes(review.state) || !review.submitted_at ||
      !["OWNER", "MEMBER", "COLLABORATOR"].includes(review.author_association))
    throw new Error(`Missing exact-commit independent review: ${context}`);
  const receiptBlock = /```ragnos-review\s*([\s\S]*?)```/.exec(review.body ?? "");
  const receipt = JSON.parse(receiptBlock?.[1] ?? "null");
  if (!receipt || receipt.schema !== "ragnos_fork_independent_review/v1" ||
      receipt.source_sha !== source || receipt.scope !== scope || receipt.decision !== "pass" ||
      receipt.independent !== true || receipt.reviewer !== `/root/${scope === "source" ? "recovery_review" : "release_review"}` ||
      !Array.isArray(receipt.blockers) || receipt.blockers.length !== 0)
    throw new Error(`Review receipt does not approve exact ${scope} source`);
  return receipt;
}

export function validateReviewedReleaseSource({ source, branch, statuses, checks, reviews, workflowRun }) {
  if (!/^[0-9a-f]{40}$/.test(source) || branch !== source) throw new Error("Source is not the exact maintenance head");
  for (const scope of ["source", "infrastructure"]) {
    const status = statuses.find(status => status.context === `ragnos/fork-${scope}-review`);
    validateIndependentReview(status, source, scope, reviews?.[scope]);
  }
  const ci = checks.find(check => check.name === "RAGnos Fork CI");
  if (!ci || ci.head_sha !== source || ci.status !== "completed" || ci.conclusion !== "success" ||
      ci.app?.slug !== "github-actions" ||
      !ci.details_url?.startsWith("https://github.com/ragnos-labs/paperclip/actions/runs/") ||
      !workflowRun || workflowRun.head_sha !== source || workflowRun.conclusion !== "success" ||
      workflowRun.path !== ".github/workflows/ragnos-fork-ci.yml" ||
      workflowRun.repository?.full_name !== "ragnos-labs/paperclip") {
    throw new Error("Exact source has no green completed fork CI");
  }
}

export function reviewApiRoute(status) {
  const match = /^https:\/\/github\.com\/ragnos-labs\/paperclip\/pull\/(\d+)#pullrequestreview-(\d+)$/.exec(status?.target_url ?? "");
  if (!match) throw new Error("Review status must link the actual submitted review receipt");
  return `pulls/${match[1]}/reviews/${match[2]}`;
}

async function main() {
  if (process.env.GITHUB_REPOSITORY !== "ragnos-labs/paperclip") throw new Error("Fork release requires the named repository");
  const source = process.env.SOURCE_SHA;
  if (!/^[0-9a-f]{40}$/.test(source ?? "")) throw new Error("Exact source SHA required");
  const api = route => JSON.parse(execFileSync("gh", ["api", `repos/ragnos-labs/paperclip/${route}`], { encoding: "utf8" }));
  const branch = api("git/ref/heads/codex/paperclip-stable").object.sha;
  const statuses = api(`commits/${source}/statuses?per_page=100`);
  const checks = api(`commits/${source}/check-runs?per_page=100`).check_runs;
  const reviews = Object.fromEntries(["source", "infrastructure"].map(scope => {
    const status = statuses.find(status => status.context === `ragnos/fork-${scope}-review`);
    return [scope, api(reviewApiRoute(status))];
  }));
  const ci = checks.find(check => check.name === "RAGnos Fork CI");
  const runId = /^https:\/\/github\.com\/ragnos-labs\/paperclip\/actions\/runs\/(\d+)/.exec(ci?.details_url ?? "")?.[1];
  if (!runId) throw new Error("Fork CI must be a GitHub Actions run");
  const workflowRun = api(`actions/runs/${runId}`);
  validateReviewedReleaseSource({ source, branch, statuses, checks, reviews, workflowRun });
  if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== source) throw new Error("Checkout does not match reviewed source");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Release checkout is dirty");
  console.log(`Reviewed maintenance source and fork CI verified: ${source}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
