import { Router } from "express";
import { validate } from "../../utils/validate";
import { addToCartSchema, updateCartItemSchema } from "./cart.validator";
import * as cartController from "./cart.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.use(requireAuth);

router.get("/", cartController.getCart);
router.get("/is-carted", cartController.isCarted);
router.get("/user/:userId", cartController.getCart);
router.post("/", validate(addToCartSchema), cartController.addToCart);
router.patch("/:productId", validate(updateCartItemSchema), cartController.updateCartItem);
router.delete("/", cartController.clearCart);
router.delete("/:productId", cartController.removeFromCart);

export default router;