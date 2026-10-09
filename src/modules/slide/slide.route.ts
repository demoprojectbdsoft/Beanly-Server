import { Router } from "express";
import { validate } from "../../utils/validate";
import { createSlideSchema, updateSlideSchema } from "./slide.validator";
import * as slideController from "./slide.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", slideController.getSlides);
router.post("/", requireAuth, requireRole("admin"), validate(createSlideSchema), slideController.createSlide);
router.patch("/:id", requireAuth, requireRole("admin"), validate(updateSlideSchema), slideController.updateSlide);
router.delete("/:id", requireAuth, requireRole("admin"), slideController.deleteSlide);

export default router;