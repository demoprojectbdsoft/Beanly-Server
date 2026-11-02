import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ApiError } from "../../utils/apiError";
import { parseQuery } from "../../utils/validate";
import * as riderApplicationService from "./rider-application.service";
import { riderApplicationQuerySchema } from "./rider-application.validator";

/**
 * The applicant's own screens and the store team's review desk.
 *
 * Identity always comes from the token: a body may say what to submit, but
 * never whose application it is. The admin routes rely on `requireRole` in the
 * router, so a customer token cannot reach them at all.
 */

export const submitApplication = catchAsync(async (req, res) => {
  const application = await riderApplicationService.submitApplication(req.user!.id, req.body);
  apiResponse(res, 201, application, "Application submitted");
});

export const getMyApplication = catchAsync(async (req, res) => {
  const application = await riderApplicationService.getMyApplication(req.user!.id);
  apiResponse(res, 200, application, "Application fetched successfully");
});

export const cancelMyApplication = catchAsync(async (req, res) => {
  const application = await riderApplicationService.cancelMyApplication(req.user!.id);
  apiResponse(res, 200, application, "Application withdrawn");
});

/** The rider's own edit of the file the wizard filled in. */
export const updateMyApplication = catchAsync(async (req, res) => {
  const application = await riderApplicationService.updateMyApplication(req.user!.id, req.body);
  apiResponse(res, 200, application, "Profile updated");
});

/**
 * The status of an application whose owner has just proved their password.
 *
 * Only the Next.js auth layer may call this, with the shared internal key.
 */
export const getStatusForVerifiedEmail = catchAsync(async (req, res) => {
  const application = await riderApplicationService.getStatusForVerifiedEmail(req.body.email);
  if (!application) {
    throw new ApiError(404, "No rider application was found for this account");
  }
  apiResponse(res, 200, application, "Application status fetched successfully");
});

export const listApplications = catchAsync(async (req, res) => {
  const query = parseQuery(riderApplicationQuerySchema, req.query);
  const result = await riderApplicationService.listApplications(query);
  apiResponse(res, 200, result, "Applications fetched successfully");
});

export const getApplication = catchAsync(async (req, res) => {
  const result = await riderApplicationService.getApplication(req.params.id as string);
  apiResponse(res, 200, result, "Application fetched successfully");
});

export const reviewApplication = catchAsync(async (req, res) => {
  const result = await riderApplicationService.reviewApplication(
    req.params.id as string,
    req.body,
    req.user!.id
  );
  apiResponse(res, 200, result, "Application reviewed");
});
