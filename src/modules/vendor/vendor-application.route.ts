import { Router } from "express";
import { validate } from "../../utils/validate";
import {
  applicationStatusLookupSchema,
  createApplicationSchema,
  reviewApplicationSchema,
  updateMyApplicationSchema,
} from "./vendor-application.validator";
import * as controller from "./vendor-application.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { requireInternalKey } from "../../middlewares/internal.middleware";

const router = Router();

/**
 * Route order matters. The fixed paths come before `/:id`, otherwise Express
 * reads "mine" as an application id.
 */

// The auth layer asks this after it has checked the password. It is not
// public: the shared key is the only way in, and an unknown email gets a 404.
router.post(
  "/status",
  requireInternalKey,
  validate(applicationStatusLookupSchema),
  controller.getStatusForVerifiedEmail
);

// ─── Applicant ────────────────────────────────────────────────────────────────
router.get("/mine", requireAuth, controller.getMyApplication);
// The seller's profile page writes the file the wizard created and keeps the
// storefront row in step. The row is found from the token, so there is no path
// here to another seller's shop, and the slug and the plan stay out of reach.
router.patch(
  "/mine",
  requireAuth,
  validate(updateMyApplicationSchema),
  controller.updateMyApplication
);
router.post("/mine/cancel", requireAuth, controller.cancelMyApplication);
router.post(
  "/",
  requireAuth,
  validate(createApplicationSchema),
  controller.submitApplication
);

// ─── Store team ───────────────────────────────────────────────────────────────
router.get("/", requireAuth, requireRole("admin"), controller.listApplications);
router.get("/:id", requireAuth, requireRole("admin"), controller.getApplication);
router.patch(
  "/:id/review",
  requireAuth,
  requireRole("admin"),
  validate(reviewApplicationSchema),
  controller.reviewApplication
);

export default router;
