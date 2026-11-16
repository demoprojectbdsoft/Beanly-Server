import { Types } from "mongoose";
import { Delivery, ACTIVE_DELIVERY_STATUSES, DeliveryStatus } from "./delivery.model";
import { RiderLocation, TRAIL_LIMIT } from "./delivery.location.model";
import { Order } from "../order/order.model";
import { ApiError } from "../../utils/apiError";
import { assertOwnerOrAdmin } from "../../utils/authz";
import { isAdminRole } from "../../utils/roles";
import { refIdString } from "../../utils/ids";
import { VendorOrder } from "../vendor/vendor-order.model";
import { getCustomerOtp } from "./delivery.otp";
import { etaFrom, latestLocation, shortOrderNumber, toDto } from "./delivery.service";
import { LocationInput } from "./delivery.validator";

type Requester = { id?: string; role?: string } | undefined;

/** Metres between two coordinates (haversine). */
function metresBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** How much of the recorded route the rider has already covered, 0–1. */
function trailProgress(trail: { lat: number; lng: number }[], distanceKm: number | null) {
  if (!distanceKm || distanceKm <= 0 || trail.length < 2) return 0;
  let metres = 0;
  for (let i = 1; i < trail.length; i++) metres += metresBetween(trail[i - 1], trail[i]);
  return Math.min(1, metres / (distanceKm * 1000));
}

/**
 * Records one position ping.
 *
 * Only the rider carrying an accepted job may report, and only while the job is
 * live: a finished delivery stops collecting location data the moment it ends.
 */
