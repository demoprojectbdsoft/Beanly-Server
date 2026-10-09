import { Router } from "express";
import { validate } from "../../utils/validate";
import { createSubCategorySchema, updateSubCategorySchema } from "./subcategory.validator";
import * as subCategoryController from "./subcategory.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", subCategoryController.getSubCategories);
router.post("/", requireAuth, requireRole("admin"), validate(createSubCategorySchema), subCategoryController.createSubCategory);
router.patch("/:id", requireAuth, requireRole("admin"), validate(updateSubCategorySchema), subCategoryController.updateSubCategory);
router.delete("/:id", requireAuth, requireRole("admin"), subCategoryController.deleteSubCategory);

export default router;