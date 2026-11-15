import { Router } from "express";
import { validate } from "../../utils/validate";
import { createProductSchema, updateProductSchema } from "./product.validator";
import * as productController from "./product.controller";
import { attachUser, requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";
import { requireCronOrAdmin } from "../../middlewares/cron.middleware";

const router = Router();

// Scheduled: a lapsed offer's price becomes the real price. Kept above the
// `/:slug` read so the path is never taken for a product name.
router.get("/expire", requireCronOrAdmin, productController.expireProductOffers);

// The catalogue is public, but `?mode=admin` turns it into the desk response.
// `attachUser` reads the caller when there is one and never blocks the request.
router.get("/", attachUser, productController.getProducts);
router.post("/", requireAuth, requireRole("admin"), validate(createProductSchema), productController.createProduct);
router.get("/:slug", attachUser, productController.getProductBySlug);
router.patch("/:id", requireAuth, requireRole("admin"), validate(updateProductSchema), productController.updateProduct);
router.delete("/:id", requireAuth, requireRole("admin"), productController.deleteProduct);

export default router;