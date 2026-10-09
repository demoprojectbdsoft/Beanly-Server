import { Router } from "express";
import * as orderStatusController from "./order-status.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.get("/", requireAuth, orderStatusController.getOrderStatusHistory);

export default router;