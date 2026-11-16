import { Router } from "express";
import * as transactionController from "./transaction.controller";
import { requireAuth } from "../../middlewares/auth.middleware";
import { requireRole } from "../../middlewares/role.middleware";

const router = Router();

router.use(requireAuth);

router.get("/", transactionController.getTransactions);
// A seller reads the payments for their own rows, resolved from the token.
router.get(
  "/vendor",
  requireRole("vendor"),
  transactionController.getVendorTransactions
);

export default router;