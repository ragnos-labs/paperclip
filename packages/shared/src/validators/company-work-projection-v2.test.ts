import { describe, expect, it } from "vitest";
import {
  companyWorkProjectionV2ItemSchema,
  companyWorkProjectionV2PacketContextSchema,
  issueWorkProjectionContextSchema,
} from "./company-work-projection-v2.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const humanId = "synthetic-human";
const delegation = {
  onBehalfOf: { type: "human" as const, id: humanId },
  grantReference: "paperclip:delegation:synthetic",
  grantDigest: `sha256:${"a".repeat(64)}`,
  grantedAt: "2026-08-15T12:00:00.000Z",
};
const intent = {
  type: "repository_change" as const,
  repository: "github:synthetic/example",
  baseRevision: "main",
  allowedPaths: ["src/**"],
  prohibitedPaths: ["secrets/**"],
};

describe("company work projection v2 contract", () => {
  it("accepts explicit export-approved source context and closed target variants", () => {
    expect(issueWorkProjectionContextSchema.parse({
      objective: "Implement the approved change.",
      objectiveExportApproved: true,
      intent,
      delegation,
    })).toMatchObject({ objectiveExportApproved: true, intent, delegation });

    expect(issueWorkProjectionContextSchema.safeParse({
      objective: "Do not export implicitly",
      objectiveExportApproved: false,
      intent,
      delegation,
    }).success).toBe(false);
    expect(issueWorkProjectionContextSchema.safeParse({
      objective: "Unknown target",
      objectiveExportApproved: true,
      intent: { type: "provider_special", target: "secret" },
      delegation: null,
    }).success).toBe(false);
    expect(issueWorkProjectionContextSchema.safeParse({
      objective: "Extra source field",
      objectiveExportApproved: true,
      intent,
      delegation: null,
      title: "must not leak",
    }).success).toBe(false);
  });

  it("requires agent delegation and forbids human delegation on ready items", () => {
    const receipt = {
      contractVersion: "paperclip.company-work-projection/v2" as const,
      reference: "paperclip:company-work-projection:synthetic",
      revision: "7",
      digest: `sha256:${"b".repeat(64)}`,
      issuedAt: "2026-08-15T12:00:00.000Z",
    };
    expect(companyWorkProjectionV2PacketContextSchema.safeParse({
      availability: "ready",
      objective: "Implement the approved change.",
      intent,
      actor: { type: "agent", id: agentId },
      delegation: null,
      sourceReceipt: receipt,
    }).success).toBe(false);
    expect(companyWorkProjectionV2PacketContextSchema.safeParse({
      availability: "ready",
      objective: "Implement the approved change.",
      intent,
      actor: { type: "human", id: humanId },
      delegation,
      sourceReceipt: receipt,
    }).success).toBe(false);
    expect(companyWorkProjectionV2PacketContextSchema.safeParse({
      availability: "ready",
      objective: "Implement the approved change.",
      intent,
      actor: { type: "agent", id: agentId },
      delegation,
      sourceReceipt: receipt,
    }).success).toBe(true);
  });

  it("keeps all unavailable variants closed and non-ready", () => {
    for (const reason of [
      "unassigned",
      "missing_delegation",
      "unsupported_target",
      "restricted_objective",
    ] as const) {
      expect(companyWorkProjectionV2PacketContextSchema.parse({
        availability: "unavailable",
        reason,
      })).toEqual({ availability: "unavailable", reason });
    }
    expect(companyWorkProjectionV2PacketContextSchema.safeParse({
      availability: "unavailable",
      reason: "restricted_objective",
      objective: "must not leak",
    }).success).toBe(false);
  });

  it("requires packet context and rejects unknown v2 item fields", () => {
    const base = {
      id: agentId,
      identifier: "SYN-1",
      owner: { type: "unassigned" as const },
      projectId: null,
      priority: "medium" as const,
      planningState: "todo" as const,
      timestamps: {
        createdAt: "2026-08-15T12:00:00.000Z",
        updatedAt: "2026-08-15T12:00:00.000Z",
        startedAt: null,
        completedAt: null,
        cancelledAt: null,
      },
      revision: "1",
      evidence: { algorithm: "sha256" as const, digest: "c".repeat(64) },
    };
    expect(companyWorkProjectionV2ItemSchema.safeParse(base).success).toBe(false);
    expect(companyWorkProjectionV2ItemSchema.safeParse({
      ...base,
      packetContext: { availability: "unavailable", reason: "unassigned" },
      unknown: true,
    }).success).toBe(false);
  });
});
