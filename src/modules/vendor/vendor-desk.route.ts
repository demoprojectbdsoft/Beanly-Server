import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import * as controller from "./vendor-desk.controller";

const router = Router();

/**
 * The store team's view of seller money. Sellers never call this: they read
 * their own figures from /api/vendor-analytics, scoped to their own rows.
 */
router.use(requireAuth, requireRole("admin"));

router.get("/", controller.getVendorDesk);

export default router;
