import { describe, expect, it } from "vitest";
import {
  companyWorkAuthorityActionSchema,
  companyWorkAuthorityReceiptSchema,
  issueWorkAuthorityContextSchema,
} from "./company-work-authority.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const humanId = "human:reviewer";
const base = {
  apiVersion: "paperclip.company-work-authority/v1" as const,
  companyId,
  writerRef: "writer:programos-distribution",
  proposalRef: "proposal:one",
  proposalHash: `sha256:${"a".repeat(64)}`,
  proposalType: "field_change" as const,
  approval: {
    approvalRef: "approval:one",
    authorityKind: "human" as const,
    approverRef: humanId,
    decision: "approved" as const,
    proposalHash: `sha256:${"a".repeat(64)}`,
    authorityRevision: "7",
    policyDigest: `sha256:${"b".repeat(64)}`,
    decidedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-18T00:00:00.000Z",
  },
  serviceActorRef: "service:programos",
  executionOwner: { type: "human" as const, id: "human:owner" },
  accountableHumanRef: "human:owner",
  approverRef: humanId,
  operation: "field_set" as const,
  idempotencyKey: "authority:one",
  expectedRevision: "7",
  policyDigest: `sha256:${"b".repeat(64)}`,
  issueId,
  stableWorkRef: "roadmap:work-1",
  changes: { nextAction: "Run the bounded verification." },
};

describe("company work authority contract", () => {
  it("accepts closed complete PM context and rejects hidden extra fields", () => {
    const context = {
      stableWorkRef: "roadmap:work-1",
      startAt: null,
      dueAt: "2026-08-20T00:00:00.000Z",
      nextAction: "Run the bounded verification.",
      doneCriteria: "The receipt passes readback.",
      evidenceRefs: ["evidence:one"],
      milestoneRef: "milestone:q3",
      privacyClass: "internal" as const,
      historicalAliases: ["clickup:123"],
      accountableHumanRef: "human:owner",
      approverRef: humanId,
    };
    expect(issueWorkAuthorityContextSchema.parse(context)).toEqual(context);
    expect(issueWorkAuthorityContextSchema.safeParse({ ...context, rawTranscript: "forbidden" }).success).toBe(false);
  });

  it("requires exact operation fields and routed-owner agreement", () => {
    expect(companyWorkAuthorityActionSchema.parse(base)).toMatchObject({ operation: "field_set" });
    expect(companyWorkAuthorityActionSchema.safeParse({
      ...base,
      operation: "owner_set",
      changes: { owner: { type: "human", id: "human:different" } },
    }).success).toBe(false);
    expect(companyWorkAuthorityActionSchema.safeParse({
      ...base,
      operation: "date_set",
      changes: { dueAt: null, title: "not allowed here" },
    }).success).toBe(false);
  });

  it("allows terminal Done only through an accepted accept_done proposal", () => {
    const terminal = {
      ...base,
      proposalType: "accept_done" as const,
      operation: "status_set_terminal" as const,
      changes: { status: "done" as const },
    };
    expect(companyWorkAuthorityActionSchema.safeParse(terminal).success).toBe(true);
    expect(companyWorkAuthorityActionSchema.safeParse({
      ...terminal,
      proposalType: "delivery_state",
    }).success).toBe(false);
    expect(companyWorkAuthorityActionSchema.safeParse({
      ...base,
      operation: "status_set_nonterminal",
      changes: { status: "done" },
    }).success).toBe(false);
  });

  it("requires revision zero and a title for new work", () => {
    const create = {
      ...base,
      proposalType: "new_work" as const,
      operation: "record_create" as const,
      issueId: null,
      expectedRevision: "0",
      approval: { ...base.approval, authorityRevision: "0" },
      changes: { title: "Create governed work", historicalAliases: ["clickup:123"] },
    };
    expect(companyWorkAuthorityActionSchema.safeParse(create).success).toBe(true);
    expect(companyWorkAuthorityActionSchema.safeParse({ ...create, expectedRevision: "1" }).success).toBe(false);
    expect(companyWorkAuthorityActionSchema.safeParse({ ...create, changes: {} }).success).toBe(false);
    expect(companyWorkAuthorityActionSchema.safeParse({ ...create, changes: { title: "No permission bypass", comment: "hidden" } }).success).toBe(false);
  });

  it("keeps writer receipts closed and identity-attributed", () => {
    const receipt = {
      apiVersion: "paperclip.company-work-authority/v1" as const,
      companyId,
      requestDigest: `sha256:${"c".repeat(64)}`,
      idempotencyKey: "authority:one",
      outcome: "accepted" as const,
      issueId,
      stableWorkRef: "roadmap:work-1",
      operation: "field_set" as const,
      priorRevision: "7",
      resultRevision: "8",
      changeRef: "paperclip:work-authority-action:one",
      readbackDigest: `sha256:${"d".repeat(64)}`,
      serviceActorRef: "service:programos",
      executionOwner: { type: "human" as const, id: "human:owner" },
      accountableHumanRef: "human:owner",
      approverRef: humanId,
      approvalRef: "approval:one",
      policyDigest: `sha256:${"b".repeat(64)}`,
      reasonCode: "authority_change_applied_and_read_back",
      appliedAt: "2026-08-17T00:01:00.000Z",
      replayed: false,
      externalWrite: true,
    };
    expect(companyWorkAuthorityReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(companyWorkAuthorityReceiptSchema.safeParse({ ...receipt, credential: "forbidden" }).success).toBe(false);
  });
});
