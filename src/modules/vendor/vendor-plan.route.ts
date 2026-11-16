import { Router } from "express";
import { validate } from "../../utils/validate";
import { createPlanSchema, updatePlanSchema } from "./vendor-plan.validator";
import * as controller from "./vendor-plan.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

// Public: the pricing pages and the vendor's plan desk read this.
router.get("/", controller.listPlans);

// The store team owns the price list: it can add, change and remove plans.
router.post(
  "/",
  requireAuth,
  requireRole("admin"),
  validate(createPlanSchema),
  controller.createPlan
);

router.patch(
  "/:planId",
  requireAuth,
  requireRole("admin"),
  validate(updatePlanSchema),
  controller.updatePlan
);

router.delete(
  "/:planId",
  requireAuth,
  requireRole("admin"),
  controller.deletePlan
);

export default router;
