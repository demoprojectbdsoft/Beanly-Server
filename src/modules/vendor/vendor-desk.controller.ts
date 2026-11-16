import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import * as vendorDeskService from "./vendor-desk.service";

/**
 * Admin: what the marketplace earns from its sellers — subscription income,
 * commission on their sales, and the size of those sales per month.
 */
export const getVendorDesk = catchAsync(async (req, res) => {
  const months = Number(req.query.months);
  const report = await vendorDeskService.getVendorDeskReport({
    months: Number.isFinite(months) ? months : undefined,
  });
  apiResponse(res, 200, report, "Vendor earnings fetched successfully");
});
