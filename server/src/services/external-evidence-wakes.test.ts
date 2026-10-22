import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createDb, companies, agents, issues, companyMemberships, issueComments, issueCreateIdempotencyKeys,
  agentWakeupRequests, issueRecoveryActions, issueRelations, type Db } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { externalEvidenceEventSchema } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { queueExternalEvidenceSignal, externalEvidenceWakeGate, classifyEvidenceHold,
  existingNativeIntentDispatch, nativeEvidenceDispatchActor, retryUnadmittedEvidenceIntent, EXTERNAL_EVIDENCE_WAKE } from "./external-evidence-wakes.js";

// Public native creation namespace, not a credential.
const OWNER_REQUEST_PREFIX = "companyos-owner-request:";

// Mandatory native PostgreSQL; a loader/bind/migration failure is a test failure, never a skip.
describe("external evidence event admission and durable native wake intent", () => {
  let native: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => { native = await startEmbeddedPostgresTestDatabase("paperclip-evidence-wakes-"); db = createDb(native.connectionString); }, 90000);
  afterAll(async () => { if (native) await native.cleanup(); }, 30000);
  async function fixture() {
    const company = randomUUID(), chief = randomUUID(), parent = randomUUID(), source = randomUUID(), user = randomUUID();
    await db.insert(companies).values({ id: company, name: "Synthetic evidence", issuePrefix: "T" + company.slice(0, 8) });
    await db.insert(agents).values({ id: chief, companyId: company, name: "Chief", role: "ceo", adapterType: "process", status: "paused" });
    await db.insert(companyMemberships).values({ companyId: company, principalType: "user", principalId: user, status: "active" });
    await db.insert(issues).values({ id: parent, companyId: company, title: "Synthetic parent", status: "blocked", assigneeAgentId: chief,
      blockedTransitionAt: new Date(Date.now() - 10000), unblockDescriptor: { owner: { agentId: chief }, action: "Await exact external evidence" } });
    await db.insert(issues).values({ id: source, companyId: company, title: "Synthetic owner request", parentId: parent,
      status: "blocked", createdByAgentId: chief, unblockDescriptor: { owner: "board", action: "Supply exact evidence" } });
    await db.insert(issueCreateIdempotencyKeys).values({ companyId: company, issueId: source, idempotencyKey: OWNER_REQUEST_PREFIX + source });
    const comment = randomUUID();
    await db.insert(issueComments).values({ id: comment, companyId: company, issueId: source, authorUserId: user,
      authorType: "user", body: "Timestamped synthetic health receipt; cause remains unknown." });
    return { company, chief, parent, source, user, comment };
  }
  async function queue(f: Awaited<ReturnType<typeof fixture>>, overrides = {}) {
    return db.transaction(tx => queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company, sourceIssueId: f.source,
      actorUserId: f.user, eventId: f.comment, kind: "evidence_supplied", commentId: f.comment, ...overrides }));
  }
  it("delegates only recognized native execution waits while queued dispatch and unknown holds stay protected", async () => {
    const f = await fixture(); const target = randomUUID();
    await db.insert(issues).values({ id: target, companyId: f.company, title: "Synthetic execution-only target",
      status: "blocked", assigneeAgentId: f.chief, unblockDescriptor: null });
    await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: target,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
      cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
      fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
    const input = { companyId: f.company, issueId: target, agentId: f.chief };
    expect((await externalEvidenceWakeGate(db, input)).held).toBe(true);
    expect((await externalEvidenceWakeGate(db, { ...input, deferNativeExecutionHolds: true })).held).toBe(false);
    // Migration0084 permits only one active recovery per source. Give the
    // unknown-hold control its own source rather than violating that index.
    const unknownTarget = randomUUID();
    await db.insert(issues).values({ id: unknownTarget, companyId: f.company, title: "Synthetic unknown-held target",
      status: "blocked", assigneeAgentId: f.chief, unblockDescriptor: null });
    await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: unknownTarget,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
      cause: "unknown_synthetic_recovery_hold", status: "active", evidence: {},
      fingerprint: randomUUID(), nextAction: "Keep this unknown hold." });
    expect((await externalEvidenceWakeGate(db, { ...input, issueId: unknownTarget, deferNativeExecutionHolds: true })).held).toBe(true);
  });
  it.each(["external", "human", "unknown", "cancelled_request"] as const)(
    "does not delegate a coexisting %s hold to execution recovery", async (hold) => {
      const f = await fixture();
      await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: f.parent,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
        cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
        fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
      if (hold === "human") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Human approval remains required" } }).where(eq(issues.id, f.parent));
      if (hold === "unknown") await db.update(issues).set({ unblockDescriptor: { kind: "unknown_synthetic_hold", action: "Preserve unsupported hold" } }).where(eq(issues.id, f.parent));
      if (hold === "cancelled_request") {
        await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      }
      const input = { companyId: f.company, issueId: f.parent, agentId: f.chief };
      expect((await externalEvidenceWakeGate(db, { ...input, deferNativeExecutionHolds: true })).held).toBe(true);
      if (hold === "external") {
        const intent = await queue(f); expect(intent).not.toBeNull();
        // Fresh evidence cannot override the installed execution hold at queued dispatch.
        expect((await externalEvidenceWakeGate(db, { ...input, intentId: intent!.id })).held).toBe(true);
      }
    },
  );
  it.each(["external", "human", "unknown", "cancelled_request"] as const)(
    "dependency backstop preserves a coexisting %s hold without enqueueing work", async (hold) => {
      const f = await fixture(), blocker = randomUUID();
      await db.insert(issues).values({ id: blocker, companyId: f.company,
        title: "Synthetic completed production dependency", status: "done" });
      await db.insert(issueRelations).values({ companyId: f.company, type: "blocks",
        issueId: blocker, relatedIssueId: f.parent });
      await db.insert(issueRecoveryActions).values({ companyId: f.company, sourceIssueId: f.parent,
        kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: f.chief,
        cause: "legacy_execution_requires_reconciliation", status: "active", evidence: {},
        fingerprint: randomUUID(), nextAction: "Reconcile this exact stopped execution." });
      if (hold === "human") await db.update(issues).set({ unblockDescriptor: { owner: "board", action: "Human approval remains required" } }).where(eq(issues.id, f.parent));
      if (hold === "unknown") await db.update(issues).set({ unblockDescriptor: { kind: "unknown_synthetic_hold", action: "Preserve unsupported hold" } }).where(eq(issues.id, f.parent));
      if (hold === "cancelled_request") {
        await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
        await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.source));
      }
      let enqueueAttempts = 0;
      const { recoveryService } = await import("./recovery/service.js");
      const result = await recoveryService(db, { enqueueWakeup: async () => {
        enqueueAttempts += 1; return null;
      } }).reconcileResolvedDependencyWakeBackstop({ companyId: f.company });
      expect(result).toMatchObject({ checked: 1, interactionSkipped: 1, healed: 0 });
      expect(enqueueAttempts).toBe(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company))).toHaveLength(0);
      const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
      expect(parent.status).toBe("blocked");
    },
  );
  it("holds telemetry and production completion, while fresh exact evidence admits reconsideration without health certification", async () => {
    const f = await fixture();
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    const intent = await queue(f); expect(intent).not.toBeNull();
    expect(intent!.payload?.evidenceVerified).toBe(false);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief, intentId: intent!.id })).held).toBe(false);
    const [parent] = await db.select().from(issues).where(eq(issues.id, f.parent));
    expect(parent.status).toBe("blocked"); expect(parent.unblockDescriptor?.action).toBe("Await exact external evidence");
  });
  it("serializes concurrent duplicates and retains the same intent across restart and changed caller correlation ids", async () => {
    const f = await fixture();
    const [one, two] = await Promise.all([queue(f), queue(f, { eventId: randomUUID() })]);
    expect(one!.id).toBe(two!.id);
    const restarted = createDb(native.connectionString);
    const replay = await restarted.transaction(tx => queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company,
      sourceIssueId: f.source, actorUserId: f.user, eventId: randomUUID(), kind: "evidence_supplied", commentId: f.comment }));
    expect(replay!.id).toBe(one!.id);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(rows).toHaveLength(1);
  });
  it("rolls back both source event and intent at the crash boundary; retry commits one of each", async () => {
    const f = await fixture(), commentId = randomUUID();
    await expect(db.transaction(async tx => {
      await tx.insert(issueComments).values({ id: commentId, companyId: f.company, issueId: f.source, authorUserId: f.user, body: "Fresh evidence" });
      await queueExternalEvidenceSignal(tx as unknown as Db, { companyId: f.company, sourceIssueId: f.source,
        actorUserId: f.user, eventId: commentId, kind: "evidence_supplied", commentId });
      throw new Error("crash before transaction commit");
    })).rejects.toThrow("crash before");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.id, commentId))).toHaveLength(0);
    const intent = await queue(f); expect(intent).not.toBeNull();
  });
  it("distinguishes owner resolution, cancellation and replacement without treating any as verified health", async () => {
    for (const kind of ["resolved", "cancelled", "replaced"] as const) {
      const f = await fixture(); const replacement = randomUUID();
      if (kind === "replaced") {
        await db.insert(issues).values({ id: replacement, companyId: f.company, parentId: f.parent, createdByAgentId: f.chief,
          title: "Replacement evidence request", status: "blocked", unblockDescriptor: { owner: "board", action: "Provide new evidence" } });
        await db.insert(issueCreateIdempotencyKeys).values({ companyId: f.company, issueId: replacement, idempotencyKey: OWNER_REQUEST_PREFIX + replacement });
      }
      await db.update(issues).set({ status: kind === "resolved" ? "done" : "cancelled", unblockDescriptor: null }).where(eq(issues.id, f.source));
      const intent = await queue(f, { kind, ...(kind === "replaced" ? { replacementIssueId: replacement } : {}) });
      expect(intent!.payload?.evidenceVerified).toBe(false);
      expect((intent!.payload?.evidenceSignal as { kind: string }).kind).toBe(kind);
      expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(false);
      // Cancellation/replacement alone never release ordinary production admission.
      if (kind !== "resolved") expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    }
  });
  it("keeps cancelled requests held until an explicit exact replacement is itself resolved", async () => {
    const f = await fixture(), replacement = randomUUID();
    await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, f.parent));
    await db.update(issues).set({ status: "cancelled", unblockDescriptor: null }).where(eq(issues.id, f.source));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.insert(issues).values({ id: replacement, companyId: f.company, parentId: f.parent, createdByAgentId: f.chief,
      title: "Exact replacement", status: "blocked", unblockDescriptor: { owner: "board", action: "Supply new evidence" } });
    await db.insert(issueCreateIdempotencyKeys).values({ companyId: f.company, issueId: replacement, idempotencyKey: OWNER_REQUEST_PREFIX + replacement });
    await queue(f, { kind: "replaced", replacementIssueId: replacement });
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.update(issues).set({ status: "done", unblockDescriptor: null }).where(eq(issues.id, replacement));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(false);
    const [old] = await db.select().from(issues).where(eq(issues.id, f.source));
    expect(old.status).toBe("cancelled"); // No history or source disposition is rewritten.
  });

  it("a changed evidence revision creates a new signal and invalidates the older one", async () => {
    const f = await fixture(), old = await queue(f);
    await db.update(issueComments).set({ body: "Changed timestamped evidence", updatedAt: new Date(Date.now() + 1) }).where(eq(issueComments.id, f.comment));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: old!.id })).held).toBe(true);
    const fresh = await queue(f);
    expect(fresh!.id).not.toBe(old!.id);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: fresh!.id })).held).toBe(false);
  });

  it("rejects stale generation, edited/deleted evidence, out-of-order disposition and unproved source provenance", async () => {
    const f = await fixture(), intent = await queue(f);
    await db.update(issues).set({ unblockDescriptor: { owner: { agentId: f.chief }, action: "A different exact hold" } }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(true);
    const g = await fixture();
    await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, g.comment));
    expect(await queue(g)).toBeNull();
    const h = await fixture();
    expect(await queue(h, { kind: "resolved" })).toBeNull();
    await db.delete(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.issueId, h.source));
    expect(await queue(h)).toBeNull();
  });
  it("never accepts agent-on-behalf, cross-company, revoked member or stale old comments as evidence", async () => {
    const f = await fixture();
    await db.update(issueComments).set({ authorAgentId: f.chief }).where(eq(issueComments.id, f.comment));
    expect(await queue(f)).toBeNull();
    const g = await fixture(); await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, g.company));
    expect(await queue(g)).toBeNull();
    const h = await fixture(); expect(await queue(h, { companyId: f.company })).toBeNull();
    await db.update(issueComments).set({ createdAt: new Date(0) }).where(eq(issueComments.id, h.comment)); expect(await queue(h)).toBeNull();
  });
  it("preserves unknown and human descriptors even for an authenticated source event", async () => {
    for (const owner of ["board", { userId: "synthetic-user" }, { agentId: randomUUID() }]) {
      const f = await fixture(), intent = await queue(f);
      await db.update(issues).set({ unblockDescriptor: { owner, action: "Protected decision" } as never }).where(eq(issues.id, f.parent));
      expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id })).held).toBe(true);
    }
    expect(classifyEvidenceHold({ assigneeAgentId: "x", unblockDescriptor: { owner: "unknown", action: "Future" } as never, executionState: null })).toBe("protected");
  });
  it("actual source comment and terminal mutation transactions record native signals", async () => {
    const f = await fixture();
    const comment = await issueService(db).addComment(f.source, "Fresh native human source evidence", { userId: f.user });
    let intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(intents).toHaveLength(1);
    expect((intents[0].payload?.evidenceSignal as { commentId: string }).commentId).toBe(comment.id);
    await issueService(db).update(f.source, { status: "done", actorUserId: f.user });
    intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company));
    expect(intents).toHaveLength(2);
    expect(intents.some(i => (i.payload?.evidenceSignal as { kind: string }).kind === "resolved")).toBe(true);
    expect(intents.every(i => i.payload?.evidenceVerified === false)).toBe(true);
  });

  it("preserves the installed agent review path while protecting human, unknown and coexisting evidence holds", async () => {
    const f = await fixture();
    const executionState = { status: "pending" as const, currentStageId: randomUUID(), currentStageIndex: 0,
      currentStageType: "review" as const, currentParticipant: { type: "agent" as const, agentId: f.chief, userId: null },
      returnAssignee: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null };
    await db.update(issues).set({ status: "in_review", unblockDescriptor: null, executionState }).where(eq(issues.id, f.parent));
    // Coexisting unresolved owner evidence remains protected even for the reviewer.
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief })).held).toBe(true);
    await db.update(issues).set({ status: "done", unblockDescriptor: null }).where(eq(issues.id, f.source));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: f.chief })).held).toBe(false);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, agentId: randomUUID() })).held).toBe(true);
    await db.update(issues).set({ executionState: { ...executionState,
      currentParticipant: { type: "user", userId: f.user, agentId: null } } }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
    await db.update(issues).set({ executionState: { unknown: "future native hold" } as never }).where(eq(issues.id, f.parent));
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent })).held).toBe(true);
  });

  it("rejects incomplete, mixed and arbitrary API event bodies", () => {
    expect(externalEvidenceEventSchema.safeParse({ eventId: randomUUID(), kind: "resolved" }).success).toBe(true);
    for (const body of [{ eventId: randomUUID(), kind: "evidence_supplied" },
      { eventId: randomUUID(), kind: "resolved", commentId: randomUUID() },
      { eventId: randomUUID(), kind: "replaced" },
      { eventId: randomUUID(), kind: "resolved", evidenceVerified: true }]) {
      expect(externalEvidenceEventSchema.safeParse(body).success).toBe(false);
    }
  });

  it("fences retry attempts only after durable confirmation that no run was admitted", async () => {
    const f = await fixture(), intent = await queue(f), actor = nativeEvidenceDispatchActor(intent!)!;
    await db.insert(agentWakeupRequests).values({ companyId: f.company, agentId: f.chief, source: "automation",
      status: "skipped", reason: "agent.not_invokable", requestedByActorType: "system", requestedByActorId: actor,
      payload: { issueId: f.parent } });
    const advanced = await Promise.all([retryUnadmittedEvidenceIntent(db, intent!.id, actor), retryUnadmittedEvidenceIntent(db, intent!.id, actor)]);
    expect(advanced.filter(Boolean)).toHaveLength(1);
    const [current] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id));
    expect(current.payload?.evidenceDispatchAttempt).toBe(1);
    expect(nativeEvidenceDispatchActor(current)).toBe(actor + ":1");
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: current.id,
      dispatchActorId: actor })).held).toBe(true);
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: current.id,
      dispatchActorId: nativeEvidenceDispatchActor(current) })).held).toBe(false);
  });

  it("fences the outbox dispatch replay by exact actor, parent lock and retained receipt", async () => {
    const f = await fixture(), intent = await queue(f), actor = `native-status-wake-dispatch:${intent!.id}`;
    const admit = () => db.transaction(async tx => {
      await tx.execute(sql`select id from ${issues} where id = ${f.parent} for update`);
      const prior = await existingNativeIntentDispatch(tx as unknown as Db, { companyId: f.company, issueId: f.parent,
        agentId: f.chief, intentId: intent!.id, actorId: actor });
      if (prior) return prior.id;
      const [receipt] = await tx.insert(agentWakeupRequests).values({ companyId: f.company, agentId: f.chief,
        source: "automation", reason: EXTERNAL_EVIDENCE_WAKE, requestedByActorType: "system", requestedByActorId: actor,
        payload: { issueId: f.parent } }).returning();
      return receipt.id;
    });
    const [one, two] = await Promise.all([admit(), admit()]); expect(one).toBe(two);
    expect(await admit()).toBe(one); // Restart after dispatch commit but before original intent linkage.
    expect(await existingNativeIntentDispatch(db, { companyId: f.company, issueId: f.parent, agentId: f.chief,
      intentId: intent!.id, actorId: "untrusted-caller" })).toBeNull();
    expect((await externalEvidenceWakeGate(db, { companyId: f.company, issueId: f.parent, intentId: intent!.id, receiptId: randomUUID() })).held).toBe(true);
  });
});
