import { z } from "zod";
import {
  COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE,
  companyWorkProjectionItemSchema,
} from "./company-work-projection.js";

export const COMPANY_WORK_PROJECTION_V2_API_VERSION = "paperclip.company-work-projection/v2" as const;
export const COMPANY_WORK_PROJECTION_V2_SCHEMA_VERSION = 2 as const;
export const COMPANY_WORK_PROJECTION_V2_CREDENTIAL_TOKEN_VERSION = 2 as const;

const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const instantSchema = z.string().datetime({ offset: true });
const normalizedReferenceSchema = (maximum: number) => z.string()
  .min(1)
  .max(maximum)
  .refine((value) => value === value.trim(), "References must already be normalized");
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const pathSchema = normalizedReferenceSchema(1_024);

export const companyWorkProjectionV2IntentSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("repository_change"),
    repository: normalizedReferenceSchema(1_024),
    baseRevision: normalizedReferenceSchema(256),
    allowedPaths: z.array(pathSchema).max(100),
    prohibitedPaths: z.array(pathSchema).max(100),
  }).strict(),
  z.object({
    type: z.literal("program_transition"),
    programReference: normalizedReferenceSchema(1_024),
    transition: normalizedReferenceSchema(256),
  }).strict(),
  z.object({
    type: z.literal("tracker_update"),
    trackerReference: normalizedReferenceSchema(1_024),
    operation: normalizedReferenceSchema(256),
  }).strict(),
  z.object({
    type: z.literal("runtime_operation"),
    systemReference: normalizedReferenceSchema(1_024),
    operation: normalizedReferenceSchema(256),
  }).strict(),
  z.object({
    type: z.literal("artifact_delivery"),
    artifactReference: normalizedReferenceSchema(1_024),
    destinationReference: normalizedReferenceSchema(1_024),
  }).strict(),
]);

export const companyWorkProjectionV2DelegationSchema = z.object({
  onBehalfOf: z.object({
    type: z.literal("human"),
    id: normalizedReferenceSchema(256),
  }).strict(),
  grantReference: normalizedReferenceSchema(1_024),
  grantDigest: sha256Schema,
  grantedAt: instantSchema,
}).strict();

/** Explicit issue-owned source data. No title or description is exported. */
export const issueWorkProjectionContextSchema = z.object({
  objective: z.string().trim().min(1).max(1_000),
  objectiveExportApproved: z.literal(true),
  intent: companyWorkProjectionV2IntentSchema.nullable(),
  delegation: companyWorkProjectionV2DelegationSchema.nullable(),
}).strict();

export const companyWorkProjectionV2UnavailableReasonSchema = z.enum([
  "unassigned",
  "missing_delegation",
  "unsupported_target",
  "restricted_objective",
]);

const humanActorSchema = z.object({
  type: z.literal("human"),
  id: normalizedReferenceSchema(256),
}).strict();
const agentActorSchema = z.object({
  type: z.literal("agent"),
  id: z.string().uuid(),
}).strict();

export const companyWorkProjectionV2SourceReceiptSchema = z.object({
  contractVersion: z.literal(COMPANY_WORK_PROJECTION_V2_API_VERSION),
  reference: normalizedReferenceSchema(2_048),
  revision: revisionSchema,
  digest: sha256Schema,
  issuedAt: instantSchema,
}).strict();

export const companyWorkProjectionV2PacketContextSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("unavailable"),
    reason: companyWorkProjectionV2UnavailableReasonSchema,
  }).strict(),
  z.object({
    availability: z.literal("ready"),
    objective: z.string().trim().min(1).max(1_000),
    intent: companyWorkProjectionV2IntentSchema,
    actor: z.union([humanActorSchema, agentActorSchema]),
    delegation: companyWorkProjectionV2DelegationSchema.nullable(),
    sourceReceipt: companyWorkProjectionV2SourceReceiptSchema,
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.availability !== "ready") return;
  if (value.actor.type === "human" && value.delegation !== null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Human-owned work cannot carry agent delegation",
      path: ["delegation"],
    });
  }
  if (value.actor.type === "agent" && value.delegation === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent-owned work requires delegation",
      path: ["delegation"],
    });
  }
});

export const companyWorkProjectionV2ItemSchema = companyWorkProjectionItemSchema.extend({
  packetContext: companyWorkProjectionV2PacketContextSchema,
}).strict();

export const companyWorkProjectionV2ResponseSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_PROJECTION_V2_API_VERSION),
  schemaVersion: z.literal(COMPANY_WORK_PROJECTION_V2_SCHEMA_VERSION),
  companyId: z.string().uuid(),
  snapshot: z.object({
    revision: revisionSchema,
    issuedAt: instantSchema,
    expiresAt: instantSchema,
  }).strict(),
  items: z.array(companyWorkProjectionV2ItemSchema).max(COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE),
  page: z.object({
    size: z.number().int().min(0).max(COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE),
    hasMore: z.boolean(),
    nextCursor: z.string().min(1).max(4_096).nullable(),
    completeness: z.enum(["partial", "complete"]),
  }).strict(),
  etag: z.string().regex(/^"[a-f0-9]{64}"$/),
}).strict();

export const companyWorkProjectionV2CredentialSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  tokenVersion: z.literal(COMPANY_WORK_PROJECTION_V2_CREDENTIAL_TOKEN_VERSION),
  createdAt: instantSchema,
  revokedAt: instantSchema.nullable(),
}).strict();

export const createdCompanyWorkProjectionV2CredentialSchema = companyWorkProjectionV2CredentialSchema.extend({
  token: z.string().regex(/^pcwp_v2_[a-f0-9]{48}$/),
}).strict();

export type IssueWorkProjectionContext = z.infer<typeof issueWorkProjectionContextSchema>;
export type CompanyWorkProjectionV2Intent = z.infer<typeof companyWorkProjectionV2IntentSchema>;
export type CompanyWorkProjectionV2Delegation = z.infer<typeof companyWorkProjectionV2DelegationSchema>;
export type CompanyWorkProjectionV2Item = z.infer<typeof companyWorkProjectionV2ItemSchema>;
export type CompanyWorkProjectionV2Response = z.infer<typeof companyWorkProjectionV2ResponseSchema>;
export type CompanyWorkProjectionV2Credential = z.infer<typeof companyWorkProjectionV2CredentialSchema>;
export type CreatedCompanyWorkProjectionV2Credential = z.infer<
  typeof createdCompanyWorkProjectionV2CredentialSchema
>;
