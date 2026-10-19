import { Router, Request, Response, NextFunction } from "express";
import { ApiError } from "../../utils/apiError";
import * as demoController from "./demo.controller";

import { requireAuth } from "../../middlewares/auth.middleware";

// Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`.
// Also allows authenticated Store Admin to trigger manual restore.
function requireCronOrAdmin(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization;

  if (secret && authHeader === `Bearer ${secret}`) {
    return next();
  }

  // Also allow authenticated admin to trigger restore
  return requireAuth(req, res, (err?: any) => {
    if (err) {
      return next(new ApiError(401, "Unauthorized: Valid CRON_SECRET or Admin token required"));
    }
    const role = (req.user?.role || "").toLowerCase();
    if (role === "admin") {
      return next();
    }
    return next(new ApiError(403, "Forbidden: Store Admin privileges required"));
  });
}

const router = Router();

router.get("/restore", requireCronOrAdmin, demoController.restoreDemoChanges); // Vercel Cron only makes GET requests
router.post("/restore", requireCronOrAdmin, demoController.restoreDemoChanges); // Convenient for API/manual calls

export default router;