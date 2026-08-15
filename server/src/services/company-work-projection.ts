import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  COMPANY_WORK_PROJECTION_API_VERSION,
  COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
  companyWorkProjectionItemSchema,
  companyWorkProjectionResponseSchema,
  type CompanyWorkProjectionItem,
  type CompanyWorkProjectionResponse,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import {
  assertCompanyWorkProjectionCursorSigningReady,
  decodeCompanyWorkProjectionCursor,
  encodeCompanyWorkProjectionCursor,
} from "./company-work-projection-cursor.js";

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_ISSUED_AT_BUCKET_MS = 60 * 1000;

type ProjectionRow = {
  issue_id: string;
  revision: string | number | bigint;
  identifier: string | null;
  project_id: string | null;
  assignee_agent_id: string | null;
  assignee_user_id: string | null;
  status: string | null;
  priority: string | null;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  project_reference_valid: boolean;
  assignee_agent_reference_valid: boolean;
  assignee_user_reference_valid: boolean;
};

type SnapshotInput = {
  companyId: string;
  cursor?: string;
  pageSize?: number;
  now?: Date;
  cursorSecretForTest?: string;
};

function projectionError(status: number, message: string, code: string): never {
  throw new HttpError(status, message, { code });
}

function decimal(value: unknown): string {
  const normalized = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(normalized)) {
    projectionError(409, "Work projection revision is incompatible", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return normalized;
}

function instant(value: Date | string | null, field: string): string {
  if (value === null) {
    projectionError(409, `Work projection ${field} is missing`, "WORK_PROJECTION_INCOMPATIBLE");
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    projectionError(409, `Work projection ${field} is malformed`, "WORK_PROJECTION_INCOMPATIBLE");
  }
  return date.toISOString();
}

function nullableInstant(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    projectionError(409, "Work projection timestamp is malformed", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return date.toISOString();
}

/** RFC 8785-compatible canonical JSON for this contract's JSON value subset. */
export function canonicalCompanyWorkProjectionJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not support non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCompanyWorkProjectionJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalCompanyWorkProjectionJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON supports only JSON values");
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalCompanyWorkProjectionJson(value), "utf8").digest("hex");
}

function toItem(row: ProjectionRow): CompanyWorkProjectionItem {
  if (
    !row.project_reference_valid
    || !row.assignee_agent_reference_valid
    || !row.assignee_user_reference_valid
  ) {
    projectionError(409, "Work projection contains a cross-company reference", "WORK_PROJECTION_INCOMPATIBLE");
  }
  if (row.assignee_agent_id && row.assignee_user_id) {
    projectionError(409, "Work projection contains an ambiguous owner", "WORK_PROJECTION_INCOMPATIBLE");
  }
  const safeFields = {
    id: row.issue_id,
    identifier: row.identifier,
    owner: row.assignee_agent_id
      ? { type: "agent" as const, id: row.assignee_agent_id }
      : row.assignee_user_id
        ? { type: "user" as const, id: row.assignee_user_id }
        : { type: "unassigned" as const },
    projectId: row.project_id,
    priority: row.priority,
    planningState: row.status,
    timestamps: {
      createdAt: instant(row.created_at, "createdAt"),
      updatedAt: instant(row.updated_at, "updatedAt"),
      startedAt: nullableInstant(row.started_at),
      completedAt: nullableInstant(row.completed_at),
      cancelledAt: nullableInstant(row.cancelled_at),
    },
    revision: decimal(row.revision),
  };
  const candidate = {
    ...safeFields,
    evidence: { algorithm: "sha256" as const, digest: canonicalDigest(safeFields) },
  };
  const parsed = companyWorkProjectionItemSchema.safeParse(candidate);
  if (!parsed.success) {
    projectionError(409, "Work projection contains incompatible source data", "WORK_PROJECTION_INCOMPATIBLE");
  }
  return parsed.data;
}

function bucketedNow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / SNAPSHOT_ISSUED_AT_BUCKET_MS) * SNAPSHOT_ISSUED_AT_BUCKET_MS);
}

