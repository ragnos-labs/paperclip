import { createServer } from "node:http";
import { sha256, decodeHmacKey, verifyRequest } from "../../packages/ragnos-fleet/src/protocol.js";

const ALLOWED_SCENARIOS = new Set([
  "cancelled",
  "delayed",
  "failed",
  "queued",
  "rate_limited",
  "running",
  "succeeded",
  "timeout",
  "unavailable",
]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const FORBIDDEN_AUTHORITY = new Set([
  "allowed_paths",
  "base_branch",
  "credential_pool_id",
  "github_repo",
  "policy_profile",
  "repo_id",
  "repository",
  "right_size_tier",
  "runner_pool_id",
  "tenant_id",
  "workspace_path",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function exactKeys(value, required) {
  const actual = Object.keys(asObject(value)).sort();
  const expected = [...required].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasForbiddenAuthority(value) {
  if (Array.isArray(value)) return value.some(hasForbiddenAuthority);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, entry]) => FORBIDDEN_AUTHORITY.has(key) || hasForbiddenAuthority(entry),
  );
}

function scenario(payload) {
  const direct = String(asObject(payload.context).test_scenario ?? "").trim().toLowerCase();
  if (ALLOWED_SCENARIOS.has(direct)) return direct;
  const prompt = String(payload.prompt ?? "");
  const match = prompt.match(/\[fleet-scenario:([a-z_]+)\]/i);
  const fromPrompt = match?.[1]?.toLowerCase();
  return ALLOWED_SCENARIOS.has(fromPrompt) ? fromPrompt : "succeeded";
}

function deterministicId(prefix, seed, length = 24) {
  return `${prefix}_${sha256(seed).slice(0, length)}`;
}

function safeError(response, status, code) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ code, status: "error" }));
}

