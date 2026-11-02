import { Router } from "express";
import * as deliveryController from "./delivery.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { requireCronOrAdmin } from "../../middlewares/cron.middleware";
import { validate } from "../../utils/validate";
import {
  assignDeliverySchema,
  cancelDeliverySchema,
  declineDeliverySchema,
  locationSchema,
  reassignDeliverySchema,
  riderStepSchema,
  verifyOtpSchema,
} from "./delivery.validator";

const router = Router();

/**
 * Route order matters here.
 *
 * The store's `/admin/...` routes and the scheduled sweep are declared before
 * the rider's `/:id` routes, so `/admin` is never mistaken for a delivery id.
 * The rider routes then take a real ObjectId only.
 */

// ─── Scheduled ────────────────────────────────────────────────────────────────

/** Closes offers nobody answered. Called by Vercel Cron or an admin by hand. */
router.get("/expire", requireCronOrAdmin, deliveryController.expireDeliveries);

// ─── Store ────────────────────────────────────────────────────────────────────

router.get("/admin", requireAuth, requireRole("admin"), deliveryController.getAllDeliveries);
router.get(
  "/admin/overview",
  requireAuth,
  requireRole("admin"),
  deliveryController.getDeliveryOverview
);
router.get(
  "/admin/riders",
  requireAuth,
  requireRole("admin"),
  deliveryController.listRiders
);
/** What every delivered job paid the rider, and so what it took from the store. */
router.get(
  "/admin/payouts",
  requireAuth,
  requireRole("admin"),
  deliveryController.getRiderPayouts
);
router.get(
  "/admin/order/:orderId",
  requireAuth,
  requireRole("admin"),
  deliveryController.getOrderDeliveries
);

// ─── Customer tracking ────────────────────────────────────────────────────────

router.get(
  "/tracking/:orderId",
  requireAuth,
  deliveryController.getTracking
);
router.get(
  "/tracking/:orderId/code",
  requireAuth,
  deliveryController.getDeliveryCode
);
router.post(
  "/tracking/:orderId/code",
  requireAuth,
  deliveryController.regenerateDeliveryCode
);

// ─── Store writes ─────────────────────────────────────────────────────────────
// Declared before the rider guard below: `router.use` only protects the routes
// registered after it, and an admin is not a rider.

router.post(
  "/",
  requireAuth,
  requireRole("admin"),
  validate(assignDeliverySchema),
  deliveryController.assignDelivery
);
router.patch(
  "/:id/reassign",
  requireAuth,
  requireRole("admin"),
  validate(reassignDeliverySchema),
  deliveryController.reassignDelivery
);
router.patch(
  "/:id/cancel",
  requireAuth,
  requireRole("admin"),
  validate(cancelDeliverySchema),
  deliveryController.cancelDelivery
);

// ─── Rider ────────────────────────────────────────────────────────────────────

router.use(requireAuth, requireRole("rider"));

router.get("/", deliveryController.getMyDeliveries);
router.get("/stats", deliveryController.getMyStats);
router.get("/:id", deliveryController.getMyDelivery);
router.get("/:id/invoice", deliveryController.getDeliveryInvoice);
router.post("/:id/accept", deliveryController.acceptDelivery);
router.post(
  "/:id/decline",
  validate(declineDeliverySchema),
  deliveryController.declineDelivery
);
router.patch(
  "/:id/status",
  validate(riderStepSchema),
  deliveryController.advanceDelivery
);
router.post(
  "/:id/complete",
  validate(verifyOtpSchema),
  deliveryController.completeDelivery
);
router.post(
  "/:id/location",
  validate(locationSchema),
  deliveryController.shareLocation
);

export default router;
