import { Router } from "express";
import { validate } from "../../utils/validate";
import { addToWishlistSchema } from "./wishlist.validator";
import * as wishlistController from "./wishlist.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.use(requireAuth);

router.get("/is-wishlisted", wishlistController.isWishlisted);
router.get("/", wishlistController.getWishlist);
router.get("/user/:userId", wishlistController.getWishlist);
router.post("/", validate(addToWishlistSchema), wishlistController.addToWishlist);
router.delete("/:productId", wishlistController.removeFromWishlist);

export default router;