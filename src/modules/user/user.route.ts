import { Router } from "express";
import { validate } from "../../utils/validate";
import { updateUserSchema } from "./user.validator";
import * as userController from "./user.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.get("/", requireAuth, requireRole("admin"), userController.getUsers);
router.get("/:id", requireAuth, userController.getUserById);
router.patch("/:id", requireAuth, validate(updateUserSchema), userController.updateUser);
router.delete("/:id", requireAuth, requireRole("admin"), userController.deleteUser);

export default router;