import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  COMPANY_WORK_PROJECTION_API_VERSION,
  COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { HttpError } from "../errors.js";

const cursorPayloadSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_PROJECTION_API_VERSION),
  schemaVersion: z.literal(COMPANY_WORK_PROJECTION_SCHEMA_VERSION),
  companyId: z.string().uuid(),
  snapshotRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  afterRevision: z.string().regex(/^(0|[1-9][0-9]*)$/),
  afterIssueId: z.string().uuid().nullable(),
  pageSize: z.number().int().min(1).max(500),
}).strict();

export type CompanyWorkProjectionCursor = z.infer<typeof cursorPayloadSchema>;

function cursorError(message: string, code = "WORK_PROJECTION_MALFORMED", status = 400): never {
  throw new HttpError(status, message, { code });
}

function masterSecret(): string | null {
  return process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || null;
}

function signingKey(companyId: string, secretOverride?: string): Buffer {
  const secret = secretOverride ?? masterSecret();
  if (!secret) {
    throw new HttpError(503, "Work projection signing key is unavailable", {
      code: "WORK_PROJECTION_UNAVAILABLE",
    });
  }
  return createHmac("sha256", secret)
    .update(`company-work-projection-cursor:v1:${resolvePaperclipInstanceId()}:${companyId}`)
    .digest();
}

function signature(payload: string, companyId: string, secretOverride?: string): string {
  return createHmac("sha256", signingKey(companyId, secretOverride)).update(payload).digest("base64url");
}

export function encodeCompanyWorkProjectionCursor(
  value: CompanyWorkProjectionCursor,
  secretOverride?: string,
): string {
  const payload = Buffer.from(JSON.stringify(cursorPayloadSchema.parse(value)), "utf8").toString("base64url");
  return `${payload}.${signature(payload, value.companyId, secretOverride)}`;
}

export function decodeCompanyWorkProjectionCursor(
  token: string,
  expectedCompanyId: string,
  now: Date,
  secretOverride?: string,
): CompanyWorkProjectionCursor {
  const parts = token.split(".");
  if (parts.length !== 2) cursorError("Malformed work projection cursor");
  const [payload, suppliedSignature] = parts;

  let unknownValue: unknown;
  try {
    unknownValue = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    cursorError("Malformed work projection cursor");
  }
  const expectedSignature = signature(payload, expectedCompanyId, secretOverride);
  const left = Buffer.from(suppliedSignature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    cursorError("Malformed work projection cursor");
  }

  const parsed = cursorPayloadSchema.safeParse(unknownValue);
  if (!parsed.success) {
    const raw = unknownValue as Record<string, unknown> | null;
    if (
      raw &&
      (raw.apiVersion !== COMPANY_WORK_PROJECTION_API_VERSION ||
        raw.schemaVersion !== COMPANY_WORK_PROJECTION_SCHEMA_VERSION)
    ) {
      cursorError("Incompatible work projection cursor version", "WORK_PROJECTION_INCOMPATIBLE", 409);
    }
    cursorError("Malformed work projection cursor");
  }

  if (parsed.data.companyId !== expectedCompanyId) {
    cursorError("Work projection cursor belongs to another company", "WORK_PROJECTION_FORBIDDEN", 403);
  }

  if (new Date(parsed.data.expiresAt).getTime() <= now.getTime()) {
    cursorError("Work projection snapshot expired", "WORK_PROJECTION_SNAPSHOT_EXPIRED", 410);
  }
  return parsed.data;
}
