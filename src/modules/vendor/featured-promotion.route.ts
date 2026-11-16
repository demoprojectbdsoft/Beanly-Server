import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { requireCronOrAdmin } from "../../middlewares/cron.middleware";
import { validate } from "../../utils/validate";
import { endPromotionSchema, grantPromotionSchema } from "./featured-promotion.validator";
import * as controller from "./featured-promotion.controller";

const router = Router();

/**
 * The store team's promotions board.
 *
 * The sweep is kept above the admin block so Vercel Cron, which carries no user
 * token, can reach it — the same shape the delivery and vendor period desks use.
 */
router.get("/expire", requireCronOrAdmin, controller.expirePromotions);

router.use(requireAuth, requireRole("admin"));

router.get("/", controller.getPromotions);
router.post("/", validate(grantPromotionSchema), controller.grantPromotion);

/**
 * Ends a placement early with the reason the seller will read.
 *
 * There is no delete here on purpose: a row that has been on the shelf is part
 * of what the shop's desk can account for, so it closes rather than vanishes.
 */
router.delete("/:id", validate(endPromotionSchema), controller.revokePromotion);

export default router;
