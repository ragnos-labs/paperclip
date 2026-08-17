import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { CompanyWorkAuthorityAction, CompanyWorkAuthorityReceipt } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueComments } from "./issue_comments.js";

export const companyWorkAuthorityActions = pgTable(
  "company_work_authority_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    requestDigest: text("request_digest").notNull(),
    previewHash: text("preview_hash").notNull(),
    state: text("state").notNull(),
    reasonCode: text("reason_code").notNull(),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    commentId: uuid("comment_id").references(() => issueComments.id, { onDelete: "set null" }),
    expectedRevision: text("expected_revision").notNull(),
    resultRevision: text("result_revision"),
    serviceActorRef: text("service_actor_ref").notNull(),
    accountableHumanRef: text("accountable_human_ref").notNull(),
    approverRef: text("approver_ref").notNull(),
    approvalRef: text("approval_ref").notNull(),
    action: jsonb("action").$type<CompanyWorkAuthorityAction>().notNull(),
    receipt: jsonb("receipt").$type<CompanyWorkAuthorityReceipt | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyUq: uniqueIndex("company_work_authority_actions_company_key_uq").on(
      table.companyId,
      table.idempotencyKey,
    ),
    companyDigestUq: uniqueIndex("company_work_authority_actions_company_digest_uq").on(
      table.companyId,
      table.requestDigest,
    ),
    companyCreatedIdx: index("company_work_authority_actions_company_created_idx").on(
      table.companyId,
      table.createdAt,
    ),
    issueCreatedIdx: index("company_work_authority_actions_issue_created_idx").on(
      table.issueId,
      table.createdAt,
    ),
  }),
);

export const companyWorkAuthorityAliases = pgTable(
  "company_work_authority_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    aliasRef: text("alias_ref").notNull(),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAliasUq: uniqueIndex("company_work_authority_aliases_company_alias_uq").on(
      table.companyId,
      table.aliasRef,
    ),
    issueAliasUq: uniqueIndex("company_work_authority_aliases_issue_alias_uq").on(
      table.issueId,
      table.aliasRef,
    ),
    companyIssueIdx: index("company_work_authority_aliases_company_issue_idx").on(
      table.companyId,
      table.issueId,
    ),
  }),
);
