import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyPendingMigrations,
  createDb,
} from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";
import {
  companies,
  companyWorkProjectionRevisions,
  issues,
  issueWorkProjectionVersions,
} from "./schema/index.js";

const externalDatabaseUrl = process.env.PAPERCLIP_WORK_PROJECTION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

if (!support.supported) {
  console.warn(`Skipping company work projection migration test: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

describePostgres("0184 company work projection migration", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-projection-migration-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("backfills visible work deterministically and captures later changes", async () => {
    await db.execute(sql.raw('DROP TRIGGER IF EXISTS "issues_work_projection_capture" ON "issues"'));
    await db.execute(sql.raw("DROP FUNCTION IF EXISTS capture_issue_work_projection_change()"));
    await db.execute(sql.raw(`
      DROP FUNCTION IF EXISTS append_issue_work_projection_version(
        uuid, uuid, boolean, text, uuid, uuid, text, text, text,
        timestamp with time zone, timestamp with time zone, timestamp with time zone,
        timestamp with time zone, timestamp with time zone
      )
    `));
    await db.execute(sql.raw('DROP TABLE IF EXISTS "issue_work_projection_versions"'));
    await db.execute(sql.raw('DROP TABLE IF EXISTS "company_work_projection_revisions"'));

    const companyId = randomUUID();
    const visibleOlderId = randomUUID();
    const visibleNewerId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic Migration Company",
      issuePrefix: `M${companyId.slice(0, 6)}`,
    });
    await db.insert(issues).values([
      {
        id: visibleOlderId,
        companyId,
        title: "Synthetic visible older",
        identifier: "MIG-1",
        status: "todo",
        priority: "low",
        createdAt: new Date("2026-08-14T20:00:00.000Z"),
        updatedAt: new Date("2026-08-14T20:00:00.000Z"),
      },
      {
        id: visibleNewerId,
        companyId,
        title: "Synthetic visible newer",
        identifier: "MIG-2",
        status: "in_progress",
        priority: "high",
        createdAt: new Date("2026-08-14T20:01:00.000Z"),
        updatedAt: new Date("2026-08-14T20:01:00.000Z"),
      },
      {
        companyId,
        title: "Synthetic hidden",
        identifier: "MIG-HIDDEN",
        hiddenAt: new Date("2026-08-14T20:02:00.000Z"),
      },
      {
        companyId,
        title: "Synthetic harness",
        identifier: "MIG-HARNESS",
        harnessKind: "evaluation",
      },
    ]);

    const migration = await readFile(new URL("./migrations/0184_company_work_projection.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.execute(sql.raw(statement));
    }

    const versions = await db.select().from(issueWorkProjectionVersions);
    expect(versions.map((row) => ({ id: row.issueId, revision: row.revision }))).toEqual([
      { id: visibleOlderId, revision: 1n },
      { id: visibleNewerId, revision: 2n },
    ]);
    expect(await db.select().from(companyWorkProjectionRevisions)).toMatchObject([
      { companyId, currentRevision: 2n },
    ]);

    await db.update(issues).set({ status: "done", updatedAt: new Date("2026-08-14T20:03:00Z") })
      .where(sql`${issues.id} = ${visibleOlderId}::uuid`);
    const afterUpdate = await db.select().from(issueWorkProjectionVersions);
    expect(afterUpdate.at(-1)).toMatchObject({ issueId: visibleOlderId, revision: 3n, status: "done" });
  });
});
