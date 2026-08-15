import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * Dedicated machine credentials for the work projection. These hashes never
 * live in agent_api_keys, so a binary that predates this capability cannot
 * reinterpret a restrictive credential as a standard agent key.
 */
export const companyWorkProjectionCredentials = pgTable(
  "company_work_projection_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    tokenVersion: integer("token_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    keyHashUniqueIdx: uniqueIndex("company_work_projection_credentials_key_hash_idx")
      .on(table.keyHash),
    companyCreatedIdx: index("company_work_projection_credentials_company_created_idx")
      .on(table.companyId, table.createdAt),
  }),
);

export const companyWorkProjectionRevisions = pgTable("company_work_projection_revisions", {
  companyId: uuid("company_id")
    .primaryKey()
    .references(() => companies.id, { onDelete: "cascade" }),
  currentRevision: bigint("current_revision", { mode: "bigint" }).notNull().default(0n),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only safe-field history used to materialize immutable company work
 * snapshots. Deliberately omits title, description, execution/recovery state,
 * adapter configuration, workspace paths, credentials, and private payloads.
 */
export const issueWorkProjectionVersions = pgTable(
  "issue_work_projection_versions",
  {
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull(),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    deleted: boolean("deleted").notNull().default(false),
    identifier: text("identifier"),
    projectId: uuid("project_id"),
    assigneeAgentId: uuid("assignee_agent_id"),
    assigneeUserId: text("assignee_user_id"),
    status: text("status"),
    priority: text("priority"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.companyId, table.revision] }),
    companyIssueRevisionIdx: index("issue_work_projection_versions_company_issue_revision_idx")
      .on(table.companyId, table.issueId, table.revision),
  }),
);
