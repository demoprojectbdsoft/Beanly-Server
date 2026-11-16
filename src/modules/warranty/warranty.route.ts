import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { requireCronOrAdmin } from "../../middlewares/cron.middleware";
import * as warrantyController from "./warranty.controller";

const router = Router();

// Customer: list their own warranties
router.get("/mine", requireAuth, warrantyController.getMyWarranties);
// Customer: fetch the warranty record for one order item (used by the order history "Claim" button)
router.get("/order/:orderId/product/:productId", requireAuth, warrantyController.getWarrantyForOrderItem);
// Customer: submit a claim for one of their own active warranties
router.post("/claim/:id", requireAuth, warrantyController.submitClaim);

// Scheduled: close lapsed warranties. Called by Vercel Cron, and callable by
// an admin by hand. Kept above the "/" and "/claim/:id" routes so the method and
// path pairs never overlap with the customer endpoints.
router.get("/expire", requireCronOrAdmin, warrantyController.expireWarranties);

// Vendor: the warranties issued on this seller's own products. Scoped by the
// caller's id inside the controller, so the list cannot be widened by a query.
// Kept above "/" so it is never shadowed by the admin list.
router.get("/vendor", requireAuth, requireRole("vendor"), warrantyController.getVendorWarranties);

// Admin: list all warranties
router.get("/", requireAuth, requireRole("admin"), warrantyController.getAllWarranties);
// Admin and vendor: process a claim. A vendor may only move a claim on one of
// their own products; the service checks the product's owner.
router.patch("/claim/:id", requireAuth, requireRole("admin", "vendor"), warrantyController.adminUpdateClaim);
// Admin and vendor: email the customer about this warranty
router.post("/email/:id", requireAuth, requireRole("admin", "vendor"), warrantyController.emailCustomer);
// Admin and vendor: add months to this warranty (the reason is required and kept)
router.patch("/:id/extend", requireAuth, requireRole("admin", "vendor"), warrantyController.extendWarranty);

export default router;
