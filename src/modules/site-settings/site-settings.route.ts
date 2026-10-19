import { Router } from "express";
import * as siteSettingsController from "./site-settings.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

// Public: fetch site settings for frontend rendering
router.get("/", siteSettingsController.getSiteSettings);

// Admin only: update site settings
router.patch(
  "/",
  requireAuth,
  requireRole("admin"),
  siteSettingsController.updateSiteSettings
);

export default router;
