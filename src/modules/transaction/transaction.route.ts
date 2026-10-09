import { Router } from "express";
import * as transactionController from "./transaction.controller";
import { requireAuth } from "../../middlewares/auth.middleware";

const router = Router();

router.use(requireAuth);

router.get("/", transactionController.getTransactions);

export default router;