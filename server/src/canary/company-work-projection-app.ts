import { createHash } from "node:crypto";
import express from "express";
import {
  COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE,
  COMPANY_WORK_PROJECTION_V2_API_VERSION,
  COMPANY_WORK_PROJECTION_V2_SCHEMA_VERSION,
  companyWorkProjectionV2ResponseSchema,
  type CompanyWorkProjectionResponse,
  type CompanyWorkProjectionV2Response,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { companyWorkProjectionCredentialGuard } from "../middleware/company-work-projection-credential-guard.js";
import { companyWorkProjectionReadRoutes } from "../routes/company-work-projection-read.js";
import {
  decodeCompanyWorkProjectionV2Cursor,
  encodeCompanyWorkProjectionV2Cursor,
} from "../services/company-work-projection-cursor.js";
import {
  canonicalCompanyWorkProjectionJson,
  normalizeCompanyWorkProjectionV2Item,
  type CompanyWorkProjectionSourceRow,
} from "../services/company-work-projection.js";

export type CompanyWorkProjectionCanaryFixture = "empty" | "synthetic";

export type CompanyWorkProjectionCanaryConfig = {
  companyId: string;
  fixture: CompanyWorkProjectionCanaryFixture;
  token: string;
};

const CANARY_CONTRACT = "paperclip.company-work-projection-canary/v1" as const;
const SNAPSHOT_ISSUED_AT = "2026-08-16T00:00:00.000Z";
const SNAPSHOT_EXPIRES_AT = "2026-08-16T00:05:00.000Z";
const CURSOR_READ_TIME = new Date("2026-08-16T00:01:00.000Z");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalCompanyWorkProjectionJson(value), "utf8")
    .digest("hex");
}

export function deriveCompanyWorkProjectionCanaryToken(
  companyId: string,
  fixture: CompanyWorkProjectionCanaryFixture,
): string {
  const material = digest({ contract: CANARY_CONTRACT, companyId, fixture, purpose: "synthetic-auth" });
  return `pcwp_v2_${material.slice(0, 48)}`;
}

function deriveCredentialId(companyId: string, fixture: CompanyWorkProjectionCanaryFixture): string {
  const material = digest({ contract: CANARY_CONTRACT, companyId, fixture, purpose: "credential-id" });
  return `${material.slice(0, 8)}-${material.slice(8, 12)}-4${material.slice(13, 16)}-a${material.slice(17, 20)}-${material.slice(20, 32)}`;
}

function cursorSecret(companyId: string, fixture: CompanyWorkProjectionCanaryFixture): string {
  return digest({ contract: CANARY_CONTRACT, companyId, fixture, purpose: "cursor-signing" });
}

function sourceRow(input: {
  issueId: string;
  revision: number;
  identifier: string;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  workProjectionContext?: CompanyWorkProjectionSourceRow["work_projection_context"];
  recordedAt: string;
}): CompanyWorkProjectionSourceRow {
  const createdAt = "2026-08-16T00:00:00.000Z";
  return {
    head_issue_id: input.issueId,
    head_first_revision: input.revision,
    issue_id: input.issueId,
    revision: input.revision,
    identifier: input.identifier,
    project_id: null,
    assignee_agent_id: input.assigneeAgentId ?? null,
    assignee_user_id: input.assigneeUserId ?? null,
    status: "todo",
    priority: "medium",
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    created_at: createdAt,
    updated_at: input.recordedAt,
    project_reference_valid: true,
    assignee_agent_reference_valid: true,
    assignee_user_reference_valid: true,
    delegation_authorizer_reference_valid: true,
    work_projection_context: input.workProjectionContext ?? null,
    recorded_at: input.recordedAt,
    deleted: false,
  };
}

