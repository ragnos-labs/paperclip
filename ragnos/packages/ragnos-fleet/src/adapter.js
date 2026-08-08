import { setTimeout as delay } from "node:timers/promises";
import {
  PROTOCOL_VERSION,
  actorHash,
  canonicalJson,
  decodeHmacKey,
  idempotencyKey,
  sha256,
  signRequest,
} from "./protocol.js";

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "canceled", "timeout"]);
const SAFE_PUBLIC_FIELDS = new Set([
  "agent_run_id",
  "cancel_requested",
  "created_at",
  "delivery_group",
  "error",
  "finalizer_state",
  "idempotency_key",
  "job_id",
  "operation",
  "ownership_keys",
  "plan_ref",
  "poll_after_ms",
  "proposal_id",
  "receipt_id",
  "right_size_decision_id",
  "right_size_tier",
  "status",
  "trace_id",
  "updated_at",
  "workspace_id",
  "workspace_state",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function operation(config) {
  const value = nonEmpty(config.operation);
  if (value !== "propose" && value !== "apply") throw new Error("fleet_operation_invalid");
  return value;
}

function gatewayUrl(config) {
  const raw = nonEmpty(config.gatewayBaseUrl);
  if (!raw) throw new Error("fleet_gateway_url_missing");
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("fleet_gateway_url_invalid");
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname);
  if (url.protocol === "http:" && !loopback && config.allowPrivateHttp !== true) {
    throw new Error("fleet_gateway_plain_http_denied");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function paperclipApiUrl(config) {
  const raw = nonEmpty(config.paperclipApiUrl);
  if (!raw) throw new Error("paperclip_api_url_missing");
  const url = new URL(raw);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("paperclip_api_url_not_loopback");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("paperclip_api_url_invalid");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function issueId(ctx) {
  const wake = asObject(ctx.context.paperclipWake);
  const issue = asObject(wake.issue);
  return nonEmpty(ctx.context.issueId) ?? nonEmpty(ctx.context.taskId) ?? nonEmpty(issue.id);
}

function attempt(ctx) {
  return positiveInt(ctx.context.attempt ?? ctx.context.attemptNumber, 1, 1, 999);
}

function structuredProposalId(ctx) {
  const direct = nonEmpty(asObject(ctx.context.ragnosFleet).proposal_id);
  if (direct) return direct;
  const markdown = nonEmpty(ctx.context.paperclipTaskMarkdown) ?? "";
  const match = markdown.match(/```ragnos-fleet\s*\n([\s\S]*?)\n```/i);
  if (!match) return null;
  try {
    return nonEmpty(asObject(JSON.parse(match[1])).proposal_id);
  } catch {
    throw new Error("fleet_apply_payload_invalid");
  }
}

function boundedPrompt(ctx) {
  const markdown = nonEmpty(ctx.context.paperclipTaskMarkdown);
  if (!markdown) throw new Error("fleet_propose_prompt_missing");
  const bytes = Buffer.byteLength(markdown, "utf8");
  if (bytes > 64 * 1024) throw new Error("fleet_propose_prompt_too_large");
  return markdown;
}

function requestContext(ctx, op, key) {
  const issue = issueId(ctx);
  if (!issue) throw new Error("fleet_issue_id_missing");
  const revision = `paperclip:${ctx.agent.companyId}:${issue}:run:${ctx.runId}:attempt:${attempt(ctx)}`;
  const traceId = sha256(`paperclip-fleet-trace/v1\n${key}`).slice(0, 32);
  return {
    paperclip_refs: {
      approval_id: nonEmpty(ctx.context.approvalId),
      company_id: ctx.agent.companyId,
      employee_id: ctx.agent.id,
      issue_id: issue,
      operation: op,
      run_id: ctx.runId,
    },
    pipeline_run_id: `paperclip-fleet-${sha256(key).slice(0, 32)}`,
    revision,
    trace_id: traceId,
  };
}

function submission(ctx, op, key) {
  const base = {
    context: requestContext(ctx, op, key),
    idempotency_key: key,
    protocol_version: PROTOCOL_VERSION,
  };
  if (op === "propose") return { ...base, prompt: boundedPrompt(ctx) };
  const approvalId = nonEmpty(ctx.context.approvalId);
  const approvalStatus = nonEmpty(ctx.context.approvalStatus)?.toLowerCase();
  if (!approvalId || approvalStatus !== "approved") {
    throw new Error("fleet_apply_approval_required");
  }
  const proposalId = structuredProposalId(ctx);
  if (!proposalId || !/^proposal_[A-Za-z0-9_-]{16,191}$/.test(proposalId)) {
    throw new Error("fleet_apply_proposal_id_invalid");
  }
  return { ...base, confirmation: "apply", proposal_id: proposalId };
}

function safePublicResult(value) {
  const source = asObject(value);
  const result = {};
  for (const [key, entry] of Object.entries(source)) {
    if (key === "result") {
      result.result = safePublicResult(entry);
    } else if (SAFE_PUBLIC_FIELDS.has(key)) {
      result[key] = entry;
    }
  }
  return result;
}

function statusResult(status, upstream) {
  const publicResult = safePublicResult(upstream);
  const failed = status === "failed" || status === "timeout";
  const cancelled = status === "cancelled" || status === "canceled";
  return {
    exitCode: failed || cancelled ? 1 : 0,
    signal: null,
    timedOut: status === "timeout",
    ...(failed || cancelled
      ? {
          errorCode: cancelled ? "fleet_cancelled" : `fleet_${status}`,
          errorMessage: cancelled ? "Fleet job cancelled." : `Fleet job ended with ${status}.`,
        }
      : {}),
    resultJson: {
      adapter: "ragnos_fleet",
      protocol_version: PROTOCOL_VERSION,
      ...publicResult,
    },
    summary: `Fleet ${publicResult.operation ?? "job"} ${publicResult.job_id ?? "unknown"}: ${status}`,
  };
}

async function signedFetch(state, method, path, payload, idempotency) {
  const body = payload == null ? Buffer.alloc(0) : Buffer.from(canonicalJson(payload));
  const headers = signRequest({
    actorHash: state.actor,
    body,
    idempotencyKey: idempotency,
    key: state.key,
    keyId: state.keyId,
    method,
    path,
  });
  const response = await fetch(new URL(path, state.baseUrl), {
    method,
    headers: {
      ...headers,
      Accept: "application/json",
      ...(body.length ? { "Content-Type": "application/json" } : {}),
    },
    body: body.length ? body : undefined,
    signal: AbortSignal.timeout(state.requestTimeoutMs),
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`fleet_gateway_http_${response.status}`);
    error.status = response.status;
    error.responseCode = nonEmpty(asObject(responseBody).code);
    throw error;
  }
  return asObject(responseBody);
}

async function paperclipRunCancelled(ctx, state) {
  if (!ctx.authToken) return false;
  try {
    const response = await fetch(
      new URL(`/api/heartbeat-runs/${encodeURIComponent(ctx.runId)}`, state.paperclipApiUrl),
      {
        headers: { Authorization: `Bearer ${ctx.authToken}`, Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(state.requestTimeoutMs, 2_000)),
      },
    );
    if (!response.ok) return false;
    const payload = asObject(await response.json());
    return new Set(["cancelled", "canceled", "timed_out"]).has(
      String(payload.status ?? "").toLowerCase(),
    );
  } catch {
    return false;
  }
}

function dispositionComment(result, op) {
  const safe = safePublicResult(result);
  const payload = {};
  for (const key of [
    "agent_run_id",
    "idempotency_key",
    "job_id",
    "proposal_id",
    "receipt_id",
    "status",
    "trace_id",
    "workspace_id",
  ]) {
    if (safe[key] !== undefined) payload[key] = safe[key];
    if (safe.result?.[key] !== undefined) payload[key] = safe.result[key];
  }
  return [
    op === "propose"
      ? "Fleet proposal is ready for human review."
      : "Approved Fleet proposal was applied.",
    "",
    "```ragnos-fleet",
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

async function paperclipJson(ctx, state, method, path, body) {
  if (!ctx.authToken) throw new Error("paperclip_auth_token_missing");
  const response = await fetch(new URL(path, state.paperclipApiUrl), {
    method,
    headers: {
      Authorization: `Bearer ${ctx.authToken}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(Math.min(state.requestTimeoutMs, 2_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`paperclip_http_${response.status}`);
  return asObject(payload);
}

async function publishPaperclipDisposition(ctx, state, op, result) {
  const issue = issueId(ctx);
  if (!issue) throw new Error("fleet_issue_id_missing");
  const targetStatus = op === "propose" ? "in_review" : "done";
  const current = await paperclipJson(
    ctx,
    state,
    "GET",
    `/api/issues/${encodeURIComponent(issue)}`,
  );
  if (current.status === targetStatus) return;
  const reviewerId = op === "propose"
    ? nonEmpty(current.responsibleUserId) ?? nonEmpty(current.createdByUserId)
    : null;
  if (op === "propose" && !reviewerId) {
    throw new Error("paperclip_human_reviewer_missing");
  }
  await paperclipJson(
    ctx,
    state,
    "PATCH",
    `/api/issues/${encodeURIComponent(issue)}`,
    {
      status: targetStatus,
      comment: dispositionComment(result, op),
      ...(reviewerId ? { assigneeAgentId: null, assigneeUserId: reviewerId } : {}),
    },
  );
}

async function cancelUpstream(state, jobId, reason) {
  const path = `/jobs/${encodeURIComponent(jobId)}/cancel`;
  const key = `pcf-cancel:${sha256(`${state.idempotency}\n${reason}`)}`;
  const payload = { idempotency_key: key, protocol_version: PROTOCOL_VERSION };
  return signedFetch(state, "POST", path, payload, key);
}

export async function execute(ctx) {
  const config = asObject(ctx.config);
  const op = operation(config);
  const issue = issueId(ctx);
  if (!issue) throw new Error("fleet_issue_id_missing");
  const key = idempotencyKey({
    attempt: attempt(ctx),
    companyId: ctx.agent.companyId,
    issueId: issue,
    operation: op,
    runId: ctx.runId,
  });
  const state = {
    actor: actorHash(ctx.agent.companyId, ctx.agent.id),
    baseUrl: gatewayUrl(config),
    idempotency: key,
    key: decodeHmacKey(config.hmacKeyB64),
    keyId: nonEmpty(config.keyId),
    paperclipApiUrl: paperclipApiUrl(config),
    requestTimeoutMs: positiveInt(config.requestTimeoutMs, 5_000, 250, 30_000),
  };
  if (!state.keyId) throw new Error("fleet_key_id_missing");
  const payload = submission(ctx, op, key);
  const accepted = await signedFetch(state, "POST", `/${op}`, payload, key);
  const jobId = nonEmpty(accepted.job_id);
  if (!jobId) throw new Error("fleet_job_id_missing");
  await ctx.onEvent?.({
    eventType: "fleet.lifecycle",
    level: "info",
    message: "Fleet job accepted.",
    payload: safePublicResult(accepted),
  });

  const timeoutMs = positiveInt(config.timeoutMs, 10 * 60_000, 500, 60 * 60_000);
  const startedAt = Date.now();
  let priorStatus = nonEmpty(accepted.status) ?? "queued";
  while (Date.now() - startedAt < timeoutMs) {
    if (await paperclipRunCancelled(ctx, state)) {
      const cancelled = await cancelUpstream(state, jobId, "paperclip_cancelled");
      return statusResult(nonEmpty(cancelled.status) ?? "cancelled", {
        ...accepted,
        ...cancelled,
      });
    }
    const waitMs = positiveInt(accepted.poll_after_ms, positiveInt(config.pollAfterMs, 1_000, 50, 30_000), 50, 30_000);
    await delay(waitMs);
    const statusKey = `pcf-status:${sha256(`${key}\n${jobId}\n${Date.now()}`)}`;
    const current = await signedFetch(
      state,
      "GET",
      `/jobs/${encodeURIComponent(jobId)}`,
      null,
      statusKey,
    );
    const status = nonEmpty(current.status) ?? "unknown";
    if (status !== priorStatus) {
      priorStatus = status;
      await ctx.onEvent?.({
        eventType: "fleet.lifecycle",
        level: status === "failed" ? "error" : "info",
        message: `Fleet job status: ${status}.`,
        payload: safePublicResult(current),
      });
    }
    if (TERMINAL.has(status)) {
      const result = statusResult(status, current);
      if (status === "succeeded") {
        await publishPaperclipDisposition(ctx, state, op, current);
      }
      return result;
    }
  }
  const cancelled = await cancelUpstream(state, jobId, "paperclip_timeout").catch(() => accepted);
  return {
    ...statusResult("timeout", { ...accepted, ...cancelled }),
    timedOut: true,
    signal: "SIGTERM",
  };
}

export async function testEnvironment(ctx) {
  const checks = [];
  try {
    const base = gatewayUrl(asObject(ctx.config));
    paperclipApiUrl(asObject(ctx.config));
    decodeHmacKey(ctx.config.hmacKeyB64);
    if (!nonEmpty(ctx.config.keyId)) throw new Error("fleet_key_id_missing");
    const health = await fetch(new URL("/health", base), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    checks.push({
      code: health.ok ? "fleet_health_ok" : "fleet_health_failed",
      level: health.ok ? "info" : "error",
      message: health.ok ? "Fleet health endpoint is reachable." : `Fleet health returned HTTP ${health.status}.`,
    });
    const ready = await fetch(new URL("/ready", base), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    checks.push({
      code: ready.ok ? "fleet_ready" : "fleet_not_ready",
      level: ready.ok ? "info" : "warn",
      message: ready.ok ? "Fleet readiness is green." : `Fleet readiness returned HTTP ${ready.status}.`,
    });
  } catch (error) {
    checks.push({
      code: "fleet_environment_invalid",
      level: "error",
      message: error instanceof Error ? error.message : "Fleet environment invalid.",
    });
  }
  return {
    adapterType: ctx.adapterType,
    checks,
    status: checks.some((entry) => entry.level === "error")
      ? "fail"
      : checks.some((entry) => entry.level === "warn")
        ? "warn"
        : "pass",
    testedAt: new Date().toISOString(),
  };
}

export const testExports = Object.freeze({
  requestContext,
  dispositionComment,
  paperclipApiUrl,
  safePublicResult,
  structuredProposalId,
  submission,
});
