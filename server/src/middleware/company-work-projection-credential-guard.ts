import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

const PROJECTION_PATH = /^\/api\/v1\/companies\/([^/]+)\/work-projection\/?$/;

/**
 * A projection key is a capability, not a role. It is rejected everywhere
 * except the one company-bound GET/HEAD route even if the owning agent later
 * gains membership or role authority.
 */
export function companyWorkProjectionCredentialGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor?.keyScope?.kind !== "company_work_projection_read") {
      next();
      return;
    }

    const match = PROJECTION_PATH.exec(req.path);
    const companyId = match?.[1];
    const allowedMethod = req.method === "GET" || req.method === "HEAD";
    if (
      req.actor.source !== "agent_key" ||
      !allowedMethod ||
      !companyId ||
      companyId !== req.actor.companyId
    ) {
      next(forbidden("Projection credential cannot access this resource", {
        code: "WORK_PROJECTION_FORBIDDEN",
      }));
      return;
    }

    next();
  };
}
