import { catchAsync } from "../../utils/catchAsync";
import { apiResponse } from "../../utils/apiResponse";
import { parseQuery } from "../../utils/validate";
import { currentUserId } from "../../utils/authz";
import { ApiError } from "../../utils/apiError";
import * as deliveryService from "./delivery.service";
import * as deliveryTracking from "./delivery.tracking";
import { ensureOtp, getCustomerOtp } from "./delivery.otp";
import {
  adminDeliveryQuerySchema,
  adminPayoutsQuerySchema,
  getRiderDeliveriesQuerySchema,
  riderStatsQuerySchema,
} from "./delivery.validator";

/**
 * The delivery endpoints.
 *
 * Three audiences, three shapes of route:
 * - `/` and `/stats` are the rider's own work, always scoped to the token.
 * - `/admin/...` is the store's board, behind an admin check at the route.
 * - `/tracking/:orderId` is the buyer (or the store) watching one parcel.
 */

// ─── Rider ────────────────────────────────────────────────────────────────────

export const getMyStats = catchAsync(async (req, res) => {
  const { days } = parseQuery(riderStatsQuerySchema, req.query);
  const result = await deliveryService.getRiderStats(currentUserId(req.user), { days });
  apiResponse(res, 200, result, "Rider statistics fetched successfully");
});

export const getMyDeliveries = catchAsync(async (req, res) => {
  const query = parseQuery(getRiderDeliveriesQuerySchema, req.query);
  const result = await deliveryService.getRiderDeliveries(currentUserId(req.user), query);
  apiResponse(res, 200, result, "Deliveries fetched successfully");
});

export const getMyDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.getRiderDelivery(
    currentUserId(req.user),
    String(req.params.id)
  );
  apiResponse(res, 200, delivery, "Delivery fetched successfully");
});

/** The figures the rider's invoice PDF prints, for their own job only. */
export const getDeliveryInvoice = catchAsync(async (req, res) => {
  const invoice = await deliveryService.getRiderInvoice(
    currentUserId(req.user),
    String(req.params.id)
  );
  apiResponse(res, 200, invoice, "Invoice fetched successfully");
});

export const acceptDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.acceptDelivery(
    currentUserId(req.user),
    String(req.params.id)
  );
  apiResponse(res, 200, delivery, "Delivery accepted");
});

export const declineDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.declineDelivery(
    currentUserId(req.user),
    String(req.params.id),
    req.body
  );
  apiResponse(res, 200, delivery, "Delivery declined");
});

export const advanceDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.advanceDelivery(
    currentUserId(req.user),
    String(req.params.id),
    req.body
  );
  apiResponse(res, 200, delivery, "Delivery updated");
});

export const completeDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.completeDelivery(
    currentUserId(req.user),
    String(req.params.id),
    String(req.body.code)
  );
  apiResponse(res, 200, delivery, "Delivery completed. The order is marked delivered.");
});

export const shareLocation = catchAsync(async (req, res) => {
  const result = await deliveryTracking.saveLocation(
    currentUserId(req.user),
    String(req.params.id),
    req.body
  );
  apiResponse(res, 200, result, "Location saved");
});

// ─── Store ────────────────────────────────────────────────────────────────────

export const listRiders = catchAsync(async (req, res) => {
  const orderId = typeof req.query.orderId === "string" ? req.query.orderId : undefined;
  const result = await deliveryService.listAssignableRiders(orderId);
  apiResponse(res, 200, result, "Riders fetched successfully");
});

export const assignDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.assignDelivery(req.body, req.user?.id);
  apiResponse(res, 201, delivery, "Delivery assigned to the rider");
});

export const reassignDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.reassignDelivery(
    String(req.params.id),
    req.body,
    req.user?.id
  );
  apiResponse(res, 200, delivery, "Delivery reassigned");
});

export const cancelDelivery = catchAsync(async (req, res) => {
  const delivery = await deliveryService.cancelDeliveryByAdmin(
    String(req.params.id),
    req.body?.reason,
    req.user?.id
  );
  apiResponse(res, 200, delivery, "Delivery cancelled");
});

export const getAllDeliveries = catchAsync(async (req, res) => {
  const query = parseQuery(adminDeliveryQuerySchema, req.query);
  const result = await deliveryService.getAdminDeliveries(query);
  apiResponse(res, 200, result, "Deliveries fetched successfully");
});

export const getDeliveryOverview = catchAsync(async (_req, res) => {
  const result = await deliveryService.getAdminDeliveryOverview();
  apiResponse(res, 200, result, "Delivery overview fetched successfully");
});

/**
 * The payout record: every fee a delivered job paid to a rider, folded into a
 * graph and listed row by row. The store reads its own profit out of it, so it
 * is an admin route and it never takes a rider id from the caller as a favour.
 */
export const getRiderPayouts = catchAsync(async (req, res) => {
  const query = parseQuery(adminPayoutsQuerySchema, req.query);
  const result = await deliveryService.getAdminPayouts(query);
  apiResponse(res, 200, result, "Rider payouts fetched successfully");
});

export const getOrderDeliveries = catchAsync(async (req, res) => {
  const result = await deliveryService.getOrderDeliveries(String(req.params.orderId));
  apiResponse(res, 200, result, "Order deliveries fetched successfully");
});

/**
 * The scheduled sweep that closes offers nobody answered. A guarded admin call
 * and a cron call both land here, which is the same pattern the warranty expiry
 * job uses.
 */
export const expireDeliveries = catchAsync(async (_req, res) => {
  const result = await deliveryService.expireStaleDeliveries();
  apiResponse(res, 200, result, `Expired ${result.expired} delivery request(s)`);
});

// ─── Customer tracking ────────────────────────────────────────────────────────

export const getTracking = catchAsync(async (req, res) => {
  const result = await deliveryTracking.getTracking(String(req.params.orderId), req.user);
  apiResponse(res, 200, result, "Tracking fetched successfully");
});

/** The buyer's own code, on its own route so it never rides along in a list. */
export const getDeliveryCode = catchAsync(async (req, res) => {
  const orderId = String(req.params.orderId);
  await deliveryTracking.assertCanReadCode(orderId, req.user);

  const delivery = await deliveryService.getLiveDeliveryForOrder(orderId);
  if (!delivery) throw new ApiError(404, "This order has no active delivery");

  // Opening the tracking page is what issues the code, so a customer never has
  // to ask for one before the rider arrives.
  await ensureOtp(delivery._id);
  const code = await getCustomerOtp(String(delivery._id));
  apiResponse(res, 200, code, "Delivery code fetched successfully");
});

export const regenerateDeliveryCode = catchAsync(async (req, res) => {
  const orderId = String(req.params.orderId);
  await deliveryTracking.assertCanReadCode(orderId, req.user);

  const delivery = await deliveryService.getLiveDeliveryForOrder(orderId);
  if (!delivery) throw new ApiError(404, "This order has no active delivery");

  await deliveryService.regenerateOtpForDelivery(String(delivery._id));
  const code = await getCustomerOtp(String(delivery._id));
  apiResponse(res, 200, code, "A new delivery code was generated");
});