export function companyWorkProjectionService(db: Db) {
  return {
    readSnapshot: async (input: SnapshotInput): Promise<CompanyWorkProjectionResponse> => {
      const now = input.now ?? new Date();
      // Signing readiness is part of endpoint readiness even when an empty or
      // one-page response would not otherwise need to emit a cursor.
      assertCompanyWorkProjectionCursorSigningReady(input.companyId, input.cursorSecretForTest);
      const decoded = input.cursor
        ? decodeCompanyWorkProjectionCursor(
            input.cursor,
            input.companyId,
            now,
            input.cursorSecretForTest,
          )
        : null;
      if (decoded && input.pageSize !== undefined && input.pageSize !== decoded.pageSize) {
        projectionError(400, "Cursor page size cannot be changed", "WORK_PROJECTION_MALFORMED");
      }
      const pageSize = decoded?.pageSize
        ?? input.pageSize
        ?? COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE) {
        projectionError(400, "Invalid work projection page size", "WORK_PROJECTION_MALFORMED");
      }

      return db.transaction(async (tx) => {
        // PostgreSQL enforces the endpoint's no-write property in addition to
        // the application tests that compare every projection-adjacent table.
        await tx.execute(sql.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"));

        const revisionRows = Array.from(await tx.execute(sql<{
          current_revision: string | number | bigint;
        }>`
          SELECT current_revision
          FROM public.company_work_projection_revisions
          WHERE company_id = ${input.companyId}::uuid
        `));
        if (!revisionRows[0]) {
          projectionError(409, "Work projection counter is missing", "WORK_PROJECTION_INCOMPATIBLE");
        }
        const currentRevision = decimal(revisionRows[0].current_revision);
        const issuedAt = decoded?.issuedAt ?? bucketedNow(now).toISOString();
        const expiresAt = decoded?.expiresAt
          ?? new Date(new Date(issuedAt).getTime() + SNAPSHOT_TTL_MS).toISOString();
        const snapshotRevision = decoded?.snapshotRevision ?? currentRevision;

        const integrityRows = Array.from(await tx.execute(sql<{
          row_count: string | number | bigint;
          min_revision: string | number | bigint | null;
          max_revision: string | number | bigint | null;
        }>`
          SELECT count(*) AS row_count, min(revision) AS min_revision, max(revision) AS max_revision
          FROM public.issue_work_projection_versions
          WHERE company_id = ${input.companyId}::uuid
        `));
        const integrity = integrityRows[0];
        const rowCount = decimal(integrity?.row_count ?? 0);
        const expectedEmpty = currentRevision === "0";
        if (
          rowCount !== currentRevision ||
          (!expectedEmpty && (decimal(integrity?.min_revision ?? 0) !== "1" || decimal(integrity?.max_revision ?? 0) !== currentRevision))
        ) {
          projectionError(409, "Work projection snapshot has a revision gap", "WORK_PROJECTION_INCOMPATIBLE");
        }

        if (BigInt(snapshotRevision) > BigInt(currentRevision)) {
          projectionError(410, "Work projection snapshot is stale", "WORK_PROJECTION_SNAPSHOT_STALE");
        }
        if (decoded && BigInt(decoded.afterRevision) > BigInt(snapshotRevision)) {
          projectionError(400, "Malformed work projection cursor position", "WORK_PROJECTION_MALFORMED");
        }

        const afterRevision = decoded?.afterRevision ?? "0";
        const afterIssueId = decoded?.afterIssueId;
        const rows = Array.from(await tx.execute(sql<ProjectionRow>`
          WITH latest AS (
            SELECT DISTINCT ON (issue_id)
              issue_id, revision, deleted, identifier, project_id,
              assignee_agent_id, assignee_user_id, status, priority,
              started_at, completed_at, cancelled_at, created_at, updated_at
            FROM public.issue_work_projection_versions
            WHERE company_id = ${input.companyId}::uuid
              AND revision <= ${snapshotRevision}::bigint
            ORDER BY issue_id, revision DESC
          )
          SELECT
            issue_id, revision, identifier, project_id,
            assignee_agent_id, assignee_user_id, status, priority,
            started_at, completed_at, cancelled_at, created_at, updated_at,
            CASE WHEN project_id IS NULL THEN true ELSE EXISTS (
              SELECT 1 FROM public.projects
              WHERE public.projects.id = latest.project_id
                AND public.projects.company_id = ${input.companyId}::uuid
            ) END AS project_reference_valid,
            CASE WHEN assignee_agent_id IS NULL THEN true ELSE EXISTS (
              SELECT 1 FROM public.agents
              WHERE public.agents.id = latest.assignee_agent_id
                AND public.agents.company_id = ${input.companyId}::uuid
            ) END AS assignee_agent_reference_valid,
            CASE WHEN assignee_user_id IS NULL THEN true ELSE EXISTS (
              SELECT 1 FROM public.company_memberships
              WHERE public.company_memberships.company_id = ${input.companyId}::uuid
                AND public.company_memberships.principal_type = 'user'
                AND public.company_memberships.principal_id = latest.assignee_user_id
                AND public.company_memberships.status = 'active'
            ) END AS assignee_user_reference_valid
          FROM latest
          WHERE deleted = false
            AND (
              revision > ${afterRevision}::bigint
              OR (revision = ${afterRevision}::bigint AND issue_id > ${afterIssueId ?? "00000000-0000-0000-0000-000000000000"}::uuid)
            )
          ORDER BY revision, issue_id
          LIMIT ${pageSize + 1}
        `)) as ProjectionRow[];

        const hasMore = rows.length > pageSize;
        const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
        const items = pageRows.map(toItem);
        const lastRow = pageRows.at(-1);
        const nextCursor = hasMore && lastRow
          ? encodeCompanyWorkProjectionCursor({
              apiVersion: COMPANY_WORK_PROJECTION_API_VERSION,
              schemaVersion: COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
              companyId: input.companyId,
              snapshotRevision,
              issuedAt,
              expiresAt,
              afterRevision: decimal(lastRow.revision),
              afterIssueId: lastRow.issue_id,
              pageSize,
            }, input.cursorSecretForTest)
          : null;

        const bodyWithoutEtag = {
          apiVersion: COMPANY_WORK_PROJECTION_API_VERSION,
          schemaVersion: COMPANY_WORK_PROJECTION_SCHEMA_VERSION,
          companyId: input.companyId,
          snapshot: { revision: snapshotRevision, issuedAt, expiresAt },
          items,
          page: {
            size: items.length,
            hasMore,
            nextCursor,
            completeness: hasMore ? "partial" as const : "complete" as const,
          },
        };
        const response = {
          ...bodyWithoutEtag,
          etag: `"${canonicalDigest(bodyWithoutEtag)}"`,
        };
        const parsed = companyWorkProjectionResponseSchema.safeParse(response);
        if (!parsed.success) {
          projectionError(409, "Work projection response is incompatible", "WORK_PROJECTION_INCOMPATIBLE");
        }
        return parsed.data;
      });
    },
  };
}
