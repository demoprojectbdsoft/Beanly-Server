import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { parseQuery } from "../../utils/validate";
import { currentUserId, scopedUserId } from "../../utils/authz";
import * as transactionService from "./transaction.service";
import { getTransactionsQuerySchema } from "./transaction.validator";

export const getTransactions = catchAsync(async (req, res) => {
  const query = parseQuery(getTransactionsQuerySchema, req.query);

  // A customer only ever sees their own payments; an admin may filter freely.
  const result = await transactionService.getTransactions({
    ...query,
    userId: scopedUserId(req.user, query.userId),
  });
  apiResponse(res, 200, result, "Transactions fetched successfully");
});

/** The seller's ledger: only payments for orders they are part of. */
export const getVendorTransactions = catchAsync(async (req, res) => {
  const query = parseQuery(getTransactionsQuerySchema, req.query);
  const result = await transactionService.getVendorTransactions(
    currentUserId(req.user),
    query
  );
  apiResponse(res, 200, result, "Transactions fetched successfully");
});