function syntheticRows(): CompanyWorkProjectionSourceRow[] {
  const delegation = {
    onBehalfOf: { type: "human" as const, id: "canary-operator" },
    grantReference: "paperclip:canary:delegation:1",
    grantDigest: `sha256:${"a".repeat(64)}`,
    grantedAt: "2026-08-16T00:00:00.000Z",
  };
  return [
    sourceRow({
      issueId: "22222222-2222-4222-8222-222222222221",
      revision: 1,
      identifier: "CANARY-1",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333",
      workProjectionContext: {
        objective: "Validate the deterministic repository-change work projection.",
        objectiveExportApproved: true,
        intent: {
          type: "repository_change",
          repository: "github:ragnos-labs/paperclip",
          baseRevision: "immutable-canary-source",
          allowedPaths: ["server/src/**"],
          prohibitedPaths: ["secrets/**"],
        },
        delegation,
      },
      recordedAt: "2026-08-16T00:00:01.000Z",
    }),
    sourceRow({
      issueId: "22222222-2222-4222-8222-222222222222",
      revision: 2,
      identifier: "CANARY-2",
      assigneeUserId: "canary-operator",
      workProjectionContext: {
        objective: "Validate the deterministic artifact-delivery work projection.",
        objectiveExportApproved: true,
        intent: {
          type: "artifact_delivery",
          artifactReference: "paperclip:canary:artifact:1",
          destinationReference: "paperclip:canary:review",
        },
        delegation: null,
      },
      recordedAt: "2026-08-16T00:00:02.000Z",
    }),
    sourceRow({
      issueId: "22222222-2222-4222-8222-222222222223",
      revision: 3,
      identifier: "CANARY-3",
      recordedAt: "2026-08-16T00:00:03.000Z",
    }),
  ];
}

function unsupportedV1Read(): Promise<CompanyWorkProjectionResponse> {
  throw new HttpError(403, "Canary credential is scoped to work projection v2", {
    code: "WORK_PROJECTION_FORBIDDEN",
  });
}

function createReadSnapshotV2(config: CompanyWorkProjectionCanaryConfig) {
  const rows = config.fixture === "synthetic" ? syntheticRows() : [];
  const snapshotRevision = config.fixture === "synthetic" ? "3" : "0";
  const signingSecret = cursorSecret(config.companyId, config.fixture);

  return async (input: {
    companyId: string;
    credentialId: string;
    cursor?: string;
    pageSize?: number;
  }): Promise<CompanyWorkProjectionV2Response> => {
    if (input.companyId !== config.companyId) {
      throw new HttpError(403, "Canary credential is company-bound", {
        code: "WORK_PROJECTION_FORBIDDEN",
      });
    }
    const decoded = input.cursor
      ? decodeCompanyWorkProjectionV2Cursor(
          input.cursor,
          config.companyId,
          CURSOR_READ_TIME,
          signingSecret,
        )
      : null;
    if (decoded && input.pageSize !== undefined && input.pageSize !== decoded.pageSize) {
      throw new HttpError(400, "Cursor page size cannot be changed", {
        code: "WORK_PROJECTION_MALFORMED",
      });
    }
    const pageSize = decoded?.pageSize ?? input.pageSize ?? COMPANY_WORK_PROJECTION_DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > COMPANY_WORK_PROJECTION_MAX_PAGE_SIZE) {
      throw new HttpError(400, "Invalid work projection page size", {
        code: "WORK_PROJECTION_MALFORMED",
      });
    }
    const afterRevision = BigInt(decoded?.afterRevision ?? "0");
    const afterIssueId = decoded?.afterIssueId ?? "00000000-0000-0000-0000-000000000000";
    const remaining = rows.filter((row) => {
      const revision = BigInt(row.head_first_revision);
      return revision > afterRevision
        || (revision === afterRevision && row.head_issue_id > afterIssueId);
    });
    const hasMore = remaining.length > pageSize;
    const pageRows = remaining.slice(0, pageSize);
    const items = pageRows.map((row) => normalizeCompanyWorkProjectionV2Item(row, config.companyId));
    const lastRow = pageRows.at(-1);
    const nextCursor = hasMore && lastRow
      ? encodeCompanyWorkProjectionV2Cursor({
          apiVersion: COMPANY_WORK_PROJECTION_V2_API_VERSION,
          schemaVersion: COMPANY_WORK_PROJECTION_V2_SCHEMA_VERSION,
          companyId: config.companyId,
          snapshotRevision,
          issuedAt: SNAPSHOT_ISSUED_AT,
          expiresAt: SNAPSHOT_EXPIRES_AT,
          afterRevision: String(lastRow.head_first_revision),
          afterIssueId: lastRow.head_issue_id,
          pageSize,
        }, signingSecret)
      : null;
    const bodyWithoutEtag = {
      apiVersion: COMPANY_WORK_PROJECTION_V2_API_VERSION,
      schemaVersion: COMPANY_WORK_PROJECTION_V2_SCHEMA_VERSION,
      companyId: config.companyId,
      snapshot: {
        revision: snapshotRevision,
        issuedAt: SNAPSHOT_ISSUED_AT,
        expiresAt: SNAPSHOT_EXPIRES_AT,
      },
      items,
      page: {
        size: items.length,
        hasMore,
        nextCursor,
        completeness: hasMore ? "partial" as const : "complete" as const,
      },
    };
    return companyWorkProjectionV2ResponseSchema.parse({
      ...bodyWithoutEtag,
      etag: `"${digest(bodyWithoutEtag)}"`,
    });
  };
}

