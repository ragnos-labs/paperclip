import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  applyPendingMigrations,
  companies,
  companyMemberships,
  companyWorkProjectionCredentials,
  companyWorkProjectionRevisions,
  createDb,
  issueRecoveryActions,
  issues,
  issueWorkProjectionVersions,
  projects,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import { companyWorkProjectionCredentialGuard } from "../middleware/company-work-projection-credential-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { companyWorkProjectionRoutes } from "../routes/company-work-projection.js";
import { encodeCompanyWorkProjectionCursor } from "../services/company-work-projection-cursor.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.unmock("http");
vi.unmock("node:http");

const externalDatabaseUrl = process.env.PAPERCLIP_WORK_PROJECTION_TEST_DATABASE_URL?.trim();
const support = externalDatabaseUrl
  ? { supported: true as const }
  : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping company work projection tests: ${support.reason ?? "embedded PostgreSQL unavailable"}`);
}

const signingSecret = "synthetic-company-work-projection-secret";

function signRawCursorPayload(payload: string, companyId: string) {
  const companyKey = createHmac("sha256", signingSecret)
    .update(`company-work-projection-cursor:v1:${resolvePaperclipInstanceId()}:${companyId}`)
    .digest();
  return createHmac("sha256", companyKey).update(payload).digest("base64url");
}

describePostgres("company work projection", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

  beforeAll(async () => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = signingSecret;
    if (externalDatabaseUrl) {
      await applyPendingMigrations(externalDatabaseUrl);
      db = createDb(externalDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-company-work-projection-");
      db = createDb(tempDb.connectionString);
    }
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(activityLog);
    await db.delete(companyWorkProjectionCredentials);
    await db.delete(agentApiKeys);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (originalJwtSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
    await tempDb?.cleanup();
  });

  function app(maxConcurrentReadsPerCredential = 4) {
    const instance = express();
    instance.locals.paperclipDb = db;
    instance.use(express.json());
    instance.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    instance.use(companyWorkProjectionCredentialGuard());
    instance.use("/api", companyWorkProjectionRoutes(db, { maxConcurrentReadsPerCredential }));
    instance.use(errorHandler);
    return instance;
  }

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const credentialId = randomUUID();
    const token = `pcwp_v1_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await db.insert(companies).values([
      { id: companyId, name: "Synthetic Alpha", issuePrefix: `A${companyId.slice(0, 6)}` },
      { id: otherCompanyId, name: "Synthetic Beta", issuePrefix: `B${otherCompanyId.slice(0, 6)}` },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Synthetic Reader",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companyWorkProjectionCredentials).values({
      id: credentialId,
      companyId,
      name: "controller-read",
      keyHash: createHash("sha256").update(token).digest("hex"),
      tokenVersion: 1,
    });
    return { companyId, otherCompanyId, agentId, credentialId, token };
  }

  async function addIssue(
    companyId: string,
    input: { priority?: "critical" | "high" | "medium" | "low"; assigneeAgentId?: string | null } = {},
  ) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: `Synthetic ${id}`,
      identifier: `SYN-${id.slice(0, 8)}`,
      priority: input.priority ?? "medium",
      status: "todo",
      assigneeAgentId: input.assigneeAgentId ?? null,
    });
    return id;
  }

  async function getProjection(token: string, companyId: string, query = "") {
    return request(app())
      .get(`/api/v1/companies/${companyId}/work-projection${query}`)
      .set("Authorization", `Bearer ${token}`);
  }

  async function legacyAgentKeyLookup(token: string) {
    return db.select({ id: agentApiKeys.id })
      .from(agentApiKeys)
      .where(and(
        eq(agentApiKeys.keyHash, createHash("sha256").update(token).digest("hex")),
        sql`${agentApiKeys.revokedAt} IS NULL`,
      ));
  }

  it("returns empty-complete and one-page bounded projections without any read mutation", async () => {
    const seeded = await seed();
    const empty = await getProjection(seeded.token, seeded.companyId);
    expect(empty.status).toBe(200);
    expect(empty.body.page).toMatchObject({ size: 0, hasMore: false, completeness: "complete" });

    const issueId = await addIssue(seeded.companyId, { assigneeAgentId: seeded.agentId });
    const before = {
      credential: await db.select().from(companyWorkProjectionCredentials)
        .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId)),
      activity: await db.select().from(activityLog),
      recovery: await db.select().from(issueRecoveryActions),
      revisions: await db.select().from(companyWorkProjectionRevisions),
      versions: await db.select().from(issueWorkProjectionVersions),
    };
    const response = await getProjection(seeded.token, seeded.companyId);
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe(response.body.etag);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0]).toMatchObject({
      id: issueId,
      owner: { type: "agent", id: seeded.agentId },
      planningState: "todo",
      priority: "medium",
    });
    const serialized = JSON.stringify(response.body);
    for (const privateField of ["title", "description", "adapterConfig", "workspace", "recovery", "credentials"]) {
      expect(serialized).not.toContain(privateField);
    }
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId))).toEqual(before.credential);
    expect(await db.select().from(activityLog)).toEqual(before.activity);
    expect(await db.select().from(issueRecoveryActions)).toEqual(before.recovery);
    expect(await db.select().from(companyWorkProjectionRevisions)).toEqual(before.revisions);
    expect(await db.select().from(issueWorkProjectionVersions)).toEqual(before.versions);

    const conditional = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .set("If-None-Match", response.body.etag);
    expect(conditional.status).toBe(304);
    expect(conditional.text).toBe("");

    for (const ifNoneMatch of [
      "*",
      `W/${response.body.etag}`,
      `"unrelated", W/${response.body.etag}`,
    ]) {
      const standardsConditional = await request(app())
        .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
        .set("Authorization", `Bearer ${seeded.token}`)
        .set("If-None-Match", ifNoneMatch);
      expect(standardsConditional.status, ifNoneMatch).toBe(304);
    }
    const nonMatch = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${seeded.token}`)
      .set("If-None-Match", 'W/"unrelated"');
    expect(nonMatch.status).toBe(200);
  });

  it("keeps current, malformed, mixed-version, and rolled-back credential handling fail closed", async () => {
    const seeded = await seed();
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
    expect(await legacyAgentKeyLookup(seeded.token)).toEqual([]);

    const malformedToken = `pcwp_v1_${"b".repeat(48)}`;
    const sharedHash = createHash("sha256").update(malformedToken).digest("hex");
    await db.insert(companyWorkProjectionCredentials).values({
      companyId: seeded.companyId,
      name: "malformed-version",
      keyHash: sharedHash,
      tokenVersion: 999,
    });
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "mixed-version-collision",
      keyHash: sharedHash,
      responsibleUserId: "synthetic-user",
      scopeConfig: null,
    });

    const malformed = await getProjection(malformedToken, seeded.companyId);
    expect(malformed.status).toBe(401);
    const mixedCollision = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, sharedHash));
    expect(mixedCollision[0]?.lastUsedAt).toBeNull();
    expect(await legacyAgentKeyLookup(seeded.token)).toEqual([]);

    await db.update(companyWorkProjectionCredentials)
      .set({ revokedAt: new Date() })
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(401);
  });

  it("clears implicit board authority for malformed projection-family tokens", async () => {
    const seeded = await seed();
    const malformedToken = "pcwp_future_malformed";
    const malformedHash = createHash("sha256").update(malformedToken).digest("hex");
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "unknown-scope-collision",
      keyHash: malformedHash,
      responsibleUserId: "synthetic-user",
      scopeConfig: { kind: "unknown_future_scope" },
    });

    const localTrusted = express();
    localTrusted.use(express.json());
    localTrusted.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    localTrusted.use(companyWorkProjectionCredentialGuard());
    localTrusted.use("/api", companyWorkProjectionRoutes(db));
    localTrusted.use(errorHandler);

    const projection = await request(localTrusted)
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${malformedToken}`);
    expect(projection.status).toBe(401);

    const mutation = await request(localTrusted)
      .post(`/api/v1/companies/${seeded.companyId}/work-projection-credentials`)
      .set("Authorization", `Bearer ${malformedToken}`)
      .send({ name: "must-not-create" });
    expect(mutation.status).toBe(403);
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.name, "must-not-create"))).toEqual([]);
    const legacyCollision = await db.select().from(agentApiKeys)
      .where(eq(agentApiKeys.keyHash, malformedHash));
    expect(legacyCollision[0]?.lastUsedAt).toBeNull();
  });

  it("is unavailable without signing readiness for both empty and one-page collections", async () => {
    const seeded = await seed();
    const previousAgentSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    const previousAuthSecret = process.env.BETTER_AUTH_SECRET;
    try {
      delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      delete process.env.BETTER_AUTH_SECRET;
      const empty = await getProjection(seeded.token, seeded.companyId);
      expect(empty.status).toBe(503);
      expect(empty.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");

      await addIssue(seeded.companyId);
      const onePage = await getProjection(seeded.token, seeded.companyId);
      expect(onePage.status).toBe(503);
      expect(onePage.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");
    } finally {
      if (previousAgentSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previousAgentSecret;
      if (previousAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previousAuthSecret;
    }
  });

  it("paginates a stable high-water snapshot and replays cursors deterministically", async () => {
    const seeded = await seed();
    const firstId = await addIssue(seeded.companyId, { priority: "low" });
    const secondId = await addIssue(seeded.companyId, { priority: "medium" });
    const thirdId = await addIssue(seeded.companyId, { priority: "high" });

    const first = await getProjection(seeded.token, seeded.companyId, "?pageSize=1");
    expect(first.status).toBe(200);
    expect(first.body.items[0].id).toBe(firstId);
    expect(first.body.page).toMatchObject({ size: 1, hasMore: true, completeness: "partial" });

    await db.update(issues).set({ priority: "critical", updatedAt: new Date() }).where(eq(issues.id, thirdId));

    const pageTwoPath = `?cursor=${encodeURIComponent(first.body.page.nextCursor)}`;
    const second = await getProjection(seeded.token, seeded.companyId, pageTwoPath);
    const replay = await getProjection(seeded.token, seeded.companyId, pageTwoPath);
    expect(second.status).toBe(200);
    expect(replay.body).toEqual(second.body);
    expect(second.body.items[0].id).toBe(secondId);
    expect(second.body.snapshot.revision).toBe(first.body.snapshot.revision);

    const third = await getProjection(
      seeded.token,
      seeded.companyId,
      `?cursor=${encodeURIComponent(second.body.page.nextCursor)}`,
    );
    expect(third.body.items).toMatchObject([{ id: thirdId, priority: "high" }]);
    expect(third.body.page).toMatchObject({ hasMore: false, completeness: "complete" });

    const fresh = await getProjection(seeded.token, seeded.companyId, "?pageSize=10");
    expect(BigInt(fresh.body.snapshot.revision)).toBeGreaterThan(BigInt(first.body.snapshot.revision));
    expect(fresh.body.items.find((item: { id: string }) => item.id === thirdId).priority).toBe("critical");
  });

  it("projects delete, hide, harness, company-move, and plugin-operation transitions without gaps", async () => {
    const seeded = await seed();
    const targetToken = `pcwp_v1_${"c".repeat(48)}`;
    await db.insert(companyWorkProjectionCredentials).values({
      companyId: seeded.otherCompanyId,
      name: "target-reader",
      keyHash: createHash("sha256").update(targetToken).digest("hex"),
      tokenVersion: 1,
    });

    const lifecycleId = await addIssue(seeded.companyId);
    const pluginId = randomUUID();
    await db.insert(issues).values({
      id: pluginId,
      companyId: seeded.companyId,
      title: "Synthetic plugin operation",
      identifier: "PLUGIN-1",
      status: "todo",
      priority: "low",
      originKind: "plugin:synthetic:operation",
    });
    expect((await getProjection(seeded.token, seeded.companyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([lifecycleId]);

    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ hiddenAt: null }).where(eq(issues.id, lifecycleId));
    await db.update(issues).set({ harnessKind: "evaluation" }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ harnessKind: null }).where(eq(issues.id, lifecycleId));

    await db.update(issues).set({ originKind: "plugin:synthetic:operation" }).where(eq(issues.id, lifecycleId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    await db.update(issues).set({ originKind: "manual" }).where(eq(issues.id, lifecycleId));

    const movingId = await addIssue(seeded.companyId);
    await db.update(issues).set({ companyId: seeded.otherCompanyId }).where(eq(issues.id, movingId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([lifecycleId]);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).body.items.map((item: { id: string }) => item.id))
      .toEqual([movingId]);

    await db.delete(issues).where(eq(issues.id, lifecycleId));
    await db.delete(issues).where(eq(issues.id, movingId));
    expect((await getProjection(seeded.token, seeded.companyId)).body.items).toEqual([]);
    expect((await getProjection(targetToken, seeded.otherCompanyId)).body.items).toEqual([]);

    for (const companyId of [seeded.companyId, seeded.otherCompanyId]) {
      const history = await db.select().from(issueWorkProjectionVersions)
        .where(eq(issueWorkProjectionVersions.companyId, companyId));
      const counter = await db.select().from(companyWorkProjectionRevisions)
        .where(eq(companyWorkProjectionRevisions.companyId, companyId));
      expect(history.map((row) => row.revision).sort((left, right) => Number(left - right))).toEqual(
        Array.from({ length: history.length }, (_, index) => BigInt(index + 1)),
      );
      expect(counter[0]?.currentRevision).toBe(BigInt(history.length));
    }
  });

  it("separates unauthorized, forbidden, malformed, stale, expired, incompatible, and rate-limited results", async () => {
    const seeded = await seed();
    await addIssue(seeded.companyId);

    expect((await request(app()).get(`/api/v1/companies/${seeded.companyId}/work-projection`)).status).toBe(401);
    expect((await getProjection(seeded.token, seeded.otherCompanyId)).status).toBe(403);
    expect((await getProjection(seeded.token, seeded.companyId, "?pageSize=9999")).status).toBe(400);
    expect((await request(app(0))
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${seeded.token}`)).status).toBe(429);

    const standardToken = `pc_standard_${randomUUID()}`;
    await db.insert(agentApiKeys).values({
      agentId: seeded.agentId,
      companyId: seeded.companyId,
      name: "wrong-profile",
      keyHash: createHash("sha256").update(standardToken).digest("hex"),
      responsibleUserId: "synthetic-user",
      scopeConfig: null,
    });
    expect((await getProjection(standardToken, seeded.companyId)).status).toBe(403);

    const baseCursor = {
      apiVersion: "paperclip.company-work-projection/v1" as const,
      schemaVersion: 1 as const,
      companyId: seeded.companyId,
      issuedAt: "2026-08-14T20:00:00.000Z",
      expiresAt: "2099-08-14T20:05:00.000Z",
      afterRevision: "0",
      afterIssueId: null,
      pageSize: 100,
    };
    const stale = encodeCompanyWorkProjectionCursor({ ...baseCursor, snapshotRevision: "999" }, signingSecret);
    const staleResponse = await getProjection(seeded.token, seeded.companyId, `?cursor=${encodeURIComponent(stale)}`);
    expect(staleResponse.status).toBe(410);
    expect(staleResponse.body.code).toBe("WORK_PROJECTION_SNAPSHOT_STALE");

    const expired = encodeCompanyWorkProjectionCursor({
      ...baseCursor,
      snapshotRevision: "1",
      issuedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:05:00.000Z",
    }, signingSecret);
    const expiredResponse = await getProjection(seeded.token, seeded.companyId, `?cursor=${encodeURIComponent(expired)}`);
    expect(expiredResponse.status).toBe(410);
    expect(expiredResponse.body.code).toBe("WORK_PROJECTION_SNAPSHOT_EXPIRED");

    const incompatiblePayload = Buffer.from(JSON.stringify({
      ...baseCursor,
      apiVersion: "paperclip.company-work-projection/v2",
      schemaVersion: 2,
      snapshotRevision: "1",
    })).toString("base64url");
    const incompatibleResponse = await getProjection(
      seeded.token,
      seeded.companyId,
      `?cursor=${encodeURIComponent(
        `${incompatiblePayload}.${signRawCursorPayload(incompatiblePayload, seeded.companyId)}`,
      )}`,
    );
    expect(incompatibleResponse.status).toBe(409);
    expect(incompatibleResponse.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");
  });

  it("returns an explicit unavailable result when the projection store cannot be read", async () => {
    const companyId = randomUUID();
    const unavailableApp = express();
    unavailableApp.use((req, _res, next) => {
      req.actor = {
        type: "none",
        companyId,
        credentialId: randomUUID(),
        source: "none",
      };
      next();
    });
    unavailableApp.use("/api", companyWorkProjectionRoutes({
      transaction: async () => {
        throw new Error("synthetic database outage");
      },
    } as unknown as Parameters<typeof companyWorkProjectionRoutes>[0]));
    unavailableApp.use(errorHandler);

    const response = await request(unavailableApp).get(`/api/v1/companies/${companyId}/work-projection`);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("WORK_PROJECTION_UNAVAILABLE");
  });

  it("rejects every non-projection or mutation use without role-drift authority", async () => {
    const seeded = await seed();
    const before = await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId));
    await db.update(agents).set({ role: "ceo", permissions: { "tasks:assign": true } })
      .where(eq(agents.id, seeded.agentId));
    const attempts = [
      ["head", `/api/v1/companies/${seeded.companyId}/work-projection`],
      ["post", `/api/v1/companies/${seeded.companyId}/work-projection`],
      ["patch", `/api/issues/${randomUUID()}`],
      ["delete", `/api/issues/${randomUUID()}`],
      ["post", `/api/approvals/${randomUUID()}/approve`],
      ["post", `/api/issues/${randomUUID()}/assign`],
      ["post", `/api/issues/${randomUUID()}/transition`],
      ["get", `/api/v1/companies/${seeded.otherCompanyId}/work-projection`],
    ] as const;
    for (const [method, path] of attempts) {
      const response = await request(app())[method](path).set("Authorization", `Bearer ${seeded.token}`);
      expect(response.status, `${method.toUpperCase()} ${path}`).toBe(403);
      if (method !== "head") expect(response.body.code).toBe("WORK_PROJECTION_FORBIDDEN");
    }
    const jwt = createLocalAgentJwt(
      seeded.agentId,
      seeded.companyId,
      "process",
      randomUUID(),
      null,
      { kind: "standard" },
    );
    expect(jwt).not.toBeNull();
    const jwtResponse = await request(app())
      .get(`/api/v1/companies/${seeded.companyId}/work-projection`)
      .set("Authorization", `Bearer ${jwt}`);
    expect(jwtResponse.status).toBe(403);
    expect(jwtResponse.body.code).toBe("WORK_PROJECTION_FORBIDDEN");
    expect(await db.select().from(companyWorkProjectionCredentials)
      .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId))).toEqual(before);
    expect(await db.select().from(activityLog)).toEqual([]);
  });

  it("fails closed for revision gaps and unknown current planning state", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    await db.update(issues).set({ status: "unknown_state", updatedAt: new Date() }).where(eq(issues.id, issueId));
    const unknown = await getProjection(seeded.token, seeded.companyId);
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");

    await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issueId));
    await db.delete(issueWorkProjectionVersions).where(and(
      eq(issueWorkProjectionVersions.companyId, seeded.companyId),
      eq(issueWorkProjectionVersions.revision, 2n),
    ));
    const gap = await getProjection(seeded.token, seeded.companyId);
    expect(gap.status).toBe(409);
    expect(gap.body.code).toBe("WORK_PROJECTION_INCOMPATIBLE");
  });

  it("fails closed for missing, behind, ahead, and partially restored revision state", async () => {
    const seeded = await seed();
    await addIssue(seeded.companyId);
    const originalHistory = await db.select().from(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, seeded.companyId));

    await db.delete(companyWorkProjectionRevisions)
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.insert(companyWorkProjectionRevisions).values({
      companyId: seeded.companyId,
      currentRevision: 1n,
    });
    await db.update(companyWorkProjectionRevisions).set({ currentRevision: 0n })
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.update(companyWorkProjectionRevisions).set({ currentRevision: 2n })
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.update(companyWorkProjectionRevisions).set({ currentRevision: 1n })
      .where(eq(companyWorkProjectionRevisions.companyId, seeded.companyId));
    await db.delete(issueWorkProjectionVersions)
      .where(eq(issueWorkProjectionVersions.companyId, seeded.companyId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);

    await db.insert(issueWorkProjectionVersions).values(originalHistory);
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("fails closed instead of projecting cross-company project, agent, or user references", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    const otherAgentId = randomUUID();
    const otherProjectId = randomUUID();
    const otherUserId = "synthetic-foreign-user";
    await db.insert(agents).values({
      id: otherAgentId,
      companyId: seeded.otherCompanyId,
      name: "Synthetic foreign agent",
      role: "integration",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId: seeded.otherCompanyId,
      name: "Synthetic foreign project",
    });
    await db.insert(companyMemberships).values({
      companyId: seeded.otherCompanyId,
      principalType: "user",
      principalId: otherUserId,
      status: "active",
      membershipRole: "member",
    });

    await db.update(issues).set({ projectId: otherProjectId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ projectId: null, assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: otherUserId }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(409);
    await db.update(issues).set({ assigneeUserId: null }).where(eq(issues.id, issueId));
    expect((await getProjection(seeded.token, seeded.companyId)).status).toBe(200);
  });

  it("records trigger revisions transactionally and PostgreSQL rejects writes inside projection reads", async () => {
    const seeded = await seed();
    const issueId = await addIssue(seeded.companyId);
    await db.transaction(async (tx) => {
      await tx.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, issueId));
      const revisions = await tx.select().from(issueWorkProjectionVersions)
        .where(eq(issueWorkProjectionVersions.companyId, seeded.companyId));
      expect(revisions.map((row) => row.revision)).toEqual([1n, 2n]);
    });

    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql.raw("SET TRANSACTION READ ONLY"));
        await tx.update(companyWorkProjectionCredentials).set({ revokedAt: new Date() })
          .where(eq(companyWorkProjectionCredentials.id, seeded.credentialId));
      });
      throw new Error("expected PostgreSQL read-only enforcement");
    } catch (error) {
      expect((error as { cause?: { code?: string } }).cause?.code).toBe("25006");
    }
  });
});
