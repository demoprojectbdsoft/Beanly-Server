import { Router } from "express";
import { attachUser, requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import * as controller from "./product-engagement.controller";

const router = Router();

// The desk read sits above `/:productId` so the path is never taken for an id.
router.get("/", requireAuth, requireRole("admin"), controller.getAdminEngagement);

// Public: a visitor looking at a listing is what the counter exists for.
// `attachUser` only lets the API recognise a seller on their own product.
router.post("/:productId", attachUser, controller.trackEngagement);

export default router;
