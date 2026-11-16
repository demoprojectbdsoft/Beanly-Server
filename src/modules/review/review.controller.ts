import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { parseQuery } from "../../utils/validate";
import { currentUserId } from "../../utils/authz";
import * as reviewService from "./review.service";
import { getReviewsQuerySchema } from "./review.validator";

export const createReview = catchAsync(async (req, res) => {
  const review = await reviewService.createReview(req.body, currentUserId(req.user));
  apiResponse(res, 201, review, "Review added");
});

export const getReviews = catchAsync(async (req, res) => {
  const query = parseQuery(getReviewsQuerySchema, req.query);
  const result = await reviewService.getReviews(query);
  apiResponse(res, 200, result, "Reviews fetched successfully");
});

/** A seller's own board: the feed, but only for the listings they own. */
export const getVendorReviews = catchAsync(async (req, res) => {
  const query = parseQuery(getReviewsQuerySchema, req.query);
  const result = await reviewService.getVendorReviews(currentUserId(req.user), query);
  apiResponse(res, 200, result, "Reviews fetched successfully");
});

export const updateReview = catchAsync(async (req, res) => {
  const review = await reviewService.updateReview(
    req.params.id as string,
    req.body,
    req.user?.id,
    req.user?.role
  );
  apiResponse(res, 200, review, "Review updated");
});

export const deleteReview = catchAsync(async (req, res) => {
  await reviewService.deleteReview(req.params.id as string, req.user);
  apiResponse(res, 200, null, "Review deleted");
});