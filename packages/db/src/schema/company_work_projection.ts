import { bigint, boolean, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

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
