import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import * as planService from "./vendor-plan.service";

/**
 * The plan table: readable by anyone (the pricing cards are public), writable
 * only by the store team.
 */
export const listPlans = catchAsync(async (_req, res) => {
  const plans = await planService.listPlans();
  apiResponse(res, 200, plans, "Plans fetched successfully");
});

export const createPlan = catchAsync(async (req, res) => {
  const plan = await planService.createPlan(req.body, req.user?.id);
  apiResponse(res, 201, plan, "Plan created");
});

export const updatePlan = catchAsync(async (req, res) => {
  const plan = await planService.updatePlan(
    req.params.planId as string,
    req.body,
    req.user?.id
  );
  apiResponse(res, 200, plan, "Plan updated");
});

export const deletePlan = catchAsync(async (req, res) => {
  const result = await planService.deletePlan(req.params.planId as string);
  apiResponse(res, 200, result, "Plan deleted");
});
