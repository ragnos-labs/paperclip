import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { companyWorkProjectionCredentialGuard } from "../middleware/company-work-projection-credential-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyWorkAuthorityRoutes } from "../routes/company-work-authority.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const action = {
  apiVersion: "paperclip.company-work-authority/v1" as const,
  companyId,
  writerRef: "paperclip:work-authority-credential:22222222-2222-4222-8222-222222222222",
  proposalRef: "proposal:test",
  proposalHash: `sha256:${"a".repeat(64)}`,
  proposalType: "new_work" as const,
  approval: {
    approvalRef: "approval:test",
    authorityKind: "human" as const,
    approverRef: "human:reviewer",
    decision: "approved" as const,
    proposalHash: `sha256:${"a".repeat(64)}`,
    authorityRevision: "0",
    policyDigest: `sha256:${"b".repeat(64)}`,
    decidedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-18T00:00:00.000Z",
  },
  serviceActorRef: "service:test",
  executionOwner: { type: "human" as const, id: "human:owner" },
  accountableHumanRef: "human:owner",
  approverRef: "human:reviewer",
  operation: "record_create" as const,
  idempotencyKey: "authority:test",
  expectedRevision: "0",
  policyDigest: `sha256:${"b".repeat(64)}`,
  issueId: null,
  stableWorkRef: "roadmap:test",
  changes: { title: "Test governed work" },
};

function app(actor: Express.Request["actor"]) {
  const preview = vi.fn(async () => ({
    apiVersion: "paperclip.company-work-authority/v1",
    companyId,
    requestDigest: `sha256:${"c".repeat(64)}`,
    previewHash: `sha256:${"d".repeat(64)}`,
    currentRevision: "0",
    state: "preview_ready",
    reasonCode: "preview_ready",
    externalWrite: false,
  }));
  const service = {
    preview,
    dispatch: vi.fn(),
    receipt: vi.fn(),
    snapshot: vi.fn(),
  } as unknown as Parameters<typeof companyWorkAuthorityRoutes>[1]["service"];
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => { req.actor = actor; next(); });
  instance.use(companyWorkProjectionCredentialGuard());
  instance.use("/api", companyWorkAuthorityRoutes({} as Db, { service }));
  instance.use(errorHandler);
  return { instance, preview };
}

describe("company work authority route", () => {
  it("allows only the matching v3 capability on the preview route", async () => {
    const { instance, preview } = app({
      type: "none",
      source: "none",
      companyId,
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialTokenVersion: 3,
    });
    const response = await request(instance)
      .post(`/api/v1/companies/${companyId}/work-authority/preview`)
      .send({ action });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ state: "preview_ready", currentRevision: "0" });
    expect(preview).toHaveBeenCalledOnce();
  });

  it("rejects a board actor and cross-company v3 capability", async () => {
    const board = app({ type: "board", source: "session", userId: "human:reviewer", companyIds: [companyId] });
    expect((await request(board.instance)
      .post(`/api/v1/companies/${companyId}/work-authority/preview`).send({ action })).status).toBe(403);

    const crossCompany = app({
      type: "none",
      source: "none",
      companyId: "33333333-3333-4333-8333-333333333333",
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialTokenVersion: 3,
    });
    expect((await request(crossCompany.instance)
      .post(`/api/v1/companies/${companyId}/work-authority/preview`).send({ action })).status).toBe(403);
  });

  it("rejects extra content and keeps the v3 capability off ordinary routes", async () => {
    const { instance } = app({
      type: "none",
      source: "none",
      companyId,
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialTokenVersion: 3,
    });
    expect((await request(instance)
      .post(`/api/v1/companies/${companyId}/work-authority/preview`)
      .send({ action: { ...action, rawTranscript: "forbidden" } })).status).toBe(400);
    expect((await request(instance)
      .post(`/api/v1/companies/${companyId}/work-authority/preview`)
      .send({ action: { ...action, writerRef: "writer:spoofed" } })).status).toBe(403);
    expect((await request(instance).get(`/api/issues/22222222-2222-4222-8222-222222222222`)).status).toBe(403);
  });
});
