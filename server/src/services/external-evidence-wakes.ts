/** External evidence is a reconsideration signal, never production completion or health verification. */
import { createHash } from "node:crypto";
import { and, eq, isNull, like, not, or, sql } from "drizzle-orm";
import { agentWakeupRequests, companyMemberships, issueComments, issueCreateIdempotencyKeys,
  issueRecoveryActions, issueThreadInteractions, issueApprovals, approvals, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { issueExecutionStateSchema } from "@paperclipai/shared";
import { executionBlockerPredicate } from "./execution-blocker.js";
import { conversationRecoveryActionPredicate } from "./conversation-continuation.js";

export const EXTERNAL_EVIDENCE_WAKE = "issue_external_evidence_changed";
const PRODUCTION_ACTION = "Read retained child contributions when dependencies are ready; reconcile cancelled or failed children before continuing.";
export type EvidenceSignalKind = "evidence_supplied" | "resolved" | "cancelled" | "replaced";
type Issue = typeof issues.$inferSelect;
type Signal = { kind: EvidenceSignalKind; eventId: string; sourceIssueId: string; actorUserId: string;
  commentId?: string; commentFingerprint?: string; replacementIssueId?: string; holdFingerprint: string };
const object = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

export function evidenceHoldFingerprint(issue: Pick<Issue, "id" | "assigneeAgentId" | "unblockDescriptor" | "executionState" | "blockedTransitionAt">) {
  return createHash("sha256").update(JSON.stringify([issue.id, issue.assigneeAgentId,
    issue.unblockDescriptor, issue.executionState, issue.blockedTransitionAt])).digest("hex");
}

export function classifyEvidenceHold(issue: Pick<Issue, "assigneeAgentId" | "unblockDescriptor" | "executionState">) {
  if (issue.executionState != null) {
    const parsed = issueExecutionStateSchema.safeParse(issue.executionState);
    if (!parsed.success || parsed.data.status === "pending" || parsed.data.currentParticipant?.type === "user")
      return "protected" as const;
  }
  const descriptor = issue.unblockDescriptor;
  if (descriptor == null) return "none" as const;
  const owner = object(descriptor.owner);
  if (!owner || Object.keys(owner).length !== 1 || owner.agentId !== issue.assigneeAgentId
      || Object.keys(descriptor).some(k => !["owner", "action"].includes(k))
      || typeof descriptor.action !== "string" || !descriptor.action.trim()) return "protected" as const;
  return descriptor.action === PRODUCTION_ACTION ? "production" as const : "external" as const;
}

async function sourceRequest(db: Db, companyId: string, sourceIssueId: string) {
  const [source] = await db.select().from(issues).where(and(eq(issues.id, sourceIssueId), eq(issues.companyId, companyId)));
  if (!source?.parentId || !source.createdByAgentId || source.assigneeAgentId || source.assigneeUserId) return null;
  const [origin] = await db.select({ id: issueCreateIdempotencyKeys.id }).from(issueCreateIdempotencyKeys)
    .where(and(eq(issueCreateIdempotencyKeys.companyId, companyId), eq(issueCreateIdempotencyKeys.issueId, source.id),
      like(issueCreateIdempotencyKeys.idempotencyKey, "companyos-owner-request:%"))).limit(1);
  return origin ? source : null;
}

async function activeMember(db: Db, companyId: string, userId: string) {
  const [member] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
    eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
    eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"))).limit(1);
  return Boolean(member);
}

async function validateSignalSource(db: Db, companyId: string, parent: Issue, signal: Signal) {
  if (!["evidence_supplied", "resolved", "cancelled", "replaced"].includes(signal.kind)
    || typeof signal.actorUserId !== "string" || typeof signal.eventId !== "string"
    || !signal.eventId || signal.eventId.length > 180 || typeof signal.sourceIssueId !== "string"
    || !await activeMember(db, companyId, signal.actorUserId)) return false;
  const source = await sourceRequest(db, companyId, signal.sourceIssueId);
  if (!source || source.parentId !== parent.id || source.createdByAgentId !== parent.assigneeAgentId) return false;
  if (signal.kind === "resolved" && source.status !== "done") return false;
  if (["resolved", "cancelled"].includes(signal.kind)
    && signal.eventId !== `status:${source.id}:${source.statusVersion}:${signal.kind}`) return false;
  if (["cancelled", "replaced"].includes(signal.kind) && source.status !== "cancelled") return false;
  if (signal.kind === "evidence_supplied") {
    if (!signal.commentId) return false;
    const [comment] = await db.select().from(issueComments).where(and(eq(issueComments.id, signal.commentId),
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, source.id), isNull(issueComments.deletedAt)));
    // A derived/sentinel or agent-on-behalf comment is not human evidence.
    if (!comment || comment.authorUserId !== signal.actorUserId || comment.authorAgentId || comment.createdByRunId
      || comment.derivedAuthorAgentId || comment.onBehalfOfUserId || !comment.body.trim()
      || parent.blockedTransitionAt && comment.createdAt < parent.blockedTransitionAt
      || signal.commentFingerprint !== createHash("sha256").update(JSON.stringify([comment.body, comment.updatedAt])).digest("hex")) return false;
  }
  if (signal.kind === "replaced") {
    const replacement = signal.replacementIssueId ? await sourceRequest(db, companyId, signal.replacementIssueId) : null;
    if (signal.eventId !== `replacement:${source.id}:${signal.replacementIssueId}:${source.statusVersion}`) return false;
    if (!replacement || replacement.id === source.id || replacement.parentId !== parent.id
      || replacement.createdByAgentId !== parent.assigneeAgentId || ["done", "cancelled"].includes(replacement.status)) return false;
  }
  return true;
}

