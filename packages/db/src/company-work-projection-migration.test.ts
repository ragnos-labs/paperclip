import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPendingMigrations, createDb } from "./client.js";
import {
  agentApiKeys,
  agents,
  companies,
  companyWorkProjectionCredentials,
  companyWorkProjectionRevisions,
  issueWorkProjectionVersions,
  issues,
} from "./schema/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const externalDatabaseUrl = process.env.PAPERCLIP_WORK_PROJECTION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping company work projection migration test: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

const DROP_0184_SQL = `
  DROP TRIGGER IF EXISTS issues_work_projection_capture ON public.issues;
  DROP TRIGGER IF EXISTS companies_work_projection_initialize ON public.companies;
  DROP FUNCTION IF EXISTS public.capture_issue_work_projection_change();
  DROP FUNCTION IF EXISTS public.initialize_company_work_projection_revision();
  DROP FUNCTION IF EXISTS public.append_issue_work_projection_version(
    uuid, uuid, boolean, text, uuid, uuid, text, text, text,
    timestamp with time zone, timestamp with time zone, timestamp with time zone,
    timestamp with time zone, timestamp with time zone
  );
  DROP FUNCTION IF EXISTS public.company_work_projection_issue_is_visible(
    timestamp with time zone, text, text
  );
  DROP TABLE IF EXISTS public.company_work_projection_credentials;
  DROP TABLE IF EXISTS public.issue_work_projection_versions;
  DROP TABLE IF EXISTS public.company_work_projection_revisions;
`;

