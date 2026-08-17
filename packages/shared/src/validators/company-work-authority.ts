import { z } from "zod";
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "../constants.js";

export const COMPANY_WORK_AUTHORITY_API_VERSION = "paperclip.company-work-authority/v1" as const;
export const COMPANY_WORK_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const COMPANY_WORK_AUTHORITY_CREDENTIAL_TOKEN_VERSION = 3 as const;
export const COMPANY_WORK_AUTHORITY_MAX_ITEMS = 1_000 as const;

const revisionSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instantSchema = z.string().datetime({ offset: true });
const referenceSchema = z.string().trim().min(1).max(1_024);
const userReferenceSchema = z.string().trim().min(1).max(256);

export const companyWorkAuthorityOwnerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("agent"), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal("human"), id: userReferenceSchema }).strict(),
  z.object({ type: z.literal("unassigned") }).strict(),
]);

export const issueWorkAuthorityContextSchema = z.object({
  stableWorkRef: referenceSchema,
  startAt: instantSchema.nullable(),
  dueAt: instantSchema.nullable(),
  nextAction: z.string().trim().min(1).max(2_000).nullable(),
  doneCriteria: z.string().trim().min(1).max(4_000).nullable(),
  evidenceRefs: z.array(referenceSchema).max(100),
  milestoneRef: referenceSchema.nullable(),
  privacyClass: z.enum(["public", "internal", "restricted"]),
  historicalAliases: z.array(referenceSchema).max(100),
  accountableHumanRef: userReferenceSchema,
  approverRef: userReferenceSchema,
}).strict().superRefine((value, ctx) => {
  if (value.approverRef === value.accountableHumanRef) return;
  if (!value.approverRef.trim() || !value.accountableHumanRef.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Accountability references must be explicit" });
  }
});

export const companyWorkAuthorityOperationSchema = z.enum([
  "record_create",
  "field_set",
  "owner_set",
  "date_set",
  "dependency_set",
  "status_set_nonterminal",
  "status_set_terminal",
  "evidence_link",
  "comment_create",
]);

const companyWorkAuthorityChangesSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  projectId: z.string().uuid().nullable().optional(),
  priority: z.enum(ISSUE_PRIORITIES).optional(),
  owner: companyWorkAuthorityOwnerSchema.optional(),
  startAt: instantSchema.nullable().optional(),
  dueAt: instantSchema.nullable().optional(),
  dependencyIssueIds: z.array(z.string().uuid()).max(100).optional(),
  status: z.enum(ISSUE_STATUSES).optional(),
  nextAction: z.string().trim().min(1).max(2_000).nullable().optional(),
  doneCriteria: z.string().trim().min(1).max(4_000).nullable().optional(),
  evidenceRefs: z.array(referenceSchema).max(100).optional(),
  parentId: z.string().uuid().nullable().optional(),
  milestoneRef: referenceSchema.nullable().optional(),
  privacyClass: z.enum(["public", "internal", "restricted"]).optional(),
  historicalAliases: z.array(referenceSchema).max(100).optional(),
  comment: z.string().trim().min(1).max(20_000).optional(),
}).strict();

export const companyWorkAuthorityActionSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_AUTHORITY_API_VERSION),
  companyId: z.string().uuid(),
  writerRef: referenceSchema,
  proposalRef: referenceSchema,
  proposalHash: digestSchema,
  proposalType: z.enum([
    "evidence_link", "field_change", "owner_route", "promote_current",
    "hold_current", "delivery_state", "accept_done", "new_work",
    "projection_repair",
  ]),
  approval: z.object({
    approvalRef: referenceSchema,
    authorityKind: z.literal("human"),
    approverRef: userReferenceSchema,
    decision: z.literal("approved"),
    proposalHash: digestSchema,
    authorityRevision: revisionSchema,
    policyDigest: digestSchema,
    decidedAt: instantSchema,
    expiresAt: instantSchema,
  }).strict(),
  serviceActorRef: referenceSchema,
  executionOwner: companyWorkAuthorityOwnerSchema,
  accountableHumanRef: userReferenceSchema,
  approverRef: userReferenceSchema,
  operation: companyWorkAuthorityOperationSchema,
  idempotencyKey: referenceSchema,
  expectedRevision: revisionSchema,
  policyDigest: digestSchema,
  issueId: z.string().uuid().nullable(),
  stableWorkRef: referenceSchema,
  changes: companyWorkAuthorityChangesSchema,
}).strict().superRefine((value, ctx) => {
  const isCreate = value.operation === "record_create";
  if (isCreate !== (value.issueId === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["issueId"], message: "Create is the only operation without an issue id" });
  }
  if (isCreate !== (value.expectedRevision === "0")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedRevision"], message: "Create requires revision zero" });
  }
  if (isCreate && !value.changes.title) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", "title"], message: "Create requires a title" });
  }
  if (isCreate && ["done", "cancelled"].includes(value.changes.status ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", "status"], message: "New work cannot start terminal" });
  }
  if (value.changes.owner !== undefined && JSON.stringify(value.changes.owner) !== JSON.stringify(value.executionOwner)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", "owner"], message: "Changed owner must match the routed execution owner" });
  }
  if (value.approval.approverRef !== value.approverRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "approverRef"], message: "Approval actor must match the action approver" });
  }
  if (value.approval.proposalHash !== value.proposalHash) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "proposalHash"], message: "Approval must bind the exact proposal hash" });
  }
  if (value.approval.authorityRevision !== value.expectedRevision) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "authorityRevision"], message: "Approval must bind the expected authority revision" });
  }
  if (value.approval.policyDigest !== value.policyDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval", "policyDigest"], message: "Approval must bind the exact policy digest" });
  }
  if (new Date(value.approval.decidedAt).getTime() > new Date(value.approval.expiresAt).getTime()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["approval"], message: "Approval is expired at decision time" });
  }
  if (value.operation === "status_set_terminal") {
    if (value.proposalType !== "accept_done" || value.changes.status !== "done") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", "status"], message: "Terminal Done requires an accept_done proposal" });
    }
  }
  if (value.operation === "status_set_nonterminal" && ["done", "cancelled"].includes(value.changes.status ?? "")) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes", "status"], message: "Nonterminal status operation cannot close work" });
  }
  const fieldsByOperation: Record<string, ReadonlySet<string>> = {
    record_create: new Set([
      "title", "projectId", "priority", "owner", "startAt", "dueAt",
      "dependencyIssueIds", "status", "nextAction", "doneCriteria",
      "evidenceRefs", "parentId", "milestoneRef", "privacyClass",
      "historicalAliases",
    ]),
    field_set: new Set(["title", "projectId", "priority", "nextAction", "doneCriteria", "parentId", "milestoneRef", "privacyClass", "historicalAliases"]),
    owner_set: new Set(["owner"]),
    date_set: new Set(["startAt", "dueAt"]),
    dependency_set: new Set(["dependencyIssueIds"]),
    status_set_nonterminal: new Set(["status"]),
    status_set_terminal: new Set(["status"]),
    evidence_link: new Set(["evidenceRefs"]),
    comment_create: new Set(["comment"]),
  };
  const allowed = fieldsByOperation[value.operation];
  const changed = Object.keys(value.changes);
  if (changed.length === 0 || changed.some((field) => !allowed.has(field))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["changes"], message: "Changes do not match the requested operation" });
  }
});

export const companyWorkAuthorityPreviewRequestSchema = z.object({
  action: companyWorkAuthorityActionSchema,
}).strict();

export const companyWorkAuthorityDispatchRequestSchema = z.object({
  action: companyWorkAuthorityActionSchema,
  previewHash: digestSchema,
}).strict();

export const companyWorkAuthorityPreviewResponseSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_AUTHORITY_API_VERSION),
  companyId: z.string().uuid(),
  requestDigest: digestSchema,
  previewHash: digestSchema,
  currentRevision: revisionSchema,
  state: z.enum(["preview_ready", "preview_held"]),
  reasonCode: referenceSchema,
  externalWrite: z.literal(false),
}).strict();

export const companyWorkAuthorityReceiptSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_AUTHORITY_API_VERSION),
  companyId: z.string().uuid(),
  requestDigest: digestSchema,
  idempotencyKey: referenceSchema,
  outcome: z.enum(["accepted", "rejected", "failed", "ambiguous"]),
  issueId: z.string().uuid().nullable(),
  stableWorkRef: referenceSchema,
  operation: companyWorkAuthorityOperationSchema,
  priorRevision: revisionSchema,
  resultRevision: revisionSchema.nullable(),
  changeRef: referenceSchema,
  readbackDigest: digestSchema.nullable(),
  serviceActorRef: referenceSchema,
  executionOwner: companyWorkAuthorityOwnerSchema,
  accountableHumanRef: userReferenceSchema,
  approverRef: userReferenceSchema,
  approvalRef: referenceSchema,
  policyDigest: digestSchema,
  reasonCode: referenceSchema,
  appliedAt: instantSchema.nullable(),
  replayed: z.boolean(),
  externalWrite: z.boolean(),
}).strict();

export const companyWorkAuthorityItemSchema = z.object({
  issueId: z.string().uuid(),
  stableWorkRef: referenceSchema,
  identifier: referenceSchema.nullable(),
  title: z.string().min(1).max(500),
  projectId: z.string().uuid().nullable(),
  priority: z.enum(ISSUE_PRIORITIES),
  owner: companyWorkAuthorityOwnerSchema,
  startAt: instantSchema.nullable(),
  dueAt: instantSchema.nullable(),
  dependencyIssueIds: z.array(z.string().uuid()).max(100),
  status: z.enum(ISSUE_STATUSES),
  nextAction: z.string().max(2_000).nullable(),
  doneCriteria: z.string().max(4_000).nullable(),
  evidenceRefs: z.array(referenceSchema).max(100),
  parentId: z.string().uuid().nullable(),
  milestoneRef: referenceSchema.nullable(),
  privacyClass: z.enum(["public", "internal", "restricted"]),
  historicalAliases: z.array(referenceSchema).max(100),
  accountableHumanRef: userReferenceSchema,
  approverRef: userReferenceSchema,
  revision: revisionSchema,
}).strict();

export const companyWorkAuthoritySnapshotSchema = z.object({
  apiVersion: z.literal(COMPANY_WORK_AUTHORITY_API_VERSION),
  schemaVersion: z.literal(COMPANY_WORK_AUTHORITY_SCHEMA_VERSION),
  companyId: z.string().uuid(),
  revision: revisionSchema,
  completeness: z.literal("complete"),
  observedAt: instantSchema,
  items: z.array(companyWorkAuthorityItemSchema).max(COMPANY_WORK_AUTHORITY_MAX_ITEMS),
  digest: digestSchema,
}).strict();

export const companyWorkAuthorityCredentialSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  tokenVersion: z.literal(COMPANY_WORK_AUTHORITY_CREDENTIAL_TOKEN_VERSION),
  createdAt: instantSchema,
  revokedAt: instantSchema.nullable(),
}).strict();

export const createdCompanyWorkAuthorityCredentialSchema = companyWorkAuthorityCredentialSchema.extend({
  token: z.string().regex(/^pcwp_v3_[a-f0-9]{48}$/),
}).strict();

export type IssueWorkAuthorityContext = z.infer<typeof issueWorkAuthorityContextSchema>;
export type CompanyWorkAuthorityAction = z.infer<typeof companyWorkAuthorityActionSchema>;
export type CompanyWorkAuthorityReceipt = z.infer<typeof companyWorkAuthorityReceiptSchema>;
export type CompanyWorkAuthoritySnapshot = z.infer<typeof companyWorkAuthoritySnapshotSchema>;
export type CompanyWorkAuthorityCredential = z.infer<typeof companyWorkAuthorityCredentialSchema>;
export type CreatedCompanyWorkAuthorityCredential = z.infer<typeof createdCompanyWorkAuthorityCredentialSchema>;
