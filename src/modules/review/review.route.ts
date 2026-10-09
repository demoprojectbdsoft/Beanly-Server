import { Router } from "express";
import { validate } from "../../utils/validate";
import { createReviewSchema, updateReviewSchema } from "./review.validator";
import * as reviewController from "./review.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.get("/", reviewController.getReviews);
router.post("/", requireAuth, validate(createReviewSchema), reviewController.createReview);
router.patch("/:id", requireAuth, validate(updateReviewSchema), reviewController.updateReview);
router.delete("/:id", requireAuth, reviewController.deleteReview);

export default router;