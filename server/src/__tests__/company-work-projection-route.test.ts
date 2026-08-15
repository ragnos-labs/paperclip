import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { companyWorkProjectionRoutes } from "../routes/company-work-projection.js";
import { canonicalCompanyWorkProjectionJson } from "../services/company-work-projection.js";

describe("company work projection route", () => {
  it("uses RFC 8785-compatible UTF-8 canonical JSON for evidence digests", () => {
    const canonical = canonicalCompanyWorkProjectionJson({ z: 0, b: [3, true, null], a: "é" });
    expect(canonical).toBe('{"a":"é","b":[3,true,null],"z":0}');
    expect(createHash("sha256").update(canonical, "utf8").digest("hex"))
      .toBe("1ddc151ac0e74d66d6f122fe9e0d709f50340765cb97df5e047d3896c0adfb08");
  });

  it("rate limits genuinely overlapping reads per credential", async () => {
    const companyId = randomUUID();
    const credentialId = randomUUID();
    let releaseRead: () => void = () => undefined;
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const instance = express();
    instance.use((req, _res, next) => {
      req.actor = {
        type: "none",
        companyId,
        credentialId,
        source: "none",
      };
      next();
    });
    instance.use("/api", companyWorkProjectionRoutes({} as never, {
      maxConcurrentReadsPerCredential: 1,
      readSnapshot: async () => {
        markEntered();
        await blocked;
        return {
          apiVersion: "paperclip.company-work-projection/v1",
          schemaVersion: 1,
          companyId,
          snapshot: {
            revision: "0",
            issuedAt: "2026-08-14T20:00:00.000Z",
            expiresAt: "2026-08-14T20:05:00.000Z",
          },
          items: [],
          page: { size: 0, hasMore: false, nextCursor: null, completeness: "complete" },
          etag: `"${"a".repeat(64)}"`,
        };
      },
    }));
    instance.use(errorHandler);

    const first = request(instance)
      .get(`/api/v1/companies/${companyId}/work-projection`)
      .then((response) => response);
    await entered;
    const second = await request(instance).get(`/api/v1/companies/${companyId}/work-projection`);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBe("1");

    releaseRead();
    expect((await first).status).toBe(200);
  });
});
