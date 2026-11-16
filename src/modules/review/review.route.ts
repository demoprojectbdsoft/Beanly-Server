import { Router } from "express";
import { validate } from "../../utils/validate";
import { createReviewSchema, updateReviewSchema } from "./review.validator";
import * as reviewController from "./review.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", reviewController.getReviews);
// The seller's feed, resolved from the token; declared before the id routes.
router.get("/vendor", requireAuth, requireRole("vendor"), reviewController.getVendorReviews);
router.post("/", requireAuth, validate(createReviewSchema), reviewController.createReview);
router.patch("/:id", requireAuth, validate(updateReviewSchema), reviewController.updateReview);
router.delete("/:id", requireAuth, reviewController.deleteReview);

export default router;