import { Router } from "express";
import { validate } from "../../utils/validate";
import { createCategorySchema, updateCategorySchema } from "./category.validator";
import * as categoryController from "./category.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", categoryController.getCategories);
router.post("/", requireAuth, requireRole("admin"), validate(createCategorySchema), categoryController.createCategory);
router.patch("/:id", requireAuth, requireRole("admin"), validate(updateCategorySchema), categoryController.updateCategory);
router.delete("/:id", requireAuth, requireRole("admin"), categoryController.deleteCategory);

export default router;