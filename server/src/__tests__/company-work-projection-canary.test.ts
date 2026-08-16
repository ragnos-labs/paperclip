import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { companyWorkProjectionV2ResponseSchema } from "@paperclipai/shared";
import {
  createCompanyWorkProjectionCanaryApp,
  deriveCompanyWorkProjectionCanaryToken,
  type CompanyWorkProjectionCanaryFixture,
} from "../canary/company-work-projection-app.js";

const companyId = "11111111-1111-4111-8111-111111111111";

function app(fixture: CompanyWorkProjectionCanaryFixture) {
  return createCompanyWorkProjectionCanaryApp({
    companyId,
    fixture,
    token: deriveCompanyWorkProjectionCanaryToken(companyId, fixture),
  });
}

describe("company work projection artifact canary", () => {
  it("rejects arbitrary launch credentials before the app can start", () => {
    expect(() => createCompanyWorkProjectionCanaryApp({
      companyId,
      fixture: "empty",
      token: "production-or-operator-supplied-token",
    })).toThrow("Canary token must be the deterministic synthetic token");
  });

  it("proves authenticated complete-empty reads without persistent state", async () => {
    const instance = app("empty");
    const token = deriveCompanyWorkProjectionCanaryToken(companyId, "empty");

    const before = await request(instance).get("/api/health");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      status: "ok",
      canary: {
        contract: "paperclip.company-work-projection-canary/v1",
        fixture: "empty",
        database: { connections: 0, tables: 0, writes: 0 },
        filesystem: { persistentFiles: 0, writes: 0 },
        providerMutations: 0,
        schedulerTasks: 0,
      },
    });

    const missing = await request(instance)
      .get(`/api/v2/companies/${companyId}/work-projection`);
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ code: "WORK_PROJECTION_UNAUTHORIZED" });

    const invalid = await request(instance)
      .get(`/api/v2/companies/${companyId}/work-projection`)
      .set("Authorization", `Bearer pcwp_v2_${"f".repeat(48)}`);
    expect(invalid.status).toBe(401);
    expect(invalid.body).toMatchObject({ code: "WORK_PROJECTION_UNAUTHORIZED" });

    const projection = await request(instance)
      .get(`/api/v2/companies/${companyId}/work-projection`)
      .set("Authorization", `Bearer ${token}`);
    expect(projection.status).toBe(200);
    expect(companyWorkProjectionV2ResponseSchema.parse(projection.body).page).toEqual({
      size: 0,
      hasMore: false,
      nextCursor: null,
      completeness: "complete",
    });

    const after = await request(instance).get("/api/health");
    expect(after.status).toBe(200);
    expect(after.body.canary.stateDigest).toBe(before.body.canary.stateDigest);
    expect(after.body.canary.database).toEqual(before.body.canary.database);
    expect(after.body.canary.filesystem).toEqual(before.body.canary.filesystem);
    expect(after.body.canary.providerMutations).toBe(0);
    expect(after.body.canary.requestMethods).toEqual({ GET: 5 });
    expect(after.body.canary.requestPaths).not.toContainEqual(
      expect.stringContaining("work-projection-credentials"),
    );
  });

  it("keeps the synthetic credential company, version, method, and route scoped", async () => {
    const instance = app("synthetic");
    const token = deriveCompanyWorkProjectionCanaryToken(companyId, "synthetic");

    const wrongCompany = await request(instance)
      .get(`/api/v2/companies/${randomUUID()}/work-projection`)
      .set("Authorization", `Bearer ${token}`);
    expect(wrongCompany.status).toBe(403);
    expect(wrongCompany.body).toMatchObject({ code: "WORK_PROJECTION_FORBIDDEN" });

    const wrongVersion = await request(instance)
      .get(`/api/v1/companies/${companyId}/work-projection`)
      .set("Authorization", `Bearer ${token}`);
    expect(wrongVersion.status).toBe(403);
    expect(wrongVersion.body).toMatchObject({ code: "WORK_PROJECTION_FORBIDDEN" });

    const wrongMethod = await request(instance)
      .post(`/api/v2/companies/${companyId}/work-projection`)
      .set("Authorization", `Bearer ${token}`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.body).toMatchObject({ code: "CANARY_GET_ONLY" });

    const managementSurface = await request(instance)
      .get(`/api/v2/companies/${companyId}/work-projection-credentials`)
      .set("Authorization", `Bearer ${token}`);
    expect(managementSurface.status).toBe(403);
    expect(managementSurface.body).toMatchObject({ code: "WORK_PROJECTION_FORBIDDEN" });
  });

  it("replays deterministic synthetic pages, cursors, timestamps, and receipts", async () => {
    const instance = app("synthetic");
    const token = deriveCompanyWorkProjectionCanaryToken(companyId, "synthetic");
    const get = (path: string) => request(instance)
      .get(path)
      .set("Authorization", `Bearer ${token}`);

    const first = await get(`/api/v2/companies/${companyId}/work-projection?pageSize=2`);
    const replay = await get(`/api/v2/companies/${companyId}/work-projection?pageSize=2`);
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    const parsedFirst = companyWorkProjectionV2ResponseSchema.parse(first.body);
    expect(parsedFirst.page).toMatchObject({ size: 2, hasMore: true, completeness: "partial" });
    expect(parsedFirst.page.nextCursor).toEqual(expect.any(String));
    expect(parsedFirst.snapshot).toEqual({
      revision: "3",
      issuedAt: "2026-08-16T00:00:00.000Z",
      expiresAt: "2026-08-16T00:05:00.000Z",
    });

    const second = await get(
      `/api/v2/companies/${companyId}/work-projection?cursor=${encodeURIComponent(parsedFirst.page.nextCursor!)}`,
    );
    expect(second.status).toBe(200);
    const parsedSecond = companyWorkProjectionV2ResponseSchema.parse(second.body);
    expect(parsedSecond.page).toEqual({
      size: 1,
      hasMore: false,
      nextCursor: null,
      completeness: "complete",
    });
    expect([...parsedFirst.items, ...parsedSecond.items].map((item) => item.identifier))
      .toEqual(["CANARY-1", "CANARY-2", "CANARY-3"]);

    const ready = [...parsedFirst.items, ...parsedSecond.items]
      .filter((item) => item.packetContext.availability === "ready");
    expect(ready).toHaveLength(2);
    expect(ready.map((item) => item.packetContext.availability === "ready"
      ? item.packetContext.sourceReceipt.issuedAt
      : null)).toEqual([
      "2026-08-16T00:00:01.000Z",
      "2026-08-16T00:00:02.000Z",
    ]);

    const firstAgain = await get(`/api/v2/companies/${companyId}/work-projection?pageSize=2`);
    const secondAgain = await get(
      `/api/v2/companies/${companyId}/work-projection?cursor=${encodeURIComponent(parsedFirst.page.nextCursor!)}`,
    );
    expect(firstAgain.body).toEqual(first.body);
    expect(secondAgain.body).toEqual(second.body);
  });
});
