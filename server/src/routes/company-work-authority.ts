import { Router } from "express";
import { companies, type Db } from "@paperclipai/db";
import {
  companyWorkAuthorityDispatchRequestSchema,
  companyWorkAuthorityPreviewRequestSchema,
  createCompanyWorkProjectionCredentialSchema,
} from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  companyWorkAuthorityCredentialService,
} from "../services/company-work-projection-credentials.js";
import { companyWorkAuthorityService } from "../services/company-work-authority.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";

type AuthorityService = ReturnType<typeof companyWorkAuthorityService>;

export function companyWorkAuthorityRoutes(
  db: Db,
  options: { service?: AuthorityService } = {},
) {
  const router = Router();
  const service = options.service ?? companyWorkAuthorityService(db);
  const credentials = companyWorkAuthorityCredentialService(db);

  async function requireCompanyAdmin(req: Parameters<typeof assertCompanyAccess>[0], companyId: string) {
    assertBoard(req);
    const company = await db.select({ id: companies.id }).from(companies)
      .where(eq(companies.id, companyId)).then((rows) => rows[0] ?? null);
    if (!company || !hasCompanyAccess(req, companyId)) throw notFound("Company not found");
    assertCompanyAccess(req, companyId);
    if (!req.actor.userId) throw forbidden("Work authority credential management requires company administration");
    return req.actor.userId;
  }

  function requireWriterCredential(req: Express.Request, companyId: string) {
    if (
      req.actor.type !== "none"
      || req.actor.companyId !== companyId
      || !req.actor.credentialId
      || req.actor.credentialTokenVersion !== 3
    ) {
      throw forbidden("Work authority credential cannot access this company", {
        code: "WORK_AUTHORITY_FORBIDDEN",
      });
    }
    return req.actor.credentialId;
  }

  function requireBoundWriter(action: { writerRef: string }, credentialId: string) {
    if (action.writerRef !== `paperclip:work-authority-credential:${credentialId}`) {
      throw forbidden("Work authority writer does not match the authenticated credential", {
        code: "WORK_AUTHORITY_WRITER_MISMATCH",
      });
    }
  }

  router.get("/v1/companies/:companyId/work-authority-credentials", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompanyAdmin(req, companyId);
    res.json(await credentials.list(companyId, actorId));
  });

  router.post(
    "/v1/companies/:companyId/work-authority-credentials",
    validate(createCompanyWorkProjectionCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const actorId = await requireCompanyAdmin(req, companyId);
      res.status(201).json(await credentials.create(companyId, req.body.name, actorId));
    },
  );

  router.delete("/v1/companies/:companyId/work-authority-credentials/:credentialId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const actorId = await requireCompanyAdmin(req, companyId);
    const result = await credentials.revoke(companyId, req.params.credentialId as string, actorId);
    if (!result) throw notFound("Work authority credential not found");
    res.json(result);
  });

  router.get("/v1/companies/:companyId/work-authority", async (req, res) => {
    const companyId = req.params.companyId as string;
    requireWriterCredential(req, companyId);
    const result = await service.snapshot(companyId);
    res.set({
      ETag: `"${result.digest.slice("sha256:".length)}"`,
      "Cache-Control": "private, no-cache",
      Vary: "Authorization",
      "X-Paperclip-Api-Version": result.apiVersion,
      "X-Paperclip-Schema-Version": String(result.schemaVersion),
      "X-Paperclip-Snapshot-Revision": result.revision,
    });
    res.json(result);
  });

  router.post(
    "/v1/companies/:companyId/work-authority/preview",
    validate(companyWorkAuthorityPreviewRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const credentialId = requireWriterCredential(req, companyId);
      if (req.body.action.companyId !== companyId) throw forbidden("Work authority action company does not match credential");
      requireBoundWriter(req.body.action, credentialId);
      res.json(await service.preview(req.body.action));
    },
  );

  router.post(
    "/v1/companies/:companyId/work-authority/dispatch",
    validate(companyWorkAuthorityDispatchRequestSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const credentialId = requireWriterCredential(req, companyId);
      if (req.body.action.companyId !== companyId) throw forbidden("Work authority action company does not match credential");
      requireBoundWriter(req.body.action, credentialId);
      res.json(await service.dispatch(req.body.action, req.body.previewHash));
    },
  );

  router.get("/v1/companies/:companyId/work-authority/receipts/:idempotencyKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    requireWriterCredential(req, companyId);
    const receipt = await service.receipt(companyId, req.params.idempotencyKey as string);
    if (!receipt) throw notFound("Work authority receipt not found");
    res.json(receipt);
  });

  return router;
}
