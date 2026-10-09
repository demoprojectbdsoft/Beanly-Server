import { Router } from "express";
import { validate } from "../../utils/validate";
import { createProductSchema, updateProductSchema } from "./product.validator";
import * as productController from "./product.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", productController.getProducts);
router.post("/", requireAuth, requireRole("admin"), validate(createProductSchema), productController.createProduct);
router.get("/:slug", productController.getProductBySlug);
router.patch("/:id", requireAuth, requireRole("admin"), validate(updateProductSchema), productController.updateProduct);
router.delete("/:id", requireAuth, requireRole("admin"), productController.deleteProduct);

export default router;