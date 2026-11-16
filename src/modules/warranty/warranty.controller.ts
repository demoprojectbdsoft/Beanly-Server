import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { ApiError } from "../../utils/apiError";
import { parseQuery } from "../../utils/validate";
import { hasAnyRole, isAdminRole } from "../../utils/roles";
import { Product } from "../product/product.model";
import * as warrantyService from "./warranty.service";
import {
  submitWarrantyClaimSchema,
  adminUpdateClaimSchema,
  emailWarrantySchema,
  extendWarrantySchema,
  getWarrantiesQuerySchema,
} from "./warranty.validator";

/**
 * Customer: submit a claim for one of their own warranties.
 * The caller's identity is taken from the auth token, never the request body.
 */
export const submitClaim = catchAsync(async (req, res, next) => {
  if (!req.user?.id) {
    return next(new ApiError(401, "Authentication required"));
  }
  const parsed = submitWarrantyClaimSchema.safeParse({
    ...req.body,
    warrantyId: req.params.id,
  });
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }
  const warranty = await warrantyService.submitClaim(
    req.params.id as string,
    parsed.data,
    req.user.id
  );
  apiResponse(res, 200, warranty, "Warranty claim submitted");
});

/**
 * Customer: list their own warranties.
 */
export const getMyWarranties = catchAsync(async (req, res, next) => {
  if (!req.user?.id) {
    return next(new ApiError(401, "Authentication required"));
  }
  const query = parseQuery(getWarrantiesQuerySchema, {
    ...req.query,
    userId: req.user.id,
  });
  const result = await warrantyService.getWarranties(query);
  apiResponse(res, 200, result, "Warranties fetched successfully");
});

/**
 * Customer: fetch the warranty record for a single order item.
 * Used by the order history "Claim" button to open the warranty detail modal.
 * Returns null when no warranty exists for this (user, order, product) triple.
 */
export const getWarrantyForOrderItem = catchAsync(async (req, res, next) => {
  if (!req.user?.id) {
    return next(new ApiError(401, "Authentication required"));
  }
  const orderId = Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId;
  const productId = Array.isArray(req.params?.productId) ? req.params?.productId[0] : req.params?.productId;
  const warranty = await warrantyService.getWarrantyForOrderItem(
    orderId,
    productId,
    req.user.id
  );
  apiResponse(res, 200, warranty, "Warranty fetched successfully");
});

/**
 * Admin: list all warranties (optionally filtered).
 */
export const getAllWarranties = catchAsync(async (req, res) => {
  const query = parseQuery(getWarrantiesQuerySchema, req.query);
  const result = await warrantyService.getWarranties(query);
  apiResponse(res, 200, result, "Warranties fetched successfully");
});

/**
 * The seller whose listings the caller may touch, or undefined for the store
 * team. An admin keeps every listing; a vendor is pinned to their own id, which
 * the service then checks against the warranty's product.
 */
function vendorScope(user: { id?: string; role?: string; roles?: string[] } | undefined) {
  if (!user?.id || isAdminRole(user.role)) return undefined;
  return hasAnyRole(user.roles, ["vendor"], user.role) ? user.id : undefined;
}

/**
 * Vendor: list the warranties issued on their own products.
 *
 * The product ids are resolved here from the caller's id rather than read from
 * the query, so the scope cannot be widened by editing the URL.
 */
export const getVendorWarranties = catchAsync(async (req, res, next) => {
  if (!req.user?.id) {
    return next(new ApiError(401, "Authentication required"));
  }
  const productIds = await Product.find({ vendorId: req.user.id }).distinct("_id");
  const query = parseQuery(getWarrantiesQuerySchema, req.query);
  const result = await warrantyService.getWarranties({
    ...query,
    productIds: productIds.map(String),
  });
  apiResponse(res, 200, result, "Warranties fetched successfully");
});

/**
 * Admin: process a claim — mark under review, request info, resolve, or reject.
 */
export const adminUpdateClaim = catchAsync(async (req, res, next) => {
  const parsed = adminUpdateClaimSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }
  const warranty = await warrantyService.adminUpdateClaim(
    req.params.id as string,
    parsed.data,
    vendorScope(req.user)
  );
  apiResponse(res, 200, warranty, "Claim updated");
});

/**
 * Scheduled: close every warranty whose expiry date has passed.
 * Vercel Cron calls this once a day, because a serverless host has no process
 * that could keep the in-process scheduler alive.
 */
export const expireWarranties = catchAsync(async (_req, res) => {
  const expired = await warrantyService.expireStaleWarranties();
  apiResponse(res, 200, { expired }, "Lapsed warranties expired");
});

/**
 * Admin: email the customer about this warranty. The admin writes the subject
 * and message in the dashboard, and the server picks the address.
 */
export const emailCustomer = catchAsync(async (req, res, next) => {
  const parsed = emailWarrantySchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }

  const result = await warrantyService.emailWarrantyCustomer(
    req.params.id as string,
    parsed.data,
    vendorScope(req.user)
  );
  apiResponse(res, 200, result, `Email sent to ${result.to}`);
});

/**
 * Admin: add months to a warranty. The reason is required, and the admin's own
 * email is stored with the extension so the history says who granted it.
 */
export const extendWarranty = catchAsync(async (req, res, next) => {
  const parsed = extendWarrantySchema.safeParse(req.body);
  if (!parsed.success) {
    return next(new ApiError(400, parsed.error.issues[0].message));
  }

  const warranty = await warrantyService.extendWarranty(
    req.params.id as string,
    parsed.data,
    { email: req.user?.email },
    vendorScope(req.user)
  );
  apiResponse(res, 200, warranty, "Warranty extended");
});