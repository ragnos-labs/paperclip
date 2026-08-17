import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  activityLog,
  companyWorkAuthorityActions,
  companyWorkAuthorityAliases,
  companyMemberships,
  companyWorkProjectionIssueHeads,
  companyWorkProjectionRevisions,
  issueComments,
  issueRelations,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  COMPANY_WORK_AUTHORITY_API_VERSION,
  COMPANY_WORK_AUTHORITY_MAX_ITEMS,
  COMPANY_WORK_AUTHORITY_SCHEMA_VERSION,
  companyWorkAuthorityActionSchema,
  companyWorkAuthorityItemSchema,
  companyWorkAuthorityReceiptSchema,
  companyWorkAuthoritySnapshotSchema,
  issueWorkAuthorityContextSchema,
  type CompanyWorkAuthorityAction,
  type CompanyWorkAuthorityReceipt,
  type IssueWorkAuthorityContext,
} from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound } from "../errors.js";
import { issueService } from "./issues.js";

type AuthorityOptions = {
  enabled: boolean;
  emergencyStopped: boolean;
  allowedOperations: ReadonlySet<CompanyWorkAuthorityAction["operation"]>;
  allowedPolicyDigests: ReadonlySet<string>;
  clock?: () => Date;
};

type Preview = {
  apiVersion: typeof COMPANY_WORK_AUTHORITY_API_VERSION;
  companyId: string;
  requestDigest: string;
  previewHash: string;
  currentRevision: string;
  state: "preview_ready" | "preview_held";
  reasonCode: string;
  externalWrite: false;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new TypeError("Work authority canonical JSON accepts JSON values only");
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function normalizedRefSet(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function defaultContext(action: CompanyWorkAuthorityAction): IssueWorkAuthorityContext {
  return issueWorkAuthorityContextSchema.parse({
    stableWorkRef: action.stableWorkRef,
    startAt: action.changes.startAt ?? null,
    dueAt: action.changes.dueAt ?? null,
    nextAction: action.changes.nextAction ?? null,
    doneCriteria: action.changes.doneCriteria ?? null,
    evidenceRefs: normalizedRefSet(action.changes.evidenceRefs ?? []),
    milestoneRef: action.changes.milestoneRef ?? null,
    privacyClass: action.changes.privacyClass ?? "internal",
    historicalAliases: normalizedRefSet(action.changes.historicalAliases ?? []),
    accountableHumanRef: action.accountableHumanRef,
    approverRef: action.approverRef,
  });
}

function updatedContext(
  current: IssueWorkAuthorityContext,
  action: CompanyWorkAuthorityAction,
): IssueWorkAuthorityContext {
  return issueWorkAuthorityContextSchema.parse({
    ...current,
    startAt: action.changes.startAt !== undefined ? action.changes.startAt : current.startAt,
    dueAt: action.changes.dueAt !== undefined ? action.changes.dueAt : current.dueAt,
    nextAction: action.changes.nextAction !== undefined ? action.changes.nextAction : current.nextAction,
    doneCriteria: action.changes.doneCriteria !== undefined ? action.changes.doneCriteria : current.doneCriteria,
    evidenceRefs: action.changes.evidenceRefs !== undefined
      ? normalizedRefSet(action.changes.evidenceRefs)
      : current.evidenceRefs,
    milestoneRef: action.changes.milestoneRef !== undefined ? action.changes.milestoneRef : current.milestoneRef,
    privacyClass: action.changes.privacyClass ?? current.privacyClass,
    historicalAliases: action.changes.historicalAliases !== undefined
      ? normalizedRefSet(action.changes.historicalAliases)
      : current.historicalAliases,
    accountableHumanRef: action.accountableHumanRef,
    approverRef: action.approverRef,
  });
}

function ownerColumns(owner: CompanyWorkAuthorityAction["executionOwner"]) {
  if (owner.type === "agent") return { assigneeAgentId: owner.id, assigneeUserId: null };
  if (owner.type === "human") return { assigneeAgentId: null, assigneeUserId: owner.id };
  return { assigneeAgentId: null, assigneeUserId: null };
}

function serializeOwner(row: { assigneeAgentId: string | null; assigneeUserId: string | null }) {
  if (row.assigneeAgentId) return { type: "agent" as const, id: row.assigneeAgentId };
  if (row.assigneeUserId) return { type: "human" as const, id: row.assigneeUserId };
  return { type: "unassigned" as const };
}

function optionsFromEnvironment(): AuthorityOptions {
  const enabled = process.env.PAPERCLIP_WORK_AUTHORITY_WRITER_ENABLED === "true";
  const emergencyStopped = process.env.PAPERCLIP_WORK_AUTHORITY_EMERGENCY_STOP !== "false";
  const operations = (process.env.PAPERCLIP_WORK_AUTHORITY_ALLOWED_OPERATIONS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean) as CompanyWorkAuthorityAction["operation"][];
  const policies = (process.env.PAPERCLIP_WORK_AUTHORITY_ALLOWED_POLICY_DIGESTS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return {
    enabled,
    emergencyStopped,
    allowedOperations: new Set(operations),
    allowedPolicyDigests: new Set(policies),
  };
}

export function companyWorkAuthorityService(db: Db, configured?: Partial<AuthorityOptions>) {
  const defaults = optionsFromEnvironment();
  const options: AuthorityOptions = {
    ...defaults,
    ...configured,
    allowedOperations: configured?.allowedOperations ?? defaults.allowedOperations,
    allowedPolicyDigests: configured?.allowedPolicyDigests ?? defaults.allowedPolicyDigests,
  };
  const clock = options.clock ?? (() => new Date());
  const issuesSvc = issueService(db);

  async function currentIssueRevision(companyId: string, issueId: string): Promise<string> {
    const row = await db.select({ revision: companyWorkProjectionIssueHeads.currentRevision })
      .from(companyWorkProjectionIssueHeads)
      .where(and(
        eq(companyWorkProjectionIssueHeads.companyId, companyId),
        eq(companyWorkProjectionIssueHeads.issueId, issueId),
      )).then((rows) => rows[0] ?? null);
    if (!row) throw conflict("Work authority revision is unavailable", { code: "WORK_AUTHORITY_REVISION_UNAVAILABLE" });
    return String(row.revision);
  }

  async function assertStableRefAvailable(action: CompanyWorkAuthorityAction) {
    const aliases = normalizedRefSet([action.stableWorkRef, ...(action.changes.historicalAliases ?? [])]);
    if (aliases.length === 0) return;
    const rows = await db.select({ aliasRef: companyWorkAuthorityAliases.aliasRef, issueId: companyWorkAuthorityAliases.issueId })
      .from(companyWorkAuthorityAliases)
      .where(and(
        eq(companyWorkAuthorityAliases.companyId, action.companyId),
        inArray(companyWorkAuthorityAliases.aliasRef, aliases),
      ));
    if (rows.some((row) => row.issueId !== action.issueId)) {
      throw conflict("Work authority alias is already bound", { code: "WORK_AUTHORITY_ALIAS_CONFLICT" });
    }
  }

  async function recoverIntentIssue(action: CompanyWorkAuthorityAction): Promise<string | null> {
    if (action.issueId) return action.issueId;
    const rows = await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.companyId, action.companyId),
      sql`${issues.workAuthorityContext} ->> 'stableWorkRef' = ${action.stableWorkRef}`,
    )).limit(2);
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) {
      throw conflict("Work authority recovery found duplicate stable identities", {
        code: "WORK_AUTHORITY_IDENTITY_DRIFT",
      });
    }
    return null;
  }

  async function inspect(actionInput: CompanyWorkAuthorityAction) {
    const action = companyWorkAuthorityActionSchema.parse(actionInput);
    const now = clock();
    if (new Date(action.approval.decidedAt).getTime() > now.getTime()) {
      throw conflict("Work authority approval decision is in the future", { code: "WORK_AUTHORITY_APPROVAL_NOT_CURRENT" });
    }
    if (new Date(action.approval.expiresAt).getTime() < now.getTime()) {
      throw conflict("Work authority approval has expired", { code: "WORK_AUTHORITY_APPROVAL_EXPIRED" });
    }
    const requiredHumans = normalizedRefSet([
      action.accountableHumanRef,
      action.approverRef,
      ...(action.executionOwner.type === "human" ? [action.executionOwner.id] : []),
    ]);
    const activeHumans = await db.select({ principalId: companyMemberships.principalId })
      .from(companyMemberships).where(and(
        eq(companyMemberships.companyId, action.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.status, "active"),
        inArray(companyMemberships.principalId, requiredHumans),
      ));
    if (new Set(activeHumans.map((row) => row.principalId)).size !== requiredHumans.length) {
      throw forbidden("Work authority accountability requires active company humans", {
        code: "WORK_AUTHORITY_HUMAN_IDENTITY_INVALID",
      });
    }
    let currentRevision = "0";
    if (action.issueId) {
      const issue = await db.select({ id: issues.id, context: issues.workAuthorityContext })
        .from(issues)
        .where(and(eq(issues.id, action.issueId), eq(issues.companyId, action.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Work authority issue not found");
      const context = issueWorkAuthorityContextSchema.safeParse(issue.context);
      if (!context.success || context.data.stableWorkRef !== action.stableWorkRef) {
        throw conflict("Work authority identity does not match", { code: "WORK_AUTHORITY_IDENTITY_DRIFT" });
      }
      currentRevision = await currentIssueRevision(action.companyId, action.issueId);
    }
    if (currentRevision !== action.expectedRevision) {
      throw conflict("Work authority revision changed", {
        code: "WORK_AUTHORITY_REVISION_CONFLICT",
        expectedRevision: action.expectedRevision,
        currentRevision,
      });
    }
    await assertStableRefAvailable(action);
    const requestDigest = digest(action);
    const writerPolicy = {
      enabled: options.enabled,
      emergencyStopped: options.emergencyStopped,
      operationAllowed: options.allowedOperations.has(action.operation),
      policyAllowed: options.allowedPolicyDigests.has(action.policyDigest),
    };
    const previewHash = digest({ action, currentRevision, writerPolicy });
    const reasonCode = !options.enabled
      ? "writer_disabled"
      : options.emergencyStopped
        ? "emergency_stop_requested"
        : !writerPolicy.operationAllowed
          ? "operation_not_allowed"
          : !writerPolicy.policyAllowed
            ? "policy_not_allowed"
            : "preview_ready";
    const ready = reasonCode === "preview_ready";
    const preview: Preview = {
      apiVersion: COMPANY_WORK_AUTHORITY_API_VERSION,
      companyId: action.companyId,
      requestDigest,
      previewHash,
      currentRevision,
      state: ready ? "preview_ready" : "preview_held",
      reasonCode,
      externalWrite: false,
    };
    return { action, preview, ready };
  }

  async function synchronizeAliases(action: CompanyWorkAuthorityAction, issueId: string, tx: any) {
    const context = action.operation === "record_create"
      ? defaultContext(action)
      : issueWorkAuthorityContextSchema.parse((await tx.select({ context: issues.workAuthorityContext })
          .from(issues).where(eq(issues.id, issueId)).then((rows: Array<{ context: unknown }>) => rows[0])).context);
    const aliases = normalizedRefSet([context.stableWorkRef, ...context.historicalAliases]);
    await tx.delete(companyWorkAuthorityAliases).where(and(
      eq(companyWorkAuthorityAliases.companyId, action.companyId),
      eq(companyWorkAuthorityAliases.issueId, issueId),
    ));
    if (aliases.length > 0) {
      await tx.insert(companyWorkAuthorityAliases).values(
        aliases.map((aliasRef) => ({ companyId: action.companyId, issueId, aliasRef })),
      );
    }
  }

  async function materializeItem(companyId: string, issueId: string, dbOrTx: any = db) {
    const rows = await dbOrTx.select({
      issueId: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      projectId: issues.projectId,
      priority: issues.priority,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      status: issues.status,
      parentId: issues.parentId,
      context: issues.workAuthorityContext,
      revision: companyWorkProjectionIssueHeads.currentRevision,
    }).from(issues).innerJoin(
      companyWorkProjectionIssueHeads,
      and(
        eq(companyWorkProjectionIssueHeads.companyId, issues.companyId),
        eq(companyWorkProjectionIssueHeads.issueId, issues.id),
      ),
    ).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))) as Array<{
      issueId: string;
      identifier: string | null;
      title: string;
      projectId: string | null;
      priority: string;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
      status: string;
      parentId: string | null;
      context: unknown;
      revision: bigint | number | string;
    }>;
    const row = rows[0] ?? null;
    if (!row) throw notFound("Work authority issue not found");
    const context = issueWorkAuthorityContextSchema.parse(row.context);
    const dependencies = await dbOrTx.select({ issueId: issueRelations.issueId }).from(issueRelations).where(and(
      eq(issueRelations.companyId, companyId),
      eq(issueRelations.relatedIssueId, issueId),
      eq(issueRelations.type, "blocks"),
    )).orderBy(asc(issueRelations.issueId)) as Array<{ issueId: string }>;
    return companyWorkAuthorityItemSchema.parse({
      issueId: row.issueId,
      stableWorkRef: context.stableWorkRef,
      identifier: row.identifier,
      title: row.title,
      projectId: row.projectId,
      priority: row.priority,
      owner: serializeOwner(row),
      startAt: context.startAt,
      dueAt: context.dueAt,
      dependencyIssueIds: dependencies.map((item) => item.issueId),
      status: row.status,
      nextAction: context.nextAction,
      doneCriteria: context.doneCriteria,
      evidenceRefs: context.evidenceRefs,
      parentId: row.parentId,
      milestoneRef: context.milestoneRef,
      privacyClass: context.privacyClass,
      historicalAliases: context.historicalAliases,
      accountableHumanRef: context.accountableHumanRef,
      approverRef: context.approverRef,
      revision: String(row.revision),
    });
  }

  async function assertReadbackMatches(
    intentId: string,
    action: CompanyWorkAuthorityAction,
    item: ReturnType<typeof companyWorkAuthorityItemSchema.parse>,
  ) {
    const expected: Array<[string, unknown, unknown]> = [
      ["stableWorkRef", action.stableWorkRef, item.stableWorkRef],
      ["title", action.changes.title, item.title],
      ["projectId", action.changes.projectId, item.projectId],
      ["priority", action.changes.priority, item.priority],
      ["owner", action.operation === "record_create" ? action.executionOwner : action.changes.owner, item.owner],
      ["startAt", action.changes.startAt, item.startAt],
      ["dueAt", action.changes.dueAt, item.dueAt],
      ["dependencyIssueIds", action.changes.dependencyIssueIds?.slice().sort(), item.dependencyIssueIds.slice().sort()],
      ["status", action.changes.status, item.status],
      ["nextAction", action.changes.nextAction, item.nextAction],
      ["doneCriteria", action.changes.doneCriteria, item.doneCriteria],
      ["evidenceRefs", action.changes.evidenceRefs ? normalizedRefSet(action.changes.evidenceRefs) : undefined, item.evidenceRefs],
      ["parentId", action.changes.parentId, item.parentId],
      ["milestoneRef", action.changes.milestoneRef, item.milestoneRef],
      ["privacyClass", action.changes.privacyClass, item.privacyClass],
      ["historicalAliases", action.changes.historicalAliases ? normalizedRefSet(action.changes.historicalAliases) : undefined, item.historicalAliases],
      ["accountableHumanRef", action.accountableHumanRef, item.accountableHumanRef],
      ["approverRef", action.approverRef, item.approverRef],
    ];
    const mismatch = expected.find(([, wanted, actual]) => wanted !== undefined && canonicalJson(wanted) !== canonicalJson(actual));
    if (mismatch) {
      throw conflict("Work authority readback drifted from the approved action", {
        code: "WORK_AUTHORITY_READBACK_DRIFT",
        field: mismatch[0],
      });
    }
    if (action.changes.comment !== undefined) {
      const effect = await db.select({ commentId: companyWorkAuthorityActions.commentId })
        .from(companyWorkAuthorityActions)
        .where(eq(companyWorkAuthorityActions.id, intentId))
        .then((rows) => rows[0] ?? null);
      const comment = effect?.commentId
        ? await db.select({ id: issueComments.id }).from(issueComments).where(and(
            eq(issueComments.id, effect.commentId),
            eq(issueComments.companyId, action.companyId),
            eq(issueComments.issueId, item.issueId),
            eq(issueComments.authorUserId, action.approverRef),
            eq(issueComments.body, action.changes.comment),
          )).then((rows) => rows[0] ?? null)
        : null;
      if (!comment) throw conflict("Work authority comment readback is missing", { code: "WORK_AUTHORITY_READBACK_DRIFT" });
    }
  }

  async function finalizeReceipt(
    intentId: string,
    action: CompanyWorkAuthorityAction,
    issueId: string,
    priorRevision: string,
  ): Promise<CompanyWorkAuthorityReceipt> {
    const item = await materializeItem(action.companyId, issueId);
    await assertReadbackMatches(intentId, action, item);
    const now = clock().toISOString();
    const receipt = companyWorkAuthorityReceiptSchema.parse({
      apiVersion: COMPANY_WORK_AUTHORITY_API_VERSION,
      companyId: action.companyId,
      requestDigest: digest(action),
      idempotencyKey: action.idempotencyKey,
      outcome: "accepted",
      issueId,
      stableWorkRef: action.stableWorkRef,
      operation: action.operation,
      priorRevision,
      resultRevision: item.revision,
      changeRef: `paperclip:work-authority-effect:${digest({
        proposalHash: action.proposalHash,
        writerRef: action.writerRef,
        operation: action.operation,
        requestDigest: digest(action),
      })}`,
      readbackDigest: digest(item),
      serviceActorRef: action.serviceActorRef,
      executionOwner: action.executionOwner,
      accountableHumanRef: action.accountableHumanRef,
      approverRef: action.approverRef,
      approvalRef: action.approval.approvalRef,
      policyDigest: action.policyDigest,
      reasonCode: "authority_change_applied_and_read_back",
      appliedAt: now,
      replayed: false,
      externalWrite: true,
    });
    await db.transaction(async (tx) => {
      await synchronizeAliases(action, issueId, tx);
      await tx.update(companyWorkAuthorityActions).set({
        issueId,
        resultRevision: item.revision,
        state: "accepted",
        reasonCode: receipt.reasonCode,
        receipt,
        updatedAt: new Date(now),
      }).where(eq(companyWorkAuthorityActions.id, intentId));
      await tx.insert(activityLog).values({
        companyId: action.companyId,
        actorType: "system",
        actorId: action.serviceActorRef,
        action: "company_work_authority.action_applied",
        entityType: "issue",
        entityId: issueId,
        responsibleUserId: action.accountableHumanRef,
        details: {
          approvalRef: action.approval.approvalRef,
          approverRef: action.approverRef,
          operation: action.operation,
          priorRevision,
          resultRevision: item.revision,
          requestDigest: digest(action),
        },
      });
    });
    return receipt;
  }

  async function applyAction(action: CompanyWorkAuthorityAction, intentId: string): Promise<CompanyWorkAuthorityReceipt> {
    const context = action.issueId
      ? updatedContext(
          issueWorkAuthorityContextSchema.parse((await db.select({ context: issues.workAuthorityContext })
            .from(issues).where(and(eq(issues.id, action.issueId), eq(issues.companyId, action.companyId)))
            .then((rows) => rows[0] ?? null))?.context),
          action,
        )
      : defaultContext(action);
    const owner = ownerColumns(action.executionOwner);
    let issueId = action.issueId;
    if (action.operation === "record_create") {
      const issue = await issuesSvc.create(action.companyId, {
        title: action.changes.title!,
        projectId: action.changes.projectId ?? null,
        parentId: action.changes.parentId ?? null,
        priority: action.changes.priority ?? "medium",
        status: action.changes.status ?? "backlog",
        ...owner,
        workAuthorityContext: context,
        blockedByIssueIds: action.changes.dependencyIssueIds ?? [],
        createdByUserId: action.approverRef,
        responsibleUserId: action.accountableHumanRef,
        actorResponsibleUserId: action.accountableHumanRef,
        trustExplicitResponsibleUserId: true,
        idempotencyKey: `work-authority:${action.idempotencyKey}`,
        allowDuplicate: true,
      });
      issueId = issue.id;
    } else {
      if (!issueId) throw new Error("Validated update action is missing issueId");
      const patch: Record<string, unknown> = {
        actorUserId: action.approverRef,
        workAuthorityContext: context,
      };
      if (action.changes.title !== undefined) patch.title = action.changes.title;
      if (action.changes.projectId !== undefined) patch.projectId = action.changes.projectId;
      if (action.changes.parentId !== undefined) patch.parentId = action.changes.parentId;
      if (action.changes.priority !== undefined) patch.priority = action.changes.priority;
      if (action.changes.status !== undefined) patch.status = action.changes.status;
      if (action.changes.owner !== undefined) Object.assign(patch, ownerColumns(action.changes.owner));
      if (action.changes.dependencyIssueIds !== undefined) patch.blockedByIssueIds = action.changes.dependencyIssueIds;
      if (action.changes.comment !== undefined) {
        await db.transaction(async (tx) => {
          await issuesSvc.update(issueId!, patch as any, tx);
          const comment = await issuesSvc.addComment(
            issueId!,
            action.changes.comment!,
            { userId: action.approverRef },
            undefined,
            tx,
          );
          await tx.update(companyWorkAuthorityActions).set({
            issueId,
            commentId: comment.id,
            updatedAt: clock(),
          }).where(eq(companyWorkAuthorityActions.id, intentId));
        });
      } else {
        await issuesSvc.update(issueId, patch as any);
      }
    }
    return finalizeReceipt(intentId, action, issueId, action.expectedRevision);
  }

  return {
    preview: async (action: CompanyWorkAuthorityAction): Promise<Preview> => (await inspect(action)).preview,

    dispatch: async (actionInput: CompanyWorkAuthorityAction, previewHash: string): Promise<CompanyWorkAuthorityReceipt> => {
      const action = companyWorkAuthorityActionSchema.parse(actionInput);
      const requestDigest = digest(action);
      const existing = await db.select().from(companyWorkAuthorityActions).where(and(
        eq(companyWorkAuthorityActions.companyId, action.companyId),
        eq(companyWorkAuthorityActions.idempotencyKey, action.idempotencyKey),
      )).then((rows) => rows[0] ?? null);
      if (existing) {
        if (existing.requestDigest !== requestDigest) {
          throw conflict("Work authority idempotency key was reused with changed input", {
            code: "WORK_AUTHORITY_IDEMPOTENCY_CONFLICT",
          });
        }
        if (existing.receipt) return companyWorkAuthorityReceiptSchema.parse({ ...existing.receipt, replayed: true });
        const recoveredIssueId = existing.issueId ?? await recoverIntentIssue(action);
        if (recoveredIssueId) return finalizeReceipt(existing.id, action, recoveredIssueId, existing.expectedRevision);
        throw new HttpError(409, "Work authority outcome is ambiguous", { code: "WORK_AUTHORITY_AMBIGUOUS" });
      }
      const inspected = await inspect(action);
      if (previewHash !== inspected.preview.previewHash) {
        throw conflict("Work authority dispatch requires the exact preview hash", {
          code: "WORK_AUTHORITY_PREVIEW_MISMATCH",
        });
      }
      if (!inspected.ready) throw forbidden("Work authority writer is held", { code: inspected.preview.reasonCode });
      const intentId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(companyWorkAuthorityActions).values({
          id: intentId,
          companyId: action.companyId,
          idempotencyKey: action.idempotencyKey,
          requestDigest,
          previewHash,
          state: "intent_recorded",
          reasonCode: "intent_persisted_before_effect",
          issueId: action.issueId,
          expectedRevision: action.expectedRevision,
          serviceActorRef: action.serviceActorRef,
          accountableHumanRef: action.accountableHumanRef,
          approverRef: action.approverRef,
          approvalRef: action.approval.approvalRef,
          action,
        });
        await tx.insert(activityLog).values({
          companyId: action.companyId,
          actorType: "system",
          actorId: action.serviceActorRef,
          action: "company_work_authority.intent_recorded",
          entityType: "company_work_authority_action",
          entityId: intentId,
          responsibleUserId: action.accountableHumanRef,
          details: { requestDigest, approvalRef: action.approval.approvalRef, operation: action.operation },
        });
      });
      return applyAction(action, intentId);
    },

    receipt: async (companyId: string, idempotencyKey: string): Promise<CompanyWorkAuthorityReceipt | null> => {
      const row = await db.select().from(companyWorkAuthorityActions).where(and(
        eq(companyWorkAuthorityActions.companyId, companyId),
        eq(companyWorkAuthorityActions.idempotencyKey, idempotencyKey),
      )).then((rows) => rows[0] ?? null);
      if (!row) return null;
      if (row.receipt) return companyWorkAuthorityReceiptSchema.parse({ ...row.receipt, replayed: true });
      const action = companyWorkAuthorityActionSchema.parse(row.action);
      const recoveredIssueId = row.issueId ?? await recoverIntentIssue(action);
      if (recoveredIssueId) return finalizeReceipt(row.id, action, recoveredIssueId, row.expectedRevision);
      throw new HttpError(409, "Work authority outcome is ambiguous", { code: "WORK_AUTHORITY_AMBIGUOUS" });
    },

    snapshot: async (companyId: string) => {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
        const revision = await tx.select({ revision: companyWorkProjectionRevisions.currentRevision })
          .from(companyWorkProjectionRevisions).where(eq(companyWorkProjectionRevisions.companyId, companyId))
          .then((rows) => rows[0] ?? null);
        if (!revision) throw conflict("Work authority revision is unavailable", { code: "WORK_AUTHORITY_REVISION_UNAVAILABLE" });
        const rows = await tx.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, companyId),
          isNotNull(issues.workAuthorityContext),
        )).orderBy(asc(issues.id)).limit(COMPANY_WORK_AUTHORITY_MAX_ITEMS + 1);
        if (rows.length > COMPANY_WORK_AUTHORITY_MAX_ITEMS) {
          throw new HttpError(409, "Work authority snapshot exceeds the v1 complete-read limit", {
            code: "WORK_AUTHORITY_INCOMPLETE",
          });
        }
        const items = [];
        for (const row of rows) items.push(await materializeItem(companyId, row.id, tx));
        const observedAt = clock().toISOString();
        const body = {
          apiVersion: COMPANY_WORK_AUTHORITY_API_VERSION,
          schemaVersion: COMPANY_WORK_AUTHORITY_SCHEMA_VERSION,
          companyId,
          revision: String(revision.revision),
          completeness: "complete" as const,
          observedAt,
          items,
        };
        return companyWorkAuthoritySnapshotSchema.parse({ ...body, digest: digest(body) });
      });
      return result;
    },
  };
}
