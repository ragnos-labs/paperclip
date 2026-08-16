import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import {
  createCompanyWorkProjectionCredentialSchema,
  type CompanyWorkProjectionResponse,
  type CompanyWorkProjectionV2Response,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { companyWorkProjectionService } from "../services/company-work-projection.js";
import {
  companyWorkProjectionCredentialService,
  companyWorkProjectionV2CredentialService,
} from "../services/company-work-projection-credentials.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { companyWorkProjectionReadRoutes } from "./company-work-projection-read.js";

export { companyWorkProjectionReadRoutes, ifNoneMatchMatches } from "./company-work-projection-read.js";

export function companyWorkProjectionRoutes(
  db: Db,
  options: {
    readSnapshot?: (input: {
      companyId: string;
      credentialId: string;
      cursor?: string;
      pageSize?: number;
    }) => Promise<CompanyWorkProjectionResponse>;
    readSnapshotV2?: (input: {
      companyId: string;
      credentialId: string;
      cursor?: string;
      pageSize?: number;
    }) => Promise<CompanyWorkProjectionV2Response>;
  } = {},
) {
  const router = Router();
  const service = companyWorkProjectionService(db);
  const credentials = companyWorkProjectionCredentialService(db);
  const credentialsV2 = companyWorkProjectionV2CredentialService(db);
  const readSnapshot = options.readSnapshot ?? service.readSnapshot;
  const readSnapshotV2 = options.readSnapshotV2 ?? service.readSnapshotV2;
  router.use(companyWorkProjectionReadRoutes({ readSnapshot, readSnapshotV2 }));

  async function requireCompany(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    assertBoard(req);
    const company = await db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0] ?? null);
    if (!company || !hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Work projection credential management requires company administration");
    return userId;
  }

  router.get("/v1/companies/:companyId/work-projection-credentials", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    res.json(await credentials.list(companyId, actorId));
  });

  router.post(
    "/v1/companies/:companyId/work-projection-credentials",
    validate(createCompanyWorkProjectionCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorId = await requireCompany(req, companyId);
      const credential = await credentials.create(companyId, req.body.name, actorId);
      res.status(201).json(credential);
    },
  );

  router.delete("/v1/companies/:companyId/work-projection-credentials/:credentialId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    const credential = await credentials.revoke(
      companyId,
      req.params.credentialId as string,
      actorId,
    );
    if (!credential) throw notFound("Work projection credential not found");
    res.json(credential);
  });

  router.get("/v2/companies/:companyId/work-projection-credentials", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    res.json(await credentialsV2.list(companyId, actorId));
  });

  router.post(
    "/v2/companies/:companyId/work-projection-credentials",
    validate(createCompanyWorkProjectionCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorId = await requireCompany(req, companyId);
      const credential = await credentialsV2.create(companyId, req.body.name, actorId);
      res.status(201).json(credential);
    },
  );

  router.delete("/v2/companies/:companyId/work-projection-credentials/:credentialId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompany(req, companyId);
    const credential = await credentialsV2.revoke(
      companyId,
      req.params.credentialId as string,
      actorId,
    );
    if (!credential) throw notFound("Work projection credential not found");
    res.json(credential);
  });

  return router;
}