/** Call in the source mutation transaction. Parent row lock fences concurrent event admission. */
export async function queueExternalEvidenceSignal(db: Db, input: {
  companyId: string; sourceIssueId: string; actorUserId: string; eventId: string;
  kind: EvidenceSignalKind; commentId?: string; replacementIssueId?: string;
}) {
  const source = await sourceRequest(db, input.companyId, input.sourceIssueId);
  if (!source) return null;
  const [parent] = await db.select().from(issues).where(and(eq(issues.id, source.parentId!),
    eq(issues.companyId, input.companyId))).for("update");
  if (!parent) return null;
  const [comment] = input.kind === "evidence_supplied" && input.commentId
    ? await db.select().from(issueComments).where(and(eq(issueComments.id, input.commentId),
      eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, source.id))).for("share") : [];
  const commentFingerprint = comment ? createHash("sha256").update(JSON.stringify([comment.body, comment.updatedAt])).digest("hex") : null;
  const canonicalEvent = input.kind === "evidence_supplied" ? `comment:${input.commentId}:${commentFingerprint}`
    : input.kind === "replaced" ? `replacement:${source.id}:${input.replacementIssueId}:${source.statusVersion}`
      : `status:${source.id}:${source.statusVersion}:${input.kind}`;
  const request = { kind: input.kind, eventId: canonicalEvent, sourceIssueId: input.sourceIssueId,
    actorUserId: input.actorUserId, ...(input.kind === "evidence_supplied" && input.commentId ? { commentId: input.commentId } : {}),
    ...(commentFingerprint ? { commentFingerprint } : {}),
    ...(input.kind === "replaced" && input.replacementIssueId ? { replacementIssueId: input.replacementIssueId } : {}) };
  const requestFingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const key = "external-evidence:" + parent.id + ":" + canonicalEvent;
  const [prior] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.idempotencyKey, key))).limit(1);
  if (prior) {
    if (prior.payload?.requestFingerprint !== requestFingerprint) throw conflict("Evidence event identity conflicts with retained request");
    return prior;
  }
  if (parent.conversationAgentId || !parent.assigneeAgentId || parent.assigneeAgentId !== source.createdByAgentId
    || ["backlog", "done", "cancelled"].includes(parent.status)) return null;
  const signal: Signal = { ...request, holdFingerprint: evidenceHoldFingerprint(parent) };
  if (!await validateSignalSource(db, input.companyId, parent, signal)) return null;
  const [intent] = await db.insert(agentWakeupRequests).values({ companyId: input.companyId, agentId: parent.assigneeAgentId,
    source: "automation", triggerDetail: "system", reason: EXTERNAL_EVIDENCE_WAKE, status: "queued",
    requestedByActorType: "system", requestedByActorId: "native-status-committer", idempotencyKey: key,
    payload: { issueId: parent.id, evidenceSignal: signal, requestFingerprint, evidenceVerified: false,
      _paperclipWakeContext: { issueId: parent.id, evidenceSignal: signal, evidenceVerified: false,
        source: "external_evidence_event" } } }).returning();
  return intent;
}

