import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const PROTOCOL_VERSION = "2026-07-21";
export const SIGNATURE_VERSION = "v1";

export const HEADER = Object.freeze({
  actorHash: "X-Codex-Actor-Hash",
  bodySha256: "X-Keez-Body-SHA256",
  idempotencyKey: "X-Keez-Idempotency-Key",
  keyId: "X-Keez-Key-Id",
  nonce: "X-Keez-Nonce",
  signature: "X-Keez-Signature",
  timestamp: "X-Keez-Timestamp",
  version: "X-Keez-Signature-Version",
});

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SAFE_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

export function canonicalJson(value) {
  return JSON.stringify(sorted(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function decodeHmacKey(value) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error("fleet_hmac_key_missing");
  const key = Buffer.from(text, "base64url");
  if (key.length < 32 || key.length > 128) {
    throw new Error("fleet_hmac_key_invalid");
  }
  return key;
}

export function actorHash(companyId, employeeId) {
  const identity = canonicalJson({
    company_id: requiredId(companyId, "company_id"),
    employee_id: requiredId(employeeId, "employee_id"),
  });
  return sha256(`paperclip-fleet-actor/v1\n${identity}`);
}

export function idempotencyKey(input) {
  const identity = canonicalJson({
    attempt: positiveInteger(input.attempt, "attempt"),
    company_id: requiredId(input.companyId, "company_id"),
    issue_id: requiredId(input.issueId, "issue_id"),
    operation: requiredOperation(input.operation),
    run_id: requiredId(input.runId, "run_id"),
  });
  return `pcf-v1:${sha256(`paperclip-fleet-idempotency/v1\n${identity}`)}`;
}

export function canonicalRequest(input) {
  const fields = canonicalJson({
    body_sha256: requireSha(input.bodySha256, "body_sha256"),
    idempotency_key: requireSafeId(input.idempotencyKey, "idempotency_key"),
    key_id: requireKeyId(input.keyId),
    method: requiredMethod(input.method),
    nonce: requireNonce(input.nonce),
    path: requiredPath(input.path),
    timestamp: integer(input.timestamp, "timestamp"),
  });
  return `keez-execution-gateway/v1\n${fields}`;
}

export function signRequest(input) {
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body ?? "");
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(24).toString("base64url");
  const actor = requireSha(input.actorHash, "actor_hash");
  const key = Buffer.isBuffer(input.key) ? input.key : decodeHmacKey(input.key);
  const bodyHash = sha256(body);
  const canonical = `${canonicalRequest({
    keyId: input.keyId,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: bodyHash,
    idempotencyKey: input.idempotencyKey,
  })}\nactor_hash:${actor}`;
  const signature = createHmac("sha256", key).update(canonical, "ascii").digest("base64url");
  return {
    [HEADER.actorHash]: actor,
    [HEADER.bodySha256]: bodyHash,
    [HEADER.idempotencyKey]: input.idempotencyKey,
    [HEADER.keyId]: input.keyId,
    [HEADER.nonce]: nonce,
    [HEADER.signature]: signature,
    [HEADER.timestamp]: String(timestamp),
    [HEADER.version]: SIGNATURE_VERSION,
  };
}

export function verifyRequest(input) {
  const headers = lowerCaseHeaders(input.headers);
  const required = Object.values(HEADER).map((name) => name.toLowerCase());
  if (required.some((name) => !headers.has(name))) throw new Error("header_missing");
  if (headers.get(HEADER.version.toLowerCase()) !== SIGNATURE_VERSION) {
    throw new Error("signature_version_invalid");
  }
  const timestamp = integer(headers.get(HEADER.timestamp.toLowerCase()), "timestamp");
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.maxSkewSeconds ?? 60)) {
    throw new Error("timestamp_out_of_window");
  }
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body ?? "");
  const suppliedBodyHash = headers.get(HEADER.bodySha256.toLowerCase());
  if (suppliedBodyHash !== sha256(body)) throw new Error("body_mismatch");
  const keyId = requireKeyId(headers.get(HEADER.keyId.toLowerCase()));
  const key = input.keys.get(keyId);
  if (!key) throw new Error("unknown_key");
  const actor = requireSha(headers.get(HEADER.actorHash.toLowerCase()), "actor_hash");
  const idempotency = requireSafeId(
    headers.get(HEADER.idempotencyKey.toLowerCase()),
    "idempotency_key",
  );
  const nonce = requireNonce(headers.get(HEADER.nonce.toLowerCase()));
  const canonical = `${canonicalRequest({
    keyId,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodySha256: suppliedBodyHash,
    idempotencyKey: idempotency,
  })}\nactor_hash:${actor}`;
  const expected = createHmac("sha256", key).update(canonical, "ascii").digest("base64url");
  const supplied = String(headers.get(HEADER.signature.toLowerCase()));
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Error("signature_mismatch");
  }
  return { actorHash: actor, idempotencyKey: idempotency, keyId, nonce, timestamp };
}

function lowerCaseHeaders(raw) {
  const result = new Map();
  for (const [name, value] of raw instanceof Headers ? raw.entries() : Object.entries(raw)) {
    const key = String(name).trim().toLowerCase();
    if (result.has(key)) throw new Error("header_duplicate");
    result.set(key, String(value));
  }
  return result;
}

function requiredId(value, field) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 200 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error(`${field}_invalid`);
  }
  return text;
}

function requireSafeId(value, field) {
  const text = String(value ?? "").trim();
  if (!SAFE_ID.test(text)) throw new Error(`${field}_invalid`);
  return text;
}

function requireKeyId(value) {
  const text = String(value ?? "").trim();
  if (!SAFE_KEY_ID.test(text)) throw new Error("key_id_invalid");
  return text;
}

function requireNonce(value) {
  const text = String(value ?? "").trim();
  if (!SAFE_NONCE.test(text)) throw new Error("nonce_invalid");
  return text;
}

function requireSha(value, field) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!SHA256.test(text)) throw new Error(`${field}_invalid`);
  return text;
}

function requiredMethod(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(text)) throw new Error("method_invalid");
  return text;
}

function requiredPath(value) {
  const text = String(value ?? "");
  if (!text.startsWith("/") || text.length > 2048 || /[\x00-\x1f\x7f]/.test(text)) {
    throw new Error("path_invalid");
  }
  return text;
}

function integer(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${field}_invalid`);
  return parsed;
}

function positiveInteger(value, field) {
  const parsed = integer(value, field);
  if (parsed < 1) throw new Error(`${field}_invalid`);
  return parsed;
}

function requiredOperation(value) {
  const text = String(value ?? "").trim();
  if (text !== "propose" && text !== "apply") throw new Error("operation_invalid");
  return text;
}
