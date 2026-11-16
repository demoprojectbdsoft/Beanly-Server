import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";
import { requireAuth } from "./auth.middleware";

/**
 * Vercel Cron calls a route with `Authorization: Bearer <CRON_SECRET>` when the
 * secret is configured, and always sends `x-vercel-cron: "1"`.
 */
function isCronInvocation(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization === `Bearer ${secret}`) return true;
  return req.headers["x-vercel-cron"] === "1";
}

/**
 * Lets a scheduled job through, or a signed-in store admin calling the same
 * route by hand. Used by the demo restore job and the delivery sweep, both of
 * which need to run on a host without a long-lived process.
 */
export function requireCronOrAdmin(req: Request, res: Response, next: NextFunction) {
  if (isCronInvocation(req)) return next();

  return requireAuth(req, res, (err?: any) => {
    if (err) {
      return next(
        new ApiError(401, "Unauthorized: Valid CRON_SECRET, Vercel Cron, or Admin token required")
      );
    }
    const role = (req.user?.role || "").toLowerCase();
    if (role === "admin") {
      return next();
    }
    return next(new ApiError(403, "Forbidden: Store Admin privileges required"));
  });
}