function json(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readBody(request, maximum = 1_048_576) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseKeys(raw) {
  const source = asObject(JSON.parse(raw || "{}"));
  const keys = new Map();
  const tenants = new Map();
  for (const [keyId, entryRaw] of Object.entries(source)) {
    const entry = asObject(entryRaw);
    const tenantId = String(entry.tenant_id ?? "").trim();
    if (!tenantId) throw new Error("fake_fleet_tenant_missing");
    keys.set(keyId, decodeHmacKey(entry.key_b64));
    tenants.set(keyId, tenantId);
  }
  if (keys.size < 1) throw new Error("fake_fleet_keys_missing");
  return { keys, tenants };
}

function validateSubmission(operation, payload, idempotency) {
  const required = operation === "propose"
    ? ["context", "idempotency_key", "prompt", "protocol_version"]
    : ["confirmation", "context", "idempotency_key", "proposal_id", "protocol_version"];
  if (!exactKeys(payload, required)) throw new Error("validation_error");
  if (payload.protocol_version !== "2026-07-21" || payload.idempotency_key !== idempotency) {
    throw new Error("validation_error");
  }
  const context = asObject(payload.context);
  const pipelineRunId = String(context.pipeline_run_id ?? "").trim();
  const traceId = String(context.trace_id ?? "").trim();
  if (
    !String(context.revision ?? "").trim()
    || !pipelineRunId
    || !/^[a-f0-9]{32}$/.test(traceId)
    || /^0+$/.test(traceId)
    || hasForbiddenAuthority(payload)
  ) {
    throw new Error("authoritative_field_forbidden");
  }
  if (operation === "propose") {
    if (!String(payload.prompt ?? "").trim()) throw new Error("validation_error");
  } else if (
    payload.confirmation !== "apply"
    || !/^proposal_[A-Za-z0-9_-]{16,191}$/.test(String(payload.proposal_id ?? ""))
  ) {
    throw new Error("validation_error");
  }
}

function publicJob(job) {
  const payload = {
    agent_run_id: job.agentRunId,
    cancel_requested: job.cancelRequested,
    created_at: job.createdAt,
    delivery_group: "paperclip-fleet-local",
    finalizer_state: TERMINAL.has(job.status) ? "complete" : "not_due",
    idempotency_key: job.idempotencyKey,
    job_id: job.jobId,
    operation: job.operation,
    ownership_keys: [`tenant:${job.tenantId}`],
    pipeline_run_id: job.pipelineRunId,
    plan_ref: "paperclip-local-fake",
    poll_after_ms: job.pollAfterMs,
    right_size_decision_id: deterministicId("rs", job.jobId),
    right_size_tier: "T3",
    status: job.status,
    trace_id: job.traceId,
    updated_at: job.updatedAt,
    workspace_id: job.workspaceId,
    workspace_state: TERMINAL.has(job.status) ? "cleaned" : "pending",
  };
  if (job.status === "failed") payload.error = { code: "synthetic_failure" };
  if (job.proposalId) payload.proposal_id = job.proposalId;
  if (job.status === "succeeded") {
    payload.result = {
      agent_run_id: job.agentRunId,
      job_id: job.jobId,
      proposal_id: job.proposalId,
      receipt_id: deterministicId("receipt", job.jobId),
      status: job.status,
      trace_id: job.traceId,
      workspace_id: job.workspaceId,
    };
    payload.cleanup_receipt_id = deterministicId("cleanup", job.jobId);
    if (job.operation === "propose") {
      const diffPreview = [
        "diff --git a/fixtures/proposal.txt b/fixtures/proposal.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/fixtures/proposal.txt",
        "@@ -0,0 +1 @@",
        "+synthetic governed proposal",
      ].join("\n");
      Object.assign(payload.result, {
        base_revision: sha256(`base:${job.jobId}`).slice(0, 40),
        changed_files: ["fixtures/proposal.txt"],
        diff_bytes: Buffer.byteLength(diffPreview, "utf8"),
        diff_preview: diffPreview,
        diff_sha256: sha256(diffPreview),
        repo_id: "ragnos-workspace",
        revision: sha256(`revision:${job.jobId}`).slice(0, 40),
      });
    }
  }
  return payload;
}

function advance(job) {
  job.polls += 1;
  if (job.cancelRequested) {
    job.status = "cancelled";
  } else if (job.scenario === "succeeded" && job.polls >= 1) {
    job.status = "succeeded";
  } else if (job.scenario === "failed" && job.polls >= 1) {
    job.status = "failed";
  } else if (job.scenario === "cancelled" && job.polls >= 1) {
    job.status = "cancelled";
  } else if (job.scenario === "delayed") {
    job.status = job.polls === 1 ? "queued" : job.polls === 2 ? "running" : "succeeded";
  } else if (job.scenario === "rate_limited" && job.polls >= 3) {
    job.status = "succeeded";
  } else if (job.scenario === "running" || job.scenario === "timeout") {
    job.status = "running";
  } else {
    job.status = "queued";
  }
  job.updatedAt = new Date().toISOString();
}

export function createFakeFleetBroker(options = {}) {
  const parsed = options.keys
    ? options
    : parseKeys(process.env.FLEET_FAKE_KEYS_JSON);
  const keys = parsed.keys;
  const tenants = parsed.tenants;
  const jobs = new Map();
  const idempotency = new Map();
  const nonces = new Set();
  const ready = options.ready ?? process.env.FLEET_FAKE_READY !== "0";
  const runtimeSha = options.runtimeSha ?? sha256("fake-fleet-broker/v1").slice(0, 40);

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fake-fleet.local");
      if (request.method === "GET" && url.pathname === "/health") {
        return json(response, 200, { runtime_sha: runtimeSha, status: "ok" });
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        return json(response, ready ? 200 : 503, {
          code: ready ? "ready" : "runner_not_ready",
          runtime_sha: runtimeSha,
          status: ready ? "ready" : "error",
        });
      }

      const body = await readBody(request);
      let auth;
      try {
        auth = verifyRequest({
          body,
          headers: request.headers,
          keys,
          method: request.method,
          path: url.pathname,
        });
      } catch (error) {
        return safeError(response, 401, error instanceof Error ? error.message : "authentication_failed");
      }
      const nonceIdentity = `${auth.keyId}:${auth.nonce}`;
      if (nonces.has(nonceIdentity)) return safeError(response, 409, "nonce_replayed");
      nonces.add(nonceIdentity);

      const tenantId = tenants.get(auth.keyId);
      if (!tenantId) return safeError(response, 403, "tenant_forbidden");
      const identity = `${tenantId}:${auth.keyId}:${auth.actorHash}`;
      const submitMatch = request.method === "POST" && /^\/(propose|apply)$/.exec(url.pathname);
      if (submitMatch) {
        const operation = submitMatch[1];
        const payload = asObject(JSON.parse(body.toString("utf8")));
        validateSubmission(operation, payload, auth.idempotencyKey);
        const selectedScenario = scenario(payload);
        if (selectedScenario === "unavailable") return safeError(response, 503, "gateway_unavailable");
        const dedupeKey = `${identity}:${auth.idempotencyKey}`;
        const requestHash = sha256(body);
        const prior = idempotency.get(dedupeKey);
        if (prior) {
          if (prior.requestHash !== requestHash) return safeError(response, 409, "idempotency_conflict");
          return json(response, 202, publicJob(jobs.get(prior.jobId)));
        }
        const jobId = deterministicId("job", dedupeKey);
        const now = new Date().toISOString();
        const proposalId = operation === "propose"
          ? deterministicId("proposal", jobId, 24)
          : String(payload.proposal_id);
        const job = {
          actorHash: auth.actorHash,
          agentRunId: deterministicId("agent_run", jobId),
          cancelRequested: false,
          createdAt: now,
          idempotencyKey: auth.idempotencyKey,
          jobId,
          keyId: auth.keyId,
          operation,
          pipelineRunId: String(asObject(payload.context).pipeline_run_id),
          pollAfterMs: options.pollAfterMs ?? 50,
          polls: 0,
          proposalId,
          requestHash,
          scenario: selectedScenario,
          status: "queued",
          tenantId,
          traceId: String(asObject(payload.context).trace_id ?? sha256(jobId).slice(0, 32)),
          updatedAt: now,
          workspaceId: deterministicId("workspace", jobId),
        };
        jobs.set(jobId, job);
        idempotency.set(dedupeKey, { jobId, requestHash });
        return json(response, 202, publicJob(job));
      }

      const statusMatch = request.method === "GET" && /^\/jobs\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
      const cancelMatch = request.method === "POST" && /^\/jobs\/([A-Za-z0-9._:-]+)\/cancel$/.exec(url.pathname);
      const match = statusMatch || cancelMatch;
      if (!match) return safeError(response, 404, "job_not_found");
      const job = jobs.get(match[1]);
      if (!job || job.keyId !== auth.keyId || job.actorHash !== auth.actorHash || job.tenantId !== tenantId) {
        return safeError(response, 404, "job_not_found");
      }
      if (statusMatch) {
        if (job.scenario === "rate_limited" && job.polls < 2) {
          job.polls += 1;
          return safeError(response, 429, "quota_exceeded");
        }
        advance(job);
        return json(response, 200, publicJob(job));
      }
      const payload = asObject(JSON.parse(body.toString("utf8")));
      if (!exactKeys(payload, ["idempotency_key", "protocol_version"])
          || payload.protocol_version !== "2026-07-21"
          || payload.idempotency_key !== auth.idempotencyKey) {
        return safeError(response, 400, "validation_error");
      }
      job.cancelRequested = true;
      job.status = "cancelled";
      job.updatedAt = new Date().toISOString();
      return json(response, 200, publicJob(job));
    } catch (error) {
      return safeError(response, 400, error instanceof Error ? error.message : "validation_error");
    }
  });
  return { jobs, server };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const { server } = createFakeFleetBroker();
  server.listen(port, host, () => {
    process.stdout.write(`fake-fleet-broker listening on ${host}:${port}\n`);
  });
}