async function waitForBlockedIssueWriters(connectionString: string) {
  const inspector = postgres(connectionString, { max: 1, onnotice: () => undefined });
  try {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const rows = await inspector<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_locks AS locks
        JOIN pg_class AS relations ON relations.oid = locks.relation
        JOIN pg_namespace AS namespaces ON namespaces.oid = relations.relnamespace
        WHERE namespaces.nspname = 'public'
          AND relations.relname = 'issues'
          AND locks.granted = false
      `;
      if ((rows[0]?.waiting ?? 0) >= 4) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("concurrent issue writers did not block on migration lock");
  } finally {
    await inspector.end();
  }
}

describePostgres("0184 company work projection migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let connectionString!: string;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      connectionString = externalDatabaseUrl;
      await applyPendingMigrations(connectionString);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-projection-migration-");
      connectionString = tempDb.connectionString;
    }
    db = createDb(connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("locks writers across backfill, captures all concurrent mutations, seeds counters, and isolates credentials", async () => {
    await db.execute(sql.raw(DROP_0184_SQL));

    const sourceCompanyId = randomUUID();
    const targetCompanyId = randomUUID();
    const updateIssueId = randomUUID();
    const deleteIssueId = randomUUID();
    const moveIssueId = randomUUID();
    const insertIssueId = randomUUID();
    const pluginIssueId = randomUUID();
    const agentId = randomUUID();
    const legacyToken = `pcp_${"d".repeat(48)}`;

    await db.insert(companies).values([
      { id: sourceCompanyId, name: "Synthetic migration source", issuePrefix: `S${sourceCompanyId.slice(0, 6)}` },
      { id: targetCompanyId, name: "Synthetic migration target", issuePrefix: `T${targetCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId: sourceCompanyId,
      name: "Synthetic legacy reader",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.execute(sql`
      INSERT INTO public.agent_api_keys (
        id, agent_id, company_id, name, key_hash, scope_config
      ) VALUES (
        ${randomUUID()}::uuid,
        ${agentId}::uuid,
        ${sourceCompanyId}::uuid,
        'unreleased projection residue',
        ${createHash("sha256").update(legacyToken).digest("hex")},
        '{"kind":"company_work_projection_read"}'::jsonb
      )
    `);
    await db.insert(issues).values([
      {
        id: updateIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic update",
        identifier: "MIG-UPDATE",
        status: "todo",
        priority: "low",
        updatedAt: new Date("2026-08-14T20:00:00Z"),
      },
      {
        id: deleteIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic delete",
        identifier: "MIG-DELETE",
        status: "todo",
        priority: "medium",
        updatedAt: new Date("2026-08-14T20:01:00Z"),
      },
      {
        id: moveIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic move",
        identifier: "MIG-MOVE",
        status: "todo",
        priority: "high",
        updatedAt: new Date("2026-08-14T20:02:00Z"),
      },
      {
        id: pluginIssueId,
        companyId: sourceCompanyId,
        title: "Synthetic plugin operation",
        identifier: "MIG-PLUGIN",
        status: "todo",
        priority: "low",
        originKind: "plugin:synthetic:operation",
        updatedAt: new Date("2026-08-14T20:03:00Z"),
      },
    ]);

    const migration = await readFile(
      new URL("./migrations/0184_company_work_projection.sql", import.meta.url),
      "utf8",
    );
    const statements = migration
      .split("--> statement-breakpoint")
      .map((value) => value.trim())
      .filter(Boolean);
    const migrationConnection = postgres(connectionString, { max: 1, onnotice: () => undefined });
    const writers = postgres(connectionString, { max: 4, onnotice: () => undefined });
    try {
      await migrationConnection.unsafe("BEGIN");
      await migrationConnection.unsafe(statements[0]);

      const concurrentWrites = Promise.all([
        writers`
          INSERT INTO public.issues (id, company_id, title, identifier, status, priority)
          VALUES (${insertIssueId}::uuid, ${sourceCompanyId}::uuid, 'Concurrent insert', 'MIG-INSERT', 'todo', 'critical')
        `,
        writers`
          UPDATE public.issues SET status = 'in_progress', updated_at = now()
          WHERE id = ${updateIssueId}::uuid
        `,
        writers`DELETE FROM public.issues WHERE id = ${deleteIssueId}::uuid`,
        writers`
          UPDATE public.issues SET company_id = ${targetCompanyId}::uuid, updated_at = now()
          WHERE id = ${moveIssueId}::uuid
        `,
      ]);

      await waitForBlockedIssueWriters(connectionString);
      for (const statement of statements.slice(1)) {
        await migrationConnection.unsafe(statement);
      }
      await migrationConnection.unsafe("COMMIT");
      await concurrentWrites;
    } catch (error) {
      await migrationConnection.unsafe("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await writers.end();
      await migrationConnection.end();
    }

    const legacyRows = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, createHash("sha256").update(legacyToken).digest("hex")));
    expect(legacyRows[0]?.revokedAt).toBeInstanceOf(Date);

    const sourceHistory = await db.select().from(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, sourceCompanyId));
    const targetHistory = await db.select().from(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, targetCompanyId));
    for (const history of [sourceHistory, targetHistory]) {
      expect(history.map((row) => row.revision).sort((left, right) => Number(left - right))).toEqual(
        Array.from({ length: history.length }, (_, index) => BigInt(index + 1)),
      );
    }
    expect(sourceHistory.some((row) => row.issueId === insertIssueId && !row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === updateIssueId && row.status === "in_progress")).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === deleteIssueId && row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === moveIssueId && row.deleted)).toBe(true);
    expect(targetHistory.some((row) => row.issueId === moveIssueId && !row.deleted)).toBe(true);
    expect(sourceHistory.some((row) => row.issueId === pluginIssueId)).toBe(false);

    for (const [companyId, history] of [
      [sourceCompanyId, sourceHistory],
      [targetCompanyId, targetHistory],
    ] as const) {
      const counter = await db.select().from(companyWorkProjectionRevisions)
        .where(eq(companyWorkProjectionRevisions.companyId, companyId));
      expect(counter[0]?.currentRevision).toBe(BigInt(history.length));
    }

    const futureCompanyId = randomUUID();
    await db.insert(companies).values({
      id: futureCompanyId,
      name: "Synthetic future company",
      issuePrefix: `F${futureCompanyId.slice(0, 6)}`,
    });
    expect(await db.select().from(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, futureCompanyId))).toMatchObject([
      { companyId: futureCompanyId, currentRevision: 0n },
    ]);

    const projectionToken = `pcwp_v1_${"e".repeat(48)}`;
    const projectionHash = createHash("sha256").update(projectionToken).digest("hex");
    await db.insert(companyWorkProjectionCredentials).values({
      companyId: sourceCompanyId,
      name: "Synthetic dedicated reader",
      keyHash: projectionHash,
      tokenVersion: 1,
    });
    expect(await db.select().from(agentApiKeys).where(eq(agentApiKeys.keyHash, projectionHash))).toEqual([]);
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.keyHash, projectionHash))).toHaveLength(1);
  }, 30_000);
});
