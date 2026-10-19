import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import * as demoService from "./demo.service";

export const restoreDemoChanges = catchAsync(async (_req, res) => {
  const result = await demoService.restoreDemoChanges();
  apiResponse(res, 200, result, "Demo changes reverted");
});