import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import {
  applyPendingMigrations,
  activityLog,
  companies,
  companyMemberships,
  companyWorkAuthorityActions,
  companyWorkAuthorityAliases,
  companyWorkProjectionCredentials,
  createDb,
  issueInboxArchives,
  issueComments,
  issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import type { CompanyWorkAuthorityAction } from "@paperclipai/shared";
import { companyWorkAuthorityService } from "../services/company-work-authority.js";
import {
  authenticateCompanyWorkProjectionCredential,
  companyWorkAuthorityCredentialService,
} from "../services/company-work-projection-credentials.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const externalDatabaseUrl = Reflect.get(process.env, "PAPERCLIP_WORK_AUTHORITY_TEST_DATABASE_URL")?.trim();
const support = externalDatabaseUrl ? { supported: true as const } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping company work authority tests: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

describePostgres("company work authority", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-authority-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(companyWorkAuthorityActions);
    await db.delete(companyWorkAuthorityAliases);
    await db.delete(issueInboxArchives);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companyWorkProjectionCredentials);
    await db.delete(activityLog);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic Authority", issuePrefix: `W${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: "human:owner", status: "active", membershipRole: "operator" },
      { companyId, principalType: "user", principalId: "human:reviewer", status: "active", membershipRole: "admin" },
    ]);
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: "human:reviewer",
      membershipRole: "admin",
      grantedByUserId: null,
    });
    return companyId;
  }

  function action(companyId: string): CompanyWorkAuthorityAction {
    return {
      apiVersion: "paperclip.company-work-authority/v1",
      companyId,
      writerRef: "writer:programos-distribution",
      proposalRef: "proposal:create-one",
      proposalHash: `sha256:${"a".repeat(64)}`,
      proposalType: "new_work",
      approval: {
        approvalRef: "approval:create-one",
        authorityKind: "human",
        approverRef: "human:reviewer",
        decision: "approved",
        proposalHash: `sha256:${"a".repeat(64)}`,
        authorityRevision: "0",
        policyDigest: `sha256:${"b".repeat(64)}`,
        decidedAt: "2026-08-17T00:00:00.000Z",
        expiresAt: "2026-08-18T00:00:00.000Z",
      },
      serviceActorRef: "service:programos",
      executionOwner: { type: "human", id: "human:owner" },
      accountableHumanRef: "human:owner",
      approverRef: "human:reviewer",
      operation: "record_create",
      idempotencyKey: "op:create",
      expectedRevision: "0",
      policyDigest: `sha256:${"b".repeat(64)}`,
      issueId: null,
      stableWorkRef: "roadmap:work-1",
      changes: {
        title: "Create governed work",
        priority: "high",
        status: "backlog",
        dueAt: "2026-08-20T00:00:00.000Z",
        nextAction: "Run the bounded proof.",
        doneCriteria: "The exact receipt passes.",
        evidenceRefs: ["evidence:one"],
        privacyClass: "internal",
        historicalAliases: ["clickup:123"],
      },
    };
  }

  function service() {
    return companyWorkAuthorityService(db, {
      enabled: true,
      emergencyStopped: false,
      allowedOperations: new Set(["record_create", "field_set", "status_set_terminal", "comment_create"]),
      allowedPolicyDigests: new Set([`sha256:${"b".repeat(64)}`]),
      clock: () => new Date("2026-08-17T00:05:00.000Z"),
    });
  }

  it("persists intent, creates once, reads back, maps aliases, and replays exactly", async () => {
    const companyId = await seed();
    const writer = service();
    const request = action(companyId);
    const preview = await writer.preview(request);
    expect(preview).toMatchObject({ state: "preview_ready", currentRevision: "0", externalWrite: false });

    const receipt = await writer.dispatch(request, preview.previewHash);
    expect(receipt).toMatchObject({ outcome: "accepted", priorRevision: "0", replayed: false, externalWrite: true });
    expect(receipt.resultRevision).not.toBe("0");
    expect(receipt.changeRef).toMatch(/^paperclip:work-authority-effect:sha256:[a-f0-9]{64}$/);

    const replay = await writer.dispatch(request, preview.previewHash);
    expect(replay).toMatchObject({ issueId: receipt.issueId, replayed: true, requestDigest: receipt.requestDigest });
    expect(await db.select().from(issues)).toHaveLength(1);
    expect((await db.select().from(companyWorkAuthorityAliases)).map((row) => row.aliasRef).sort())
      .toEqual(["clickup:123", "roadmap:work-1"]);
    expect((await writer.snapshot(companyId)).items[0]).toMatchObject({
      stableWorkRef: "roadmap:work-1",
      title: "Create governed work",
      owner: { type: "human", id: "human:owner" },
      dueAt: "2026-08-20T00:00:00.000Z",
    });
  });

  it("rejects changed-input replay and stale revisions", async () => {
    const companyId = await seed();
    const writer = service();
    const create = action(companyId);
    const preview = await writer.preview(create);
    const receipt = await writer.dispatch(create, preview.previewHash);

    await expect(writer.dispatch({ ...create, stableWorkRef: "roadmap:changed" }, preview.previewHash))
      .rejects.toThrow(/idempotency key was reused/i);

    const update: CompanyWorkAuthorityAction = {
      ...create,
      proposalRef: "proposal:update-one",
      proposalHash: `sha256:${"c".repeat(64)}`,
      proposalType: "field_change",
      approval: {
        ...create.approval,
        approvalRef: "approval:update-one",
        proposalHash: `sha256:${"c".repeat(64)}`,
        authorityRevision: "999",
      },
      operation: "field_set",
      idempotencyKey: "op:update",
      expectedRevision: "999",
      issueId: receipt.issueId,
      changes: { nextAction: "Use the updated proof." },
    };
    await expect(writer.preview(update)).rejects.toThrow(/revision changed/i);
  });

  it("applies a revision-bound field update and accepts Done only after human acceptance", async () => {
    const companyId = await seed();
    const writer = service();
    const create = action(companyId);
    const createPreview = await writer.preview(create);
    const created = await writer.dispatch(create, createPreview.previewHash);

    const update: CompanyWorkAuthorityAction = {
      ...create,
      proposalRef: "proposal:update-one",
      proposalHash: `sha256:${"c".repeat(64)}`,
      proposalType: "field_change",
      approval: {
        ...create.approval,
        approvalRef: "approval:update-one",
        proposalHash: `sha256:${"c".repeat(64)}`,
        authorityRevision: created.resultRevision!,
      },
      operation: "field_set",
      idempotencyKey: "op:update",
      expectedRevision: created.resultRevision!,
      issueId: created.issueId,
      changes: { nextAction: "Use the accepted update." },
    };
    const updatePreview = await writer.preview(update);
    const updated = await writer.dispatch(update, updatePreview.previewHash);
    expect((await writer.snapshot(companyId)).items[0].nextAction).toBe("Use the accepted update.");

    const terminal: CompanyWorkAuthorityAction = {
      ...update,
      proposalRef: "proposal:done-one",
      proposalHash: `sha256:${"d".repeat(64)}`,
      proposalType: "accept_done",
      approval: {
        ...create.approval,
        approvalRef: "approval:done-one",
        proposalHash: `sha256:${"d".repeat(64)}`,
        authorityRevision: updated.resultRevision!,
      },
      operation: "status_set_terminal",
      idempotencyKey: "op:done",
      expectedRevision: updated.resultRevision!,
      changes: { status: "done" },
    };
    const terminalPreview = await writer.preview(terminal);
    const done = await writer.dispatch(terminal, terminalPreview.previewHash);
    expect(done.outcome).toBe("accepted");
    expect((await writer.snapshot(companyId)).items[0].status).toBe("done");
  });

  it("holds every write when the emergency stop is active", async () => {
    const companyId = await seed();
    const writer = companyWorkAuthorityService(db, {
      enabled: true,
      emergencyStopped: true,
      allowedOperations: new Set(["record_create"]),
      allowedPolicyDigests: new Set([`sha256:${"b".repeat(64)}`]),
      clock: () => new Date("2026-08-17T00:05:00.000Z"),
    });
    const preview = await writer.preview(action(companyId));
    expect(preview).toMatchObject({ state: "preview_held", reasonCode: "emergency_stop_requested" });
    await expect(writer.dispatch(action(companyId), preview.previewHash)).rejects.toThrow(/writer is held/i);
    expect(await db.select().from(companyWorkAuthorityActions)).toHaveLength(0);
  });

  it("binds a comment effect to one exact comment and never duplicates it on replay", async () => {
    const companyId = await seed();
    const writer = service();
    const create = action(companyId);
    const created = await writer.dispatch(create, (await writer.preview(create)).previewHash);
    const proposalHash = `sha256:${"e".repeat(64)}`;
    const comment: CompanyWorkAuthorityAction = {
      ...create,
      proposalRef: "proposal:comment-one",
      proposalHash,
      proposalType: "field_change",
      approval: {
        ...create.approval,
        approvalRef: "approval:comment-one",
        proposalHash,
        authorityRevision: created.resultRevision!,
      },
      operation: "comment_create",
      idempotencyKey: "op:comment",
      expectedRevision: created.resultRevision!,
      issueId: created.issueId,
      changes: { comment: "The human-approved checkpoint is ready." },
    };
    const preview = await writer.preview(comment);
    const first = await writer.dispatch(comment, preview.previewHash);
    const replay = await writer.dispatch(comment, preview.previewHash);
    expect(replay).toMatchObject({ issueId: first.issueId, replayed: true });
    expect(await db.select().from(issueComments)).toHaveLength(1);
    expect((await db.select().from(companyWorkAuthorityActions)
      .where(eq(companyWorkAuthorityActions.idempotencyKey, comment.idempotencyKey)))[0].commentId).not.toBeNull();
  });

  it("mints a company-bound v3 credential once and rejects it after revocation", async () => {
    const companyId = await seed();
    const credentials = companyWorkAuthorityCredentialService(db);
    const created = await credentials.create(companyId, "ProgramOS writer", "human:reviewer");
    expect(created.token).toMatch(/^pcwp_v3_[a-f0-9]{48}$/);
    expect((await authenticateCompanyWorkProjectionCredential(db, created.token))).toMatchObject({
      companyId,
      credentialId: created.id,
      tokenVersion: 3,
    });
    expect((await credentials.list(companyId, "human:reviewer"))).toHaveLength(1);
    await credentials.revoke(companyId, created.id, "human:reviewer");
    expect(await authenticateCompanyWorkProjectionCredential(db, created.token)).toBeNull();
  });
});
