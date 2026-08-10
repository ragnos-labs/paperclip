import assert from "node:assert/strict";
import { test } from "node:test";
import { idempotencyKey } from "../src/protocol.js";
import { testExports } from "../src/adapter.js";
import { createServerAdapter } from "../src/index.js";

function context(overrides = {}) {
  return {
    agent: {
      companyId: "company-ragnos",
      id: "employee-apply",
    },
    context: {
      approvalId: "approval-1",
      approvalStatus: "approved",
      attempt: 1,
      issueId: "issue-1",
      paperclipTaskMarkdown: [
        "# Apply approved proposal",
        "",
        "```ragnos-fleet",
        '{"proposal_id":"proposal_1234567890abcdef"}',
        "```",
      ].join("\n"),
      ...overrides,
    },
    runId: "run-1",
  };
}

test("apply consumes only an approved structured proposal id", () => {
  const ctx = context();
  const key = idempotencyKey({
    attempt: 1,
    companyId: ctx.agent.companyId,
    issueId: "issue-1",
    operation: "apply",
    runId: ctx.runId,
  });
  const payload = testExports.submission(ctx, "apply", key);
  assert.equal(payload.proposal_id, "proposal_1234567890abcdef");
  assert.equal(payload.confirmation, "apply");
  assert.deepEqual(Object.keys(payload).sort(), [
    "confirmation",
    "context",
    "idempotency_key",
    "proposal_id",
    "protocol_version",
  ]);
  assert.throws(
    () => testExports.submission(context({ approvalStatus: "pending" }), "apply", key),
    /fleet_apply_approval_required/,
  );
  assert.throws(
    () => testExports.submission(context({ paperclipTaskMarkdown: "no payload" }), "apply", key),
    /fleet_apply_proposal_id_invalid/,
  );
});

test("gateway context contains references but no caller-selected authority", () => {
  const ctx = context({
    repository: "forbidden",
    runner_pool_id: "forbidden",
    tenant_id: "forbidden",
    workspace_path: "/forbidden",
  });
  const result = testExports.requestContext(ctx, "apply", "pcf-v1:" + "a".repeat(64));
  const serialized = JSON.stringify(result);
  assert.match(serialized, /company-ragnos/);
  assert.match(serialized, /employee-apply/);
  assert.doesNotMatch(serialized, /forbidden/);
  assert.deepEqual(Object.keys(result).sort(), [
    "paperclip_refs",
    "pipeline_run_id",
    "revision",
    "trace_id",
  ]);
});

test("result projection drops credentials, patches, receipts, and unrestricted logs", () => {
  const result = testExports.safePublicResult({
    agent_run_id: "agent-run-1",
    pipeline_run_id: "pipeline-1",
    credentials: "secret",
    job_id: "job-1",
    logs: "private log",
    proposal_patch: "private patch",
    result: {
      receipt_id: "receipt-1",
      receipt_payload: "private receipt",
      workspace_id: "workspace-1",
    },
    status: "succeeded",
  });
  assert.deepEqual(result, {
    agent_run_id: "agent-run-1",
    job_id: "job-1",
    pipeline_run_id: "pipeline-1",
    result: {
      receipt_id: "receipt-1",
      workspace_id: "workspace-1",
    },
    status: "succeeded",
  });
});

test("Paperclip disposition is loopback-only and contains bounded identifiers", () => {
  assert.equal(createServerAdapter().supportsLocalAgentJwt, true);
  assert.equal(
    testExports.paperclipApiUrl({ paperclipApiUrl: "http://127.0.0.1:3100" }).href,
    "http://127.0.0.1:3100/",
  );
  assert.throws(
    () => testExports.paperclipApiUrl({ paperclipApiUrl: "https://paperclip.example.com" }),
    /paperclip_api_url_not_loopback/,
  );
  const comment = testExports.dispositionComment({
    agent_run_id: "agent-run-1",
    base_revision: "a".repeat(40),
    changed_files: ["src/example.js"],
    cleanup_receipt_id: "cleanup-1",
    credentials: "secret",
    diff_bytes: 41,
    diff_preview: "diff --git a/src/example.js b/src/example.js\n+safe change",
    diff_sha256: "b".repeat(64),
    job_id: "job-1",
    logs: "private logs",
    pipeline_run_id: "pipeline-1",
    proposal_id: "proposal_1234567890abcdef",
    receipt_payload: "private receipt",
    receipt_id: "receipt-1",
    repo_id: "ragnos-workspace",
    revision: "c".repeat(40),
    status: "succeeded",
    trace_id: "d".repeat(32),
    workspace_id: "workspace-1",
  }, "propose", "paperclip-run-1");
  assert.match(comment, /job-1/);
  assert.match(comment, /paperclip-run-1/);
  assert.match(comment, /pipeline-1/);
  assert.match(comment, /cleanup-1/);
  assert.match(comment, /src\/example\.js/);
  assert.match(comment, /safe change/);
  assert.match(comment, /proposal_1234567890abcdef/);
  assert.doesNotMatch(comment, /secret|private logs|private receipt/);
});

test("review projection drops oversized or malformed review fields", () => {
  const result = testExports.safePublicResult({
    changed_files: ["../escape"],
    diff_bytes: -1,
    diff_preview: "x".repeat(8 * 1024 + 1),
    diff_sha256: "not-a-hash",
    proposal_patch: "private patch",
    repo_id: "ragnos-workspace",
  });

  assert.deepEqual(result, { repo_id: "ragnos-workspace" });
});

test("successful proposal waits for the cleanup receipt before disposition", () => {
  assert.equal(testExports.terminalResultReady("running", {}), false);
  assert.equal(testExports.terminalResultReady("succeeded", {
    receipt_id: "receipt-1",
  }), false);
  assert.equal(testExports.terminalResultReady("succeeded", {
    cleanup_receipt_id: "cleanup-1",
    receipt_id: "receipt-1",
  }), true);
  assert.equal(testExports.terminalResultReady("failed", {}), true);
});