export async function saveLocation(riderId: string, deliveryId: string, input: LocationInput) {
  if (!Types.ObjectId.isValid(deliveryId)) throw new ApiError(404, "Delivery not found");

  const delivery = await Delivery.findOne({
    _id: new Types.ObjectId(deliveryId),
    riderId: new Types.ObjectId(riderId),
  })
    .select("status")
    .lean();

  if (!delivery) throw new ApiError(404, "Delivery not found");
  if (!ACTIVE_DELIVERY_STATUSES.includes(delivery.status as DeliveryStatus)) {
    throw new ApiError(400, "Location is shared only while the delivery is active");
  }

  const point = {
    lat: input.lat,
    lng: input.lng,
    at: new Date(),
  };

  const saved = await RiderLocation.findOneAndUpdate(
    { deliveryId: new Types.ObjectId(deliveryId) },
    {
      $set: {
        riderId: new Types.ObjectId(riderId),
        lat: input.lat,
        lng: input.lng,
        accuracy: input.accuracy ?? null,
        heading: input.heading ?? null,
        speed: input.speed ?? null,
      },
      $push: { trail: { $each: [point], $slice: -TRAIL_LIMIT } },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();

  return {
    saved: true,
    updatedAt: new Date(saved!.updatedAt).toISOString(),
  };
}

/**
 * The tracking page's one read.
 *
 * Everything the customer's screen needs arrives in a single call, so the 8
 * second refresh is one request: the stage, the rider, the newest position, the
 * short trail, an ETA, and the code they will read at the door.
 */
export async function getTracking(orderId: string, requester: Requester) {
  if (!Types.ObjectId.isValid(orderId)) throw new ApiError(404, "Order not found");

  const order = await Order.findById(orderId)
    .select("userId orderStatus shippingAddress estimatedDelivery shippingMethod totalAmount createdAt")
    .lean();
  if (!order) throw new ApiError(404, "Order not found");

  /*
   * The buyer watches their own parcel, and a seller watches the parcel they
   * accepted — saying yes is the whole of their job, so from then on they only
   * follow it. The door code is never theirs: that is the buyer's proof of
   * handover, so it stays behind the owner check below.
   */
  const isOwner =
    isAdminRole(requester?.role) ||
    (Boolean(requester?.id) && refIdString(order.userId) === requester!.id);

  if (!isOwner) {
    const sellsIt = requester?.id
      ? await VendorOrder.exists({ orderId: order._id, vendorId: requester.id })
      : null;
    if (!sellsIt) throw new ApiError(403, "You are not allowed to track this order");
  }

  // The newest row wins: a reassigned order keeps the earlier attempts for the
  // history but only the current one is on the road.
  const delivery = await Delivery.findOne({ orderId: new Types.ObjectId(orderId) })
    .populate("riderId", "name phone image vehicleType vehicleNumber")
    .sort({ createdAt: -1 });

  if (!delivery) {
    return {
      order: {
        _id: String(order._id),
        orderNumber: shortOrderNumber(order._id),
        status: order.orderStatus,
        estimatedDelivery: order.estimatedDelivery || "",
        shippingMethod: order.shippingMethod || "standard",
        address: order.shippingAddress?.address || "",
        city: order.shippingAddress?.city || "",
        createdAt: new Date(order.createdAt).toISOString(),
      },
      delivery: null,
      location: null,
      eta: null,
      otp: null,
      isOwner: true,
      serverTime: new Date().toISOString(),
    };
  }

  /*
   * The customer's map, and the clock behind it.
   *
   * A position is only handed over once the rider has started the delivery. The
   * phone may already be reporting — the watch starts at pickup so the trail
   * begins at the store door — but until the ride starts those pings are a
   * person standing still, and a dot parked outside the shop reads as a
   * delivery that has stalled. The arrival estimate sits behind the same gate:
   * it is measured from the rider's own position, so before the ride starts it
   * would be a guess dressed up as a number.
   */
  const isOnTheRoad = delivery.status === "out_for_delivery";
  const stored = isOnTheRoad ? await latestLocation(String(delivery._id)) : null;

  // Only the road counts towards progress. Pings recorded while the rider was
  // still at the store are GPS jitter around one spot, and summing them would
  // show a parcel that has not left the shop as already part-way to the door.
  const startedAt = delivery.outForDeliveryAt
    ? new Date(delivery.outForDeliveryAt).getTime()
    : null;
  const trail = (stored?.trail || []).filter(
    (point) => startedAt === null || !point.at || new Date(point.at).getTime() >= startedAt
  );
  const location = stored ? { ...stored, trail } : null;

  const progress = trailProgress(trail, delivery.distanceKm ?? null);

  // The code is only useful while the parcel is on its way, and only to the
  // buyer: once the job is closed there is nothing left to read at the door.
  const isLive = !["delivered", "cancelled", "declined"].includes(delivery.status as string);
  const otp = isLive && isOwner ? await getCustomerOtp(String(delivery._id)) : null;

  return {
    order: {
      _id: String(order._id),
      orderNumber: shortOrderNumber(order._id),
      status: order.orderStatus,
      estimatedDelivery: order.estimatedDelivery || "",
      shippingMethod: order.shippingMethod || "standard",
      address: order.shippingAddress?.address || "",
      city: order.shippingAddress?.city || "",
      createdAt: new Date(order.createdAt).toISOString(),
    },
    delivery: toDto(delivery),
    location,
    eta: isOnTheRoad
      ? etaFrom(delivery.distanceKm ?? null, location?.speed ?? null, progress)
      : null,
    otp: otp ? { ...otp, progress } : null,
    isOwner,
    serverTime: new Date().toISOString(),
  };
}

/**
 * Checks that the caller may see this order's code.
 *
 * The code is the only secret in the flow, so it is handed out on its own call
 * and only to the buyer (or the store team), never inside a delivery row.
 */
export async function assertCanReadCode(orderId: string, requester: Requester) {
  if (!Types.ObjectId.isValid(orderId)) throw new ApiError(404, "Order not found");
  const order = await Order.findById(orderId).select("userId").lean();
  if (!order) throw new ApiError(404, "Order not found");
  assertOwnerOrAdmin(order.userId, requester, "You are not allowed to see this code");
  return order;
}
