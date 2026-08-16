import { Router } from "express";
import {
  companyWorkProjectionQuerySchema,
  type CompanyWorkProjectionResponse,
  type CompanyWorkProjectionV2Response,
} from "@paperclipai/shared";
import { HttpError, forbidden } from "../errors.js";

function splitEntityTags(header: string): string[] {
  const tags: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === "," && !quoted) {
      tags.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  tags.push(header.slice(start).trim());
  return tags.filter(Boolean);
}

function weakEntityTag(value: string): string {
  return value.startsWith("W/") ? value.slice(2) : value;
}

export function ifNoneMatchMatches(header: string | undefined, currentEtag: string): boolean {
  if (!header) return false;
  return splitEntityTags(header).some((candidate) => (
    candidate === "*" || weakEntityTag(candidate) === weakEntityTag(currentEtag)
  ));
}

export type CompanyWorkProjectionReadRoutesOptions = {
  readSnapshot: (input: {
    companyId: string;
    credentialId: string;
    cursor?: string;
    pageSize?: number;
  }) => Promise<CompanyWorkProjectionResponse>;
  readSnapshotV2: (input: {
    companyId: string;
    credentialId: string;
    cursor?: string;
    pageSize?: number;
  }) => Promise<CompanyWorkProjectionV2Response>;
};

/**
 * The dependency-owned, read-only projection surface. Keeping this router in a
 * standalone module prevents the canary entrypoint from importing credential
 * management, database, auth, or production logging modules.
 */
export function companyWorkProjectionReadRoutes(options: CompanyWorkProjectionReadRoutesOptions) {
  const router = Router();

  router.get("/v1/companies/:companyId/work-projection", async (req, res, next) => {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "none" && !req.actor.credentialId) {
      next(new HttpError(401, "Work projection credential required", {
        code: "WORK_PROJECTION_UNAUTHORIZED",
      }));
      return;
    }
    if (
      req.actor.type !== "none" ||
      req.actor.companyId !== companyId ||
      !req.actor.credentialId ||
      req.actor.credentialTokenVersion !== 1
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

    try {
      const result = await options.readSnapshot({
        companyId,
        credentialId: req.actor.credentialId,
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
      if (ifNoneMatchMatches(req.header("if-none-match"), result.etag)) {
        res.status(304).end();
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) res.set("Retry-After", "1");
        next(error);
      } else {
        next(new HttpError(503, "Work projection is unavailable", {
          code: "WORK_PROJECTION_UNAVAILABLE",
        }));
      }
    }
  });

  router.get("/v2/companies/:companyId/work-projection", async (req, res, next) => {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "none" && !req.actor.credentialId) {
      next(new HttpError(401, "Work projection credential required", {
        code: "WORK_PROJECTION_UNAUTHORIZED",
      }));
      return;
    }
    if (
      req.actor.type !== "none" ||
      req.actor.companyId !== companyId ||
      !req.actor.credentialId ||
      req.actor.credentialTokenVersion !== 2
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

    try {
      const result = await options.readSnapshotV2({
        companyId,
        credentialId: req.actor.credentialId,
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
      if (ifNoneMatchMatches(req.header("if-none-match"), result.etag)) {
        res.status(304).end();
        return;
      }
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 429) res.set("Retry-After", "1");
        next(error);
      } else {
        next(new HttpError(503, "Work projection is unavailable", {
          code: "WORK_PROJECTION_UNAVAILABLE",
        }));
      }
    }
  });

  return router;
}