/** Explicit replacement is a reference, not a closure or a health assertion. */
async function resolvedReplacement(db: Db, companyId: string, parent: Issue, sourceId: string, visited = new Set<string>()): Promise<boolean> {
  if (visited.has(sourceId) || visited.size >= 8) return false;
  visited.add(sourceId);
  const source = await sourceRequest(db, companyId, sourceId);
  if (!source || source.parentId !== parent.id || source.createdByAgentId !== parent.assigneeAgentId) return false;
  if (source.status === "done") return true;
  if (source.status !== "cancelled") return false;
  const links = await db.select({ payload: agentWakeupRequests.payload }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, EXTERNAL_EVIDENCE_WAKE),
    eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${parent.id}`,
    sql`${agentWakeupRequests.payload}->'evidenceSignal'->>'kind' = 'replaced'`,
    sql`${agentWakeupRequests.payload}->'evidenceSignal'->>'sourceIssueId' = ${sourceId}`));
  const targets = new Set<string>();
  for (const row of links) {
    const signal = object(row.payload?.evidenceSignal);
    if (typeof signal?.replacementIssueId !== "string" || typeof signal.actorUserId !== "string"
      || !await activeMember(db, companyId, signal.actorUserId)) return false;
    if (signal.eventId === `replacement:${source.id}:${signal.replacementIssueId}:${source.statusVersion}`)
      targets.add(signal.replacementIssueId);
  }
  if (targets.size !== 1) return false; // Conflicting/unknown lineage is not resolution.
  return resolvedReplacement(db, companyId, parent, [...targets][0], visited);
}

/** Shared admission/queued-dispatch gate. Unknown holds fail closed; a signal never overrides human decisions. */
export async function externalEvidenceWakeGate(db: Db, input: {
  companyId: string; issueId: string; agentId?: string; intentId?: string | null;
  receiptId?: string | null; runId?: string; nativeReview?: boolean; dispatchActorId?: string | null;
  /** Only admission/candidate callers that retain the installed native execution gate. */
  deferNativeExecutionHolds?: boolean;
}): Promise<{ held: boolean; reason: string | null }> {
  const [parent] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!parent) return { held: true, reason: "evidence_target_missing" };
  const state = issueExecutionStateSchema.safeParse(parent.executionState);
  const admittedReview = input.nativeReview === true && state.success && state.data.status === "pending"
    && state.data.currentParticipant?.type === "agent" && state.data.currentParticipant.agentId === input.agentId;
  // The installed execution-review scheduler owns this typed native stage.
  // Do not turn its pending agent participant into an external evidence hold.
  // Descriptor, human interaction, approval and owner-request checks still apply.
  const nativeAgentReview = parent.status === "in_review" && state.success && state.data.status === "pending"
    && state.data.currentStageType === "review" && state.data.currentStageId !== null
    && state.data.currentParticipant?.type === "agent"
    && (!input.agentId || state.data.currentParticipant.agentId === input.agentId);
  const classification = classifyEvidenceHold(admittedReview || nativeAgentReview ? { ...parent, executionState: null } : parent);
  const [recovery] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, parent.id),
    eq(issueRecoveryActions.status, "active"), eq(issueRecoveryActions.ownerType, "board"),
    // These exact installed predicates identify native-owned waits. Admission
    // still records/coalesces them under its issue lock; this gate must not
    // replace their recoveryActionId with a generic evidence-wait payload.
    // Unknown board holds remain here, and queued dispatch never opts out.
    input.deferNativeExecutionHolds ? not(or(
      executionBlockerPredicate(), conversationRecoveryActionPredicate(),
    )!) : undefined)).limit(1);
  const [interaction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, parent.id),
    eq(issueThreadInteractions.status, "pending"), eq(issueThreadInteractions.effectiveResolverPolicy, "human_only"))).limit(1);
  const [approval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals,
    and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId))).where(and(
    eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.issueId, parent.id), eq(approvals.status, "pending"))).limit(1);
  if (classification === "protected" || recovery || interaction || approval) return { held: true, reason: "protected_native_hold" };
  const openRequests = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.parentId, parent.id),
    parent.assigneeAgentId ? eq(issues.createdByAgentId, parent.assigneeAgentId) : sql`false`,
    isNull(issues.assigneeAgentId), isNull(issues.assigneeUserId),
    sql`${issues.status} <> 'done'`));
  if (input.intentId) {
    const [intent] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.intentId),
      eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.reason, EXTERNAL_EVIDENCE_WAKE),
      eq(agentWakeupRequests.requestedByActorId, "native-status-committer")));
    const signal = object(intent?.payload?.evidenceSignal) as Signal | null;
    if (!intent || intent.agentId !== parent.assigneeAgentId || input.agentId && input.agentId !== intent.agentId
      || intent.payload?.issueId !== parent.id || !signal
      || input.dispatchActorId !== undefined && input.dispatchActorId !== nativeEvidenceDispatchActor(intent)
      || signal.holdFingerprint !== evidenceHoldFingerprint(parent)
      || !await validateSignalSource(db, input.companyId, parent, signal)) return { held: true, reason: "stale_or_invalid_evidence_event" };
    if (input.receiptId !== undefined) {
      if (!input.receiptId) return { held: true, reason: "evidence_dispatch_provenance_missing" };
      const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.receiptId),
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, intent.agentId),
        eq(agentWakeupRequests.requestedByActorType, "system"),
        eq(agentWakeupRequests.requestedByActorId, nativeEvidenceDispatchActor(intent) ?? "invalid")));
      if (!receipt || receipt.payload?.issueId !== parent.id || input.runId && receipt.runId !== input.runId)
        return { held: true, reason: "evidence_dispatch_provenance_missing" };
    }
    return { held: false, reason: null }; // Reconsideration only; evidenceVerified remains false.
  }
  let unresolved = false;
  for (const request of openRequests) {
    if (!await resolvedReplacement(db, input.companyId, parent, request.id)) { unresolved = true; break; }
  }
  return { held: classification === "external" || unresolved,
    reason: classification === "external" || unresolved ? "external_evidence_hold" : null };
}

export function nativeEvidenceDispatchActor(intent: Pick<typeof agentWakeupRequests.$inferSelect, "id" | "reason" | "payload">) {
  const attempt = intent.reason === EXTERNAL_EVIDENCE_WAKE ? intent.payload?.evidenceDispatchAttempt ?? 0 : 0;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 1024) return null;
  return `native-status-wake-dispatch:${intent.id}${attempt ? `:${attempt}` : ""}`;
}

/** Only a confirmed zero-admission terminal receipt can advance an admission attempt. */
export async function retryUnadmittedEvidenceIntent(db: Db, intentId: string, actorId: string) {
  return db.transaction(async tx => {
    const [snapshot] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intentId));
    const issueId = snapshot?.payload?.issueId;
    if (!snapshot || snapshot.reason !== EXTERNAL_EVIDENCE_WAKE || snapshot.requestedByActorType !== "system"
      || snapshot.requestedByActorId !== "native-status-committer" || typeof issueId !== "string") return false;
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, snapshot.companyId))).for("update");
    const [intent] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intentId));
    if (!intent || intent.runId || nativeEvidenceDispatchActor(intent) !== actorId) return false;
    const [receipt] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, intent.companyId),
      eq(agentWakeupRequests.agentId, intent.agentId), eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, actorId))).limit(1);
    if (!receipt || receipt.runId || !["skipped", "failed", "cancelled"].includes(receipt.status)) return false;
    // A foreign key alone is not a sufficient no-admission proof.
    const admitted = await tx.execute(sql`select id from heartbeat_runs where wakeup_request_id = ${receipt.id} limit 1`);
    if (admitted.length) return false;
    const attempt = Number(intent.payload?.evidenceDispatchAttempt ?? 0);
    if (attempt >= 1024) return false;
    await tx.update(agentWakeupRequests).set({ payload: { ...intent.payload, evidenceDispatchAttempt: attempt + 1 },
      status: "queued", claimedAt: null, finishedAt: null, error: "Prior attempt confirmed no run admission; current native gates will be checked again",
      updatedAt: new Date() }).where(eq(agentWakeupRequests.id, intent.id));
    return true;
  });
}

/** Called only inside heartbeat's existing parent-row admission transaction. */
export async function existingNativeIntentDispatch(db: Db, input: {
  companyId: string; issueId: string; agentId: string; intentId: string | null; actorId: string | null;
}) {
  if (!input.intentId || !input.actorId) return null;
  const [intent] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.intentId),
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, input.agentId),
    eq(agentWakeupRequests.requestedByActorId, "native-status-committer")));
  if (!intent || intent.payload?.issueId !== input.issueId || input.actorId !== nativeEvidenceDispatchActor(intent)) return null;
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, input.agentId), eq(agentWakeupRequests.requestedByActorType, "system"),
    eq(agentWakeupRequests.requestedByActorId, input.actorId))).limit(1);
  return receipt ?? null;
}