function validateConfig(config: CompanyWorkProjectionCanaryConfig): void {
  if (!UUID_PATTERN.test(config.companyId)) {
    throw new Error("PAPERCLIP_WORK_PROJECTION_CANARY_COMPANY_ID must be a UUID");
  }
  if (config.fixture !== "empty" && config.fixture !== "synthetic") {
    throw new Error("PAPERCLIP_WORK_PROJECTION_CANARY_FIXTURE must be empty or synthetic");
  }
  const expected = deriveCompanyWorkProjectionCanaryToken(config.companyId, config.fixture);
  if (config.token !== expected) {
    throw new Error("Canary token must be the deterministic synthetic token for this company and fixture");
  }
}

export function createCompanyWorkProjectionCanaryApp(config: CompanyWorkProjectionCanaryConfig) {
  validateConfig(config);
  const app = express();
  app.disable("x-powered-by");
  const requestMethods: Record<string, number> = {};
  const requestPaths: string[] = [];
  const credentialId = deriveCredentialId(config.companyId, config.fixture);
  const stateDigest = digest({
    contract: CANARY_CONTRACT,
    companyId: config.companyId,
    fixture: config.fixture,
    credentialId,
    tokenHash: digest(config.token),
    rows: config.fixture === "synthetic" ? syntheticRows() : [],
  });

  app.use((req, res, next) => {
    requestMethods[req.method] = (requestMethods[req.method] ?? 0) + 1;
    requestPaths.push(req.path);
    if (req.method !== "GET") {
      res.status(405).json({ error: "Canary accepts GET requests only", code: "CANARY_GET_ONLY" });
      return;
    }
    next();
  });
  app.use((req, _res, next) => {
    req.actor = { type: "none", source: "none" };
    const authorization = req.header("authorization");
    const token = authorization?.toLowerCase().startsWith("bearer ")
      ? authorization.slice("bearer ".length).trim()
      : null;
    if (token === config.token) {
      req.actor = {
        type: "none",
        companyId: config.companyId,
        credentialId,
        credentialTokenVersion: 2,
        source: "none",
      };
    }
    next();
  });
  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      canary: {
        contract: CANARY_CONTRACT,
        classification: "artifact-only-read-route-schema-normalization-cursor",
        fixture: config.fixture,
        companyId: config.companyId,
        stateDigest,
        database: { connections: 0, tables: 0, writes: 0 },
        filesystem: { persistentFiles: 0, writes: 0 },
        providerMutations: 0,
        schedulerTasks: 0,
        requestMethods: { ...requestMethods },
        requestPaths: [...requestPaths],
      },
    });
  });
  app.use(companyWorkProjectionCredentialGuard());
  app.use("/api", companyWorkProjectionReadRoutes({
    readSnapshot: unsupportedV1Read,
    readSnapshotV2: createReadSnapshotV2(config),
  }));
  app.use((_req, res) => {
    res.status(404).json({ error: "Canary route not found", code: "CANARY_ROUTE_NOT_FOUND" });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? error.details as Record<string, unknown>
        : null;
      res.status(error.status).json({
        error: error.message,
        ...(typeof details?.code === "string" ? { code: details.code } : {}),
      });
      return;
    }
    res.status(500).json({ error: "Canary request failed", code: "CANARY_INTERNAL_ERROR" });
  });
  return app;
}
