import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyWorkProjectionQuerySchema } from "@paperclipai/shared";
import { HttpError, forbidden } from "../errors.js";
import { companyWorkProjectionService } from "../services/company-work-projection.js";

export function companyWorkProjectionRoutes(
  db: Db,
  options: { maxConcurrentReadsPerCredential?: number } = {},
) {
  const router = Router();
  const service = companyWorkProjectionService(db);
  const activeReads = new Map<string, number>();
  const maxConcurrentReads = options.maxConcurrentReadsPerCredential ?? 4;

  router.get("/v1/companies/:companyId/work-projection", async (req, res, next) => {
    const companyId = req.params.companyId;
    if (req.actor.type === "none") {
      next(new HttpError(401, "Work projection credential required", {
        code: "WORK_PROJECTION_UNAUTHORIZED",
      }));
      return;
    }
    if (
      req.actor.type !== "agent" ||
      req.actor.source !== "agent_key" ||
      req.actor.keyScope?.kind !== "company_work_projection_read" ||
      req.actor.companyId !== companyId ||
      !req.actor.keyId
    ) {
      next(forbidden("Work projection credential cannot access this company", {
        code: "WORK_PROJECTION_FORBIDDEN",
      }));
      return;
    }

    const query = companyWorkProjectionQuerySchema.safeParse(req.query);
    if (!query.success) {
      next(new HttpError(400, "Malformed work projection request", {
        code: "WORK_PROJECTION_MALFORMED",
      }));
      return;
    }

    const limiterKey = req.actor.keyId;
    const active = activeReads.get(limiterKey) ?? 0;
    if (active >= maxConcurrentReads) {
      res.set("Retry-After", "1");
      next(new HttpError(429, "Work projection read is rate limited", {
        code: "WORK_PROJECTION_RATE_LIMITED",
      }));
      return;
    }
    activeReads.set(limiterKey, active + 1);

    try {
      const result = await service.readSnapshot({
        companyId,
        cursor: query.data.cursor,
        pageSize: query.data.pageSize,
      });
      res.set({
        ETag: result.etag,
        "Cache-Control": "private, no-cache",
        Vary: "Authorization",
        "X-Paperclip-Api-Version": result.apiVersion,
        "X-Paperclip-Schema-Version": String(result.schemaVersion),
        "X-Paperclip-Snapshot-Revision": result.snapshot.revision,
      });
      if (req.header("if-none-match") === result.etag) {
        res.status(304).end();
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        next(error);
      } else {
        next(new HttpError(503, "Work projection is unavailable", {
          code: "WORK_PROJECTION_UNAVAILABLE",
        }));
      }
    } finally {
      const remaining = (activeReads.get(limiterKey) ?? 1) - 1;
      if (remaining > 0) activeReads.set(limiterKey, remaining);
      else activeReads.delete(limiterKey);
    }
  });

  return router;
}
