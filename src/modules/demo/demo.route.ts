import { Router, Request, Response, NextFunction } from "express";
import { ApiError } from "../../utils/apiError";
import * as demoController from "./demo.controller";

// Vercel Cron automatically sends `Authorization: Bearer <CRON_SECRET>`.
// No secret configured = nobody gets in.
function requireCronSecret(req: Request, _res: Response, next: NextFunction) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    throw new ApiError(401, "Unauthorized");
  }
  next();
}

const router = Router();

router.get("/restore", requireCronSecret, demoController.restoreDemoChanges); // Vercel Cron only makes GET requests

export default router;