import type { RequestHandler } from "express";
import { forbidden } from "../errors.js";

const PROJECTION_PATH = /^\/api\/v([12])\/companies\/([^/]+)\/work-projection\/?$/;
const AUTHORITY_PATH = /^\/api\/v1\/companies\/([^/]+)\/work-authority(?:\/.*)?$/;

/**
 * A projection credential is a capability, not an agent role. It is rejected
 * everywhere except the one company-bound GET route.
 */
export function companyWorkProjectionCredentialGuard(): RequestHandler {
  return (req, _res, next) => {
    if (req.actor?.type !== "none" || !req.actor.credentialId) {
      next();
      return;
    }

    const match = PROJECTION_PATH.exec(req.path);
    const authorityMatch = AUTHORITY_PATH.exec(req.path);
    if (req.actor.credentialTokenVersion === 3) {
      if (!authorityMatch || authorityMatch[1] !== req.actor.companyId) {
        next(forbidden("Work authority credential cannot access this resource", {
          code: "WORK_AUTHORITY_FORBIDDEN",
        }));
        return;
      }
      next();
      return;
    }
    const tokenVersion = match?.[1] ? Number(match[1]) : null;
    const companyId = match?.[2];
    const allowedMethod = req.method === "GET";
    if (
      !allowedMethod ||
      !companyId ||
      companyId !== req.actor.companyId ||
      tokenVersion !== req.actor.credentialTokenVersion
    ) {
      next(forbidden("Projection credential cannot access this resource", {
        code: "WORK_PROJECTION_FORBIDDEN",
      }));
      return;
    }

    next();
  };
}
