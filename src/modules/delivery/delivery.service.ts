import { Types } from "mongoose";
import {
  Delivery,
  ACTIVE_DELIVERY_STATUSES,
  FINISHED_DELIVERY_STATUSES,
  LIVE_DELIVERY_STATUSES,
  DeliveryStatus,
} from "./delivery.model";
import { RiderLocation } from "./delivery.location.model";
import { User } from "../user/user.model";
import { Order } from "../order/order.model";
import { SiteSettings } from "../site-settings/site-settings.model";
import { ApiError } from "../../utils/apiError";
import { hasAnyRole, normalizeRole } from "../../utils/roles";
import { updateOrderStatus } from "../order/order.service";
import { syncVendorOrdersForDelivery } from "../vendor/vendor-order.create";
import { recordActivity, notifyUser } from "../activity/activity.service";
import {
  notifyAdminDeliveryEmail,
  notifyCustomerDelivery,
  notifyRiderAssigned,
} from "../activity/activity.notifications";
import { nextDeliveryStatuses, nextRiderStep, isLapsedOffer } from "./delivery.flow";
import { ensureOtp, markOtpUsed, verifyOtpCode } from "./delivery.otp";
import {
  AdminDeliveryQuery,
  AdminPayoutsQuery,
  AssignDeliveryInput,
  DeclineDeliveryInput,
  GetRiderDeliveriesQuery,
  ReassignDeliveryInput,
  RiderStatsQuery,
  RiderStepInput,
} from "./delivery.validator";

/**
 * The delivery domain.
 *
 * Every rider-facing query starts from the caller's own id, never from a value
 * in the request, so one rider can never read or change another rider's work.
 * Every store-facing query is behind an admin check at the route.
 */

/** How long a rider has to answer a new request before it goes stale. */
const REQUEST_WINDOW_MINUTES = 30;
/** What a job pays when the order did not charge for shipping at all. */
const DEFAULT_DELIVERY_FEE = 5;
/** City riding speed, used for an ETA when the phone reports no speed. */
const FALLBACK_SPEED_KMH = 22;

/** "#ORD-A1B2C3" — the short form the dashboards show. */
export function shortOrderNumber(id: unknown): string {
  return `#ORD-${String(id).slice(-6).toUpperCase()}`;
}

function money(amount?: number | null): string {
  return typeof amount === "number" ? `$${amount.toFixed(2)}` : "";
}

/** The rider document on a populated delivery, if there is one. */
function riderOf(delivery: any) {
  const rider = delivery?.riderId;
  if (!rider || typeof rider !== "object" || !("_id" in rider)) return null;
  return {
    _id: String(rider._id),
    name: rider.name || "",
    phone: rider.phone || "",
    image: rider.image || "",
    vehicleType: rider.vehicleType || "",
    vehicleNumber: rider.vehicleNumber || "",
  };
}

/** A delivery as the app reads it: ids as strings, dates as ISO strings. */
export function toDto(delivery: any) {
  return {
    _id: String(delivery._id),
    orderId: String(delivery.orderId),
    orderNumber: shortOrderNumber(delivery.orderId),
    status: delivery.status as DeliveryStatus,
    customerName: delivery.customerName || "",
    customerPhone: delivery.customerPhone || "",
    address: delivery.address || "",
    city: delivery.city || "",
    items: Number(delivery.items || 0),
    orderTotal: Number(delivery.orderTotal || 0),
    fee: Number(delivery.fee || 0),
    // How a delivered job was paid out: the rider's code, or the customer's own
    // confirmation. Empty on a job that never reached the door.
    feePaidVia: delivery.feePaidVia || "",
    distanceKm: delivery.distanceKm ?? null,
    declineReason: delivery.declineReason || "",
    expiresAt: delivery.expiresAt ? new Date(delivery.expiresAt).toISOString() : null,
    acceptedAt: delivery.acceptedAt ? new Date(delivery.acceptedAt).toISOString() : null,
    pickedUpAt: delivery.pickedUpAt ? new Date(delivery.pickedUpAt).toISOString() : null,
    outForDeliveryAt: delivery.outForDeliveryAt
      ? new Date(delivery.outForDeliveryAt).toISOString()
      : null,
    deliveredAt: delivery.deliveredAt ? new Date(delivery.deliveredAt).toISOString() : null,
    cancelledAt: delivery.cancelledAt ? new Date(delivery.cancelledAt).toISOString() : null,
    createdAt: new Date(delivery.createdAt).toISOString(),
    updatedAt: new Date(delivery.updatedAt).toISOString(),
    rider: riderOf(delivery),
    history: (delivery.history || []).map((event: any) => ({
      status: event.status as DeliveryStatus,
      at: event.at ? new Date(event.at).toISOString() : null,
      note: event.note || "",
    })),
  };
}

/** Midnight-to-midnight key for the day a moment belongs to. */
function dayKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

/** The last `days` day keys, oldest first, so a quiet day is still a point. */
function recentDayKeys(days: number): string[] {
  const now = new Date();
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    keys.push(dayKey(d));
  }
  return keys;
}

/** Minutes between two moments, or null when either is missing. */
function minutesBetween(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  const diff = to.getTime() - from.getTime();
  return diff >= 0 ? diff / 60_000 : null;
}

/** Loads a delivery or throws the message the caller can act on. */
async function requireDelivery(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Delivery not found");
  const delivery = await Delivery.findById(id).populate(
    "riderId",
    "name phone vehicleType vehicleNumber availability"
  );
  if (!delivery) throw new ApiError(404, "Delivery not found");
  return delivery;
}

/** Loads a delivery that must belong to this rider. */
async function requireRiderDelivery(riderId: string, id: string) {
  const delivery = await requireDelivery(id);
  if (String(delivery.riderId?._id ?? delivery.riderId) !== riderId) {
    // 404 rather than 403: another rider's job is not this rider's business.
    throw new ApiError(404, "Delivery not found");
  }
  return delivery;
}

/** What a job pays: the shipping the customer paid, or a flat default. */
function feeFor(order: any): number {
  const shipping = Number(order?.shippingFee || 0);
  return shipping > 0 ? shipping : DEFAULT_DELIVERY_FEE;
}

/**
 * How much of the answer window is left, for a message the store can act on.
 */
function minutesLeft(expiresAt: any): number {
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 60_000));
}

/**
 * Closes a request nobody answered, so the order is free for the next rider.
 *
 * The condition re-reads the row: if the rider accepted in the moment between
 * the read and this write, nothing matches and an accepted job is left alone.
 */
async function closeLapsedOffer(deliveryId: string, adminId?: string) {
  const now = new Date();
  await Delivery.updateOne(
    { _id: deliveryId, status: "assigned", expiresAt: { $lte: now } },
    {
      $set: { status: "cancelled", cancelledAt: now },
      $push: {
        history: {
          status: "cancelled",
          at: now,
          note: "Request expired without an answer",
          by: adminId ?? null,
        },
      },
    }
  );
}

/**
 * Every account approved to ride.
 *
 * `role` is only the mirror of the dashboard the person is looking at right
 * now, so a `{ role: "rider" }` query hides a rider who happens to be shopping
 * as a customer, or who has not opened the rider workspace since approval. The
 * authority lives in `roles`.
 *
 * The second branch is the safety net for a row the role migration never
 * reached. It asks for `role` on its own rather than for an empty `roles`,
 * because `$size` only matches documents that actually hold an array — a row
 * from before the field exists has no `roles` at all, and a `$size: 0` clause
 * would walk straight past it. Nothing over-matches: `role` is only ever the
 * mirror of a dashboard the account was granted.
 */
function riderAccountsFilter() {
  return { $or: [{ roles: "rider" }, { role: "rider" }] };
}

/** Whether the rider's delivery access is parked by the store team. */
function isRiderAccessParked(user: any): boolean {
  const rows = Array.isArray(user?.roleSuspensions) ? user.roleSuspensions : [];
  return rows.some((row: any) => normalizeRole(row?.role) === "rider");
}

/**
 * The account behind a rider the store wants to hand a job to.
 *
 * Both store writes go through here so the answer cannot drift: the same three
 * reasons the picker would refuse somebody are the three reasons the API will.
 */
async function requireRiderAccount(riderId: string) {
  const rider: any = await User.findById(riderId)
    .select("name role roles status roleSuspensions")
    .lean();
  if (!rider || !hasAnyRole(rider.roles, ["rider"], rider.role)) {
    throw new ApiError(400, "That account is not a rider");
  }
  if (rider.status === "suspended") {
    throw new ApiError(400, "That rider's account is suspended and cannot take deliveries");
  }
  // A parked rider keeps the role but loses the workspace, so an offer they can
  // never open would only strand the parcel.
  if (isRiderAccessParked(rider)) {
    throw new ApiError(400, "That rider's delivery access is parked by the store");
  }
  return rider;
}

// ─── Rider overview ───────────────────────────────────────────────────────────

/**
 * The overview numbers.
 *
 * A rider's job count is small enough to fold in one pass rather than in a
 * dozen round trips, and one pass keeps every figure consistent with the others.
 */
export async function getRiderStats(riderId: string, query: RiderStatsQuery) {
  const days = query.days;
  const rider = new Types.ObjectId(riderId);

  // One read of the rider's jobs, oldest first: totals, the chart series and the
  // delivery-time average all come from the same snapshot.
  const deliveries = await Delivery.find({ riderId: rider }).sort({ createdAt: 1 }).lean();

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dayKeys = recentDayKeys(days);
  const daySeries = new Map(dayKeys.map((key) => [key, { delivered: 0, earnings: 0, cancelled: 0 }]));

  const statusCounts: Record<string, number> = {
    assigned: 0,
    accepted: 0,
    picked_up: 0,
    out_for_delivery: 0,
    delivered: 0,
    cancelled: 0,
    declined: 0,
  };

  let earnings = 0;
  let earningsThisMonth = 0;
  let earningsInWindow = 0;
  let activeCount = 0;
  let pendingRequests = 0;
  let completed = 0;
  let cancelled = 0;
  let deliveryMinutes = 0;
  let deliverySamples = 0;

  for (const delivery of deliveries) {
    const status = delivery.status as DeliveryStatus;
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (ACTIVE_DELIVERY_STATUSES.includes(status)) activeCount++;
    if (status === "assigned") {
      // A request past its expiry is no longer a job the rider can take.
      const expired = delivery.expiresAt && new Date(delivery.expiresAt).getTime() < now.getTime();
      if (!expired) pendingRequests++;
    }

    if (status === "delivered") {
      completed++;
      const fee = Number(delivery.fee || 0);
      const deliveredAt = delivery.deliveredAt ? new Date(delivery.deliveredAt) : null;

      earnings += fee;
      if (deliveredAt && deliveredAt >= monthStart) earningsThisMonth += fee;

      const key = deliveredAt ? dayKey(deliveredAt) : "";
      const bucket = daySeries.get(key);
      if (bucket) {
        bucket.delivered += 1;
        bucket.earnings += fee;
        earningsInWindow += fee;
      }

      const minutes = minutesBetween(
        delivery.acceptedAt ? new Date(delivery.acceptedAt) : null,
        deliveredAt
      );
      if (minutes !== null) {
        deliveryMinutes += minutes;
        deliverySamples++;
      }
    }

    if (status === "cancelled") {
      cancelled++;
      const cancelledAt = delivery.cancelledAt ? new Date(delivery.cancelledAt) : null;
      if (cancelledAt) {
        const bucket = daySeries.get(dayKey(cancelledAt));
        if (bucket) bucket.cancelled += 1;
      }
    }
  }

  const finished = completed + cancelled;
  const successRate = finished > 0 ? Math.round((completed / finished) * 100) : 0;
  const avgDeliveryMinutes = deliverySamples > 0 ? Math.round(deliveryMinutes / deliverySamples) : 0;

  // The table on the overview: the jobs that moved most recently, newest first.
  const recent = [...deliveries]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8)
    .map(toDto);

  return {
    stats: {
      totalDeliveries: deliveries.length,
      completed,
      active: activeCount,
      pendingRequests,
      cancelled,
      earnings,
      earningsThisMonth,
      earningsInWindow,
      successRate,
      avgDeliveryMinutes,
    },
    statusCounts,
    series: dayKeys.map((key) => {
      const bucket = daySeries.get(key)!;
      return {
        date: key,
        delivered: bucket.delivered,
        cancelled: bucket.cancelled,
        earnings: Math.round(bucket.earnings * 100) / 100,
      };
    }),
    recent,
    range: { days, from: dayKeys[0], to: dayKeys[dayKeys.length - 1] },
  };
}

/** The rider's own jobs, filtered and paged. */
export async function getRiderDeliveries(riderId: string, query: GetRiderDeliveriesQuery) {
  const { status, search, sort, page, limit } = query;
  const conditions: any[] = [{ riderId: new Types.ObjectId(riderId) }];

  if (status === "active") {
    conditions.push({ status: { $in: ACTIVE_DELIVERY_STATUSES } });
  } else if (status === "finished") {
    conditions.push({ status: { $in: FINISHED_DELIVERY_STATUSES } });
  } else if (status !== "all") {
    conditions.push({ status });
  }

  if (search?.trim()) {
    const q = search.trim();
    const matches: any[] = [
      { customerName: { $regex: q, $options: "i" } },
      { city: { $regex: q, $options: "i" } },
      { address: { $regex: q, $options: "i" } },
      { customerPhone: { $regex: q, $options: "i" } },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(q)) matches.push({ _id: q }, { orderId: q });
    conditions.push({ $or: matches });
  }

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    fee_desc: { fee: -1, createdAt: -1 },
  };

  const filter = { $and: conditions };
  const [deliveries, total, pending] = await Promise.all([
    Delivery.find(filter)
      .sort(sortMap[sort] ?? sortMap.newest)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Delivery.countDocuments(filter),
    Delivery.countDocuments({ riderId: new Types.ObjectId(riderId), status: "assigned" }),
  ]);

  return {
    deliveries: deliveries.map(toDto),
    total,
    // The sidebar badge: offers this rider still has to answer.
    pendingRequests: pending,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * One job, for the rider's own detail view.
 *
 * The list rows only carry the copy a delivery needs at the door, so the detail
 * read joins the order behind the job: the lines, the money the customer was
 * charged, the payment method (a cash order is money the rider has to collect),
 * the whole address with its postcode, and the store the parcel comes from.
 */
export async function getRiderDelivery(riderId: string, id: string) {
  const delivery = await requireRiderDelivery(riderId, id);

  const [order, settings] = await Promise.all([
    Order.findById(delivery.orderId)
      .select(
        "items subtotal shippingFee totalAmount shippingMethod shippingAddress paymentMethod orderStatus estimatedDelivery pointsDiscount pointsRedeemed couponCode couponDiscount createdAt"
      )
      .lean(),
    SiteSettings.findOne().select("siteName address supportPhone supportEmail currency").lean(),
  ]);

  const dto = toDto(delivery);
  if (!order) return { ...dto, order: null, pickup: null };

  const total = Number(order.totalAmount || 0);
  const paymentMethod = order.paymentMethod || "cod";

  return {
    ...dto,
    order: {
      _id: String(order._id),
      orderNumber: dto.orderNumber,
      placedAt: new Date(order.createdAt).toISOString(),
      status: order.orderStatus,
      estimatedDelivery: order.estimatedDelivery || "",
      shippingMethod: order.shippingMethod || "standard",
      paymentMethod,
      // The one number the rider has to get right at the door.
      amountToCollect: paymentMethod === "cod" ? total : 0,
      address: {
        fullName: order.shippingAddress?.fullName || delivery.customerName || "",
        phone: order.shippingAddress?.phone || delivery.customerPhone || "",
        address: order.shippingAddress?.address || "",
        city: order.shippingAddress?.city || "",
        postalCode: order.shippingAddress?.postalCode || "",
      },
      items: (order.items || []).map((item: any) => ({
        title: item.title || "Item",
        quantity: Number(item.quantity || 0),
        price: Number(item.price || 0),
        image: item.image || "",
      })),
      totals: {
        subtotal: Number(order.subtotal || 0),
        shipping: Number(order.shippingFee || 0),
        // Both kinds of saving are merged into one line: the rider only needs to
        // know the order was discounted, not which ledger paid for it.
        discount: Number(order.pointsDiscount || 0) + Number(order.couponDiscount || 0),
        couponCode: order.couponCode || "",
        pointsRedeemed: Number(order.pointsRedeemed || 0),
        total,
      },
    },
    pickup: {
      name: settings?.siteName || "Sparq store",
      address: settings?.address || "",
      phone: settings?.supportPhone || "",
      email: settings?.supportEmail || "",
      currency: settings?.currency || "USD",
    },
  };
}

/**
 * Everything the invoice PDF prints, for one delivery the caller is carrying.
 *
 * It is read from the order rather than copied onto the delivery months
 * earlier, so the figures always match what the customer was charged. The
 * rider's own row is the ownership check: an id that is not theirs is simply
 * "not found", which tells a stranger nothing.
 */
export async function getRiderInvoice(riderId: string, deliveryId: string) {
  if (!Types.ObjectId.isValid(deliveryId)) throw new ApiError(404, "Delivery not found");

  const delivery = await Delivery.findOne({
    _id: new Types.ObjectId(deliveryId),
    riderId: new Types.ObjectId(riderId),
  })
    .populate("riderId", "name phone image vehicleType vehicleNumber")
    .lean();

  if (!delivery) throw new ApiError(404, "Delivery not found");

  const order = await Order.findById(delivery.orderId)
    .select(
      "items subtotal shippingFee totalAmount shippingMethod shippingAddress paymentMethod orderStatus pointsDiscount pointsRedeemed createdAt"
    )
    .lean();

  if (!order) throw new ApiError(404, "This delivery has no order behind it");

  const settings = await SiteSettings.findOne().select("siteName address supportEmail supportPhone currency").lean();
  const items = (order.items || []).map((item: any) => ({
    title: item.title || "Item",
    quantity: Number(item.quantity || 0),
    price: Number(item.price || 0),
  }));

  return {
    invoiceNumber: `INV-${String(delivery._id).slice(-8).toUpperCase()}`,
    issuedAt: new Date().toISOString(),
    order: {
      _id: String(order._id),
      orderNumber: shortOrderNumber(order._id),
      placedAt: new Date(order.createdAt).toISOString(),
      status: order.orderStatus,
      paymentMethod: order.paymentMethod,
      shippingMethod: order.shippingMethod || "standard",
    },
    store: {
      name: settings?.siteName || "Sparq",
      address: settings?.address || "",
      email: settings?.supportEmail || "",
      phone: settings?.supportPhone || "",
      currency: settings?.currency || "USD",
    },
    customer: {
      name: order.shippingAddress?.fullName || delivery.customerName || "Customer",
      phone: order.shippingAddress?.phone || delivery.customerPhone || "",
      address: [order.shippingAddress?.address, order.shippingAddress?.city]
        .filter(Boolean)
        .join(", "),
      postalCode: order.shippingAddress?.postalCode || "",
    },
    rider: riderOf({ riderId: delivery.riderId }),
    delivery: {
      status: delivery.status as DeliveryStatus,
      fee: Number(delivery.fee || 0),
      distanceKm: delivery.distanceKm ?? null,
      assignedAt: new Date(delivery.createdAt).toISOString(),
    },
    items,
    totals: {
      subtotal: Number(order.subtotal || 0),
      shipping: Number(order.shippingFee || 0),
      discount: Number(order.pointsDiscount || 0),
      pointsRedeemed: Number(order.pointsRedeemed || 0),
      total: Number(order.totalAmount || 0),
    },
  };
}

// ─── Store: choosing a rider ──────────────────────────────────────────────────

/**
 * The riders the store can hand a job to.
 *
 * Offline riders are still listed, marked unavailable, because "nobody is
 * online" is more useful than an empty picker. `activeJobs` says how loaded
 * each one already is.
 *
 * The list is built from the approved `roles` array rather than `role`, because
 * a rider who is currently on their customer dashboard is still a rider and the
 * store must be able to see them.
 */
export async function listAssignableRiders(orderId?: string) {
  const riders = await User.find(riderAccountsFilter())
    .select("name email phone image availability vehicleType vehicleNumber status roleSuspensions")
    .lean();

  const ids = riders.map((r: any) => r._id);
  const [activeRows, deliveredRows, live] = await Promise.all([
    Delivery.aggregate([
      { $match: { riderId: { $in: ids }, status: { $in: ACTIVE_DELIVERY_STATUSES } } },
      { $group: { _id: "$riderId", count: { $sum: 1 } } },
    ]),
    Delivery.aggregate([
      { $match: { riderId: { $in: ids }, status: "delivered" } },
      { $group: { _id: "$riderId", count: { $sum: 1 } } },
    ]),
    orderId && Types.ObjectId.isValid(orderId)
      ? Delivery.findOne({
          orderId: new Types.ObjectId(orderId),
          status: { $in: LIVE_DELIVERY_STATUSES },
        })
          .select("_id riderId status fee expiresAt createdAt")
          .lean()
      : null,
  ]);

  const activeMap = new Map(activeRows.map((row: any) => [String(row._id), row.count]));
  const deliveredMap = new Map(deliveredRows.map((row: any) => [String(row._id), row.count]));

  return {
    riders: riders
      .map((rider: any) => {
        const availability = rider.availability === "offline" ? "offline" : "online";
        const suspended = rider.status === "suspended" || isRiderAccessParked(rider);
        const activeJobs = activeMap.get(String(rider._id)) || 0;
        return {
          _id: String(rider._id),
          name: rider.name || "Rider",
          email: rider.email || "",
          phone: rider.phone || "",
          image: rider.image || "",
          availability,
          suspended,
          vehicleType: rider.vehicleType || "",
          vehicleNumber: rider.vehicleNumber || "",
          activeJobs,
          completedJobs: deliveredMap.get(String(rider._id)) || 0,
          // An offline rider can still be picked: the store may know they are
          // on their way in. A suspended one cannot, because the assignment
          // would be refused anyway.
          available: availability === "online" && !suspended,
        };
      })
      .sort((a, b) => {
        if (a.available !== b.available) return a.available ? -1 : 1;
        if (a.activeJobs !== b.activeJobs) return a.activeJobs - b.activeJobs;
        return a.name.localeCompare(b.name);
      }),
    currentRiderId: live ? String(live.riderId) : null,
    // The live job itself, so the picker can name the rider holding this order,
    // say how far the job got and quote the answer window back to the store.
    // `expired` is part of the answer: a request that ran out of time is shown
    // for context but no longer blocks a new rider.
    currentDelivery: live
      ? {
          _id: String(live._id),
          status: live.status as DeliveryStatus,
          riderId: String(live.riderId),
          riderName:
            riders.find((rider: any) => String(rider._id) === String(live.riderId))?.name ||
            "the assigned rider",
          fee: Number(live.fee || 0),
          expiresAt: live.expiresAt ? new Date(live.expiresAt).toISOString() : null,
          assignedAt: new Date(live.createdAt).toISOString(),
          // The server owns the clock, so the picker is quoted a finished number
          // instead of doing arithmetic while it renders. Only an unanswered
          // request has an answer window; accepted work is past that question.
          minutesLeft:
            live.status === "assigned" && live.expiresAt ? minutesLeft(live.expiresAt) : 0,
          expired: isLapsedOffer(live),
        }
      : null,
  };
}

/** Creates one offer, with everything the rider needs at the door. */
async function createAssignment(params: {
  order: any;
  riderId: string;
  adminId?: string;
  fee?: number;
  distanceKm?: number;
  note?: string;
}) {
  const { order, riderId, adminId, fee, distanceKm, note } = params;

  const expiresAt = new Date(Date.now() + REQUEST_WINDOW_MINUTES * 60_000);
  const items = (order.items || []).reduce(
    (sum: number, item: any) => sum + (item.quantity || 0),
    0
  );

  const delivery = await Delivery.create({
    orderId: order._id,
    riderId: new Types.ObjectId(riderId),
    assignedBy: adminId ? new Types.ObjectId(adminId) : null,
    status: "assigned",
    customerName: order.shippingAddress?.fullName || "",
    customerPhone: order.shippingAddress?.phone || "",
    address: order.shippingAddress?.address || "",
    city: order.shippingAddress?.city || "",
    items,
    orderTotal: order.totalAmount || 0,
    fee: typeof fee === "number" ? fee : feeFor(order),
    distanceKm: typeof distanceKm === "number" ? distanceKm : null,
    expiresAt,
    history: [
      {
        status: "assigned",
        at: new Date(),
        note: note || "",
        by: adminId ?? null,
      },
    ],
  });

  // The seller rows follow the parent's job, so a vendor sees the same rider
  // the customer does without a second assignment of its own.
  await syncVendorOrdersForDelivery(order._id, delivery._id, delivery.riderId);

  return delivery;
}

/** The email and in-app line that reach the rider. */
async function announceAssignment(delivery: any) {
  const riderId = String(delivery.riderId?._id ?? delivery.riderId);
  await notifyRiderAssigned(riderId, {
    deliveryId: String(delivery._id),
    orderId: String(delivery.orderId),
    orderNumber: shortOrderNumber(delivery.orderId),
    customerName: delivery.customerName,
    customerPhone: delivery.customerPhone,
    address: [delivery.address, delivery.city].filter(Boolean).join(", "),
    items: delivery.items,
    total: delivery.orderTotal,
    fee: delivery.fee,
    expiresAt: delivery.expiresAt ?? undefined,
  });

  await recordActivity({
    type: "delivery",
    title: `Delivery ${shortOrderNumber(delivery.orderId)} offered`,
    detail: `${delivery.customerName || "Customer"} · ${delivery.city || "—"} · ${money(
      delivery.fee
    )}`,
    ref: String(delivery.orderId),
  });
}

/**
 * Offers an order to a rider, optionally shipping it in the same step.
 *
 * When `ship` is set the order only leaves the store if the offer exists, so a
 * failed ship cancels the offer instead of leaving a rider with a parcel that
 * never left.
 */
export async function assignDelivery(input: AssignDeliveryInput, adminId?: string) {
  const order = await Order.findById(input.orderId);
  if (!order) throw new ApiError(404, "Order not found");
  if (order.orderStatus === "cancelled" || order.orderStatus === "delivered") {
    throw new ApiError(400, `A ${order.orderStatus} order cannot be assigned to a rider`);
  }

  await requireRiderAccount(input.riderId);

  // One live job per order, whatever the order's own stage. A shipped order is
  // allowed here only when nothing is live: the parcel came back after a
  // cancellation, or the order was shipped before anybody was assigned.
  const existing = await Delivery.findOne({
    orderId: order._id,
    status: { $in: LIVE_DELIVERY_STATUSES },
  })
    .select("_id riderId status expiresAt")
    .populate("riderId", "name")
    .lean();
  if (existing) {
    const holder = (existing.riderId as any)?.name || "the assigned rider";
    if (!isLapsedOffer(existing)) {
      // The order already has somebody's name on it, and that claim is the
      // store's, the rider's and the customer's until it ends. Two riders cannot
      // both be sent to one parcel, so the picker stays shut until the rider
      // answers: a decline or an expired window frees the order on its own.
      throw new ApiError(
        order.orderStatus === "shipped" ? 400 : 409,
        existing.status === "assigned"
          ? `${holder} was offered this job and has ${minutesLeft(
              existing.expiresAt
            )} minute(s) left to answer. Assign another rider once they decline or the request expires, or cancel this delivery first.`
          : `${holder} has accepted this delivery and is working on it. Cancel the delivery first if it must go to another rider.`
      );
    }
    // Nobody answered in time, so this row is history: close it before the new
    // request is written, so the order never carries two claims at once.
    await closeLapsedOffer(String(existing._id), adminId);
  }

  const delivery = await createAssignment({
    order,
    riderId: input.riderId,
    adminId,
    fee: input.fee,
    distanceKm: input.distanceKm,
    note: input.note,
  });

  if (input.ship) {
    try {
      await updateOrderStatus(String(order._id), { orderStatus: "shipped" }, adminId);
    } catch (err) {
      // The offer is worthless without a shipped order, so take it back. The
      // row stays for the history, and the store can try again.
      await Delivery.updateOne(
        { _id: delivery._id },
        {
          $set: { status: "cancelled", cancelledAt: new Date() },
          $push: {
            history: {
              status: "cancelled",
              at: new Date(),
              note: "Shipping failed, offer withdrawn",
              by: adminId ?? null,
            },
          },
        }
      );
      throw err;
    }
  }

  await announceAssignment(delivery);

  // When the order ships in the same step, the order_shipped line already
  // tells the customer a rider is on the case (and now links to the tracking
  // page). Assigning without shipping would otherwise leave the customer in the
  // dark, so a delivery_update line points them at the tracking page the
  // moment a rider is chosen — before the parcel has even left the store.
  if (!input.ship) {
    await notifyCustomerDelivery({
      userId: String(order.userId),
      deliveryId: String(delivery._id),
      orderId: String(order._id),
      orderNumber: shortOrderNumber(order._id),
      title: "A rider has been assigned",
      detail:
        "Your order has been assigned to a rider. We'll let you know as soon as it's on its way.",
    });
  }

  const populated = await Delivery.findById(delivery._id).populate(
    "riderId",
    "name phone vehicleType vehicleNumber"
  );
  return toDto(populated);
}

/**
 * Stops a request nobody answered and hands the same order to somebody else.
 *
 * Only an expired request qualifies. An offer still inside its window belongs to
 * the rider it was sent to, and a job they accepted belongs to them outright:
 * moving either one behind their back would leave a rider holding a parcel that
 * is suddenly someone else's, so the store cancels those instead and everybody is
 * told the delivery stopped.
 */
export async function reassignDelivery(
  deliveryId: string,
  input: ReassignDeliveryInput,
  adminId?: string
) {
  const current = await requireDelivery(deliveryId);
  if (current.status !== "assigned" || !isLapsedOffer(current)) {
    const holder = (current.riderId as any)?.name || "the assigned rider";
    throw new ApiError(
      400,
      LIVE_DELIVERY_STATUSES.includes(current.status as DeliveryStatus)
        ? current.status === "assigned"
          ? `${holder} still has ${minutesLeft(current.expiresAt)} minute(s) to answer this request. Wait for their answer, or cancel the delivery to pick another rider now.`
          : `${holder} has accepted this delivery. Cancel it first if it cannot go ahead — accepted work is not handed over behind a rider's back.`
        : "This delivery is finished and cannot be reassigned"
    );
  }

  await requireRiderAccount(input.riderId);

  if (String(current.riderId?._id ?? current.riderId) === input.riderId) {
    throw new ApiError(400, "That rider already has this delivery");
  }

  const order = await Order.findById(current.orderId);
  if (!order) throw new ApiError(404, "Order not found");

  // Close the lapsed offer first: a second request on the same order would
  // otherwise sit beside one that is still technically live.
  await Delivery.updateOne(
    { _id: current._id },
    {
      $set: {
        status: "cancelled",
        cancelledAt: new Date(),
        declineReason: "",
      },
      $push: {
        history: {
          status: "cancelled",
          at: new Date(),
          note: `Reassigned after the request expired${input.note ? `: ${input.note}` : ""}`,
          by: adminId ?? null,
        },
      },
    }
  );

  const replacement = await createAssignment({
    order,
    riderId: input.riderId,
    adminId,
    fee: input.fee ?? current.fee,
    distanceKm: current.distanceKm ?? undefined,
    note: input.note,
  });

  await notifyCustomerDelivery({
    userId: String(order.userId),
    deliveryId: String(replacement._id),
    orderId: String(order._id),
    orderNumber: shortOrderNumber(order._id),
    title: "A new rider is bringing your order",
    detail: "Your delivery was handed to another rider. Follow it live from your tracking page.",
  });

  await announceAssignment(replacement);
  const populated = await Delivery.findById(replacement._id).populate(
    "riderId",
    "name phone vehicleType vehicleNumber"
  );
  return toDto(populated);
}

// ─── Rider: answering a request ───────────────────────────────────────────────

/**
 * Accepts a request.
 *
 * The update is one atomic condition: still mine, still `assigned`, still
 * unexpired. Two taps on two phones, or a tap a second after the window closes,
 * therefore cannot both win.
 */
export async function acceptDelivery(riderId: string, id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Delivery not found");

  const rider = await User.findById(riderId).select("availability status").lean();
  if ((rider as any)?.status === "suspended") {
    throw new ApiError(400, "This account is suspended and cannot take deliveries.");
  }
  if ((rider as any)?.availability === "offline") {
    throw new ApiError(400, "You are offline. Go online to accept new deliveries.");
  }

  const now = new Date();
  const accepted = await Delivery.findOneAndUpdate(
    {
      _id: new Types.ObjectId(id),
      riderId: new Types.ObjectId(riderId),
      status: "assigned",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    },
    {
      $set: { status: "accepted", acceptedAt: now, expiresAt: null },
      $push: { history: { status: "accepted", at: now, note: "", by: riderId } },
    },
    { new: true }
  );

  if (!accepted) {
    // Explain the loss precisely, because "try again" is useless here.
    const current = await Delivery.findById(id).select("status riderId expiresAt").lean();
    if (!current) throw new ApiError(404, "Delivery not found");
    if (String(current.riderId) !== riderId) throw new ApiError(404, "Delivery not found");
    if (current.status !== "assigned") {
      throw new ApiError(400, `This request is already ${current.status}.`);
    }
    throw new ApiError(400, "This request expired. Ask the store to offer it again.");
  }

  await recordActivity({
    type: "delivery",
    title: `Delivery ${shortOrderNumber(accepted.orderId)} accepted`,
    detail: `${accepted.customerName || "Customer"} · ${accepted.city || "—"}`,
    ref: String(accepted.orderId),
  });

  const populated = await Delivery.findById(accepted._id).populate(
    "riderId",
    "name phone vehicleType vehicleNumber"
  );
  return toDto(populated);
}

/** Declines a request, keeping the reason for the store. */
export async function declineDelivery(
  riderId: string,
  id: string,
  input: DeclineDeliveryInput
) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Delivery not found");
  const now = new Date();

  const declined = await Delivery.findOneAndUpdate(
    {
      _id: new Types.ObjectId(id),
      riderId: new Types.ObjectId(riderId),
      status: "assigned",
    },
    {
      $set: { status: "declined", declineReason: input.reason, expiresAt: null },
      $push: { history: { status: "declined", at: now, note: input.reason, by: riderId } },
    },
    { new: true }
  );

  if (!declined) {
    const current = await Delivery.findById(id).select("status riderId").lean();
    if (!current || String(current.riderId) !== riderId) throw new ApiError(404, "Delivery not found");
    throw new ApiError(400, `This request is already ${current.status}.`);
  }

  const orderNumber = shortOrderNumber(declined.orderId);
  const rider = await User.findById(riderId).select("name").lean();
  const riderName = (rider as any)?.name || "A rider";

  await recordActivity({
    type: "delivery",
    title: `Delivery ${orderNumber} declined`,
    detail: `${riderName}: ${input.reason}`,
    ref: String(declined.orderId),
  });

  await notifyAdminDeliveryEmail({
    heading: "A rider declined a delivery",
    intro: "The order is still waiting for a rider. Assign it again from the orders page.",
    orderNumber,
    rows: [
      { label: "Rider", value: riderName },
      { label: "Customer", value: declined.customerName },
      { label: "City", value: declined.city },
    ],
    note: input.reason,
  });

  const populated = await Delivery.findById(declined._id).populate(
    "riderId",
    "name phone vehicleType vehicleNumber"
  );
  return toDto(populated);
}

// ─── Rider: moving the job forward ────────────────────────────────────────────

const STEP_TIMESTAMP: Record<string, string> = {
  picked_up: "pickedUpAt",
  out_for_delivery: "outForDeliveryAt",
};

/**
 * Moves an accepted job one step: picked up, then out for delivery.
 *
 * Nothing else is done from here. A rider cannot cancel, and cannot decline a
 * job already accepted — `declineDelivery` only answers an `assigned` row — so
 * the two ways a delivery stops are the store's and the customer's, never the
 * rider's.
 *
 * The atomic update carries the current status, so a double tap cannot skip a
 * stage, and the guard below rejects any jump the lifecycle does not allow.
 */
export async function advanceDelivery(riderId: string, id: string, input: RiderStepInput) {
  const delivery = await requireRiderDelivery(riderId, id);
  const from = delivery.status as DeliveryStatus;
  const to = input.status as DeliveryStatus;

  // Said before anything is written, and in the rider's own terms. The
  // validator refuses these two stages on the way in, so this only catches a
  // client that is out of date, but it must not let one half-close a job.
  if (to === "cancelled" || to === "declined") {
    throw new ApiError(
      400,
      "A rider cannot cancel a delivery. Keep going to the door and close it with the customer's code. If the parcel must come back, call the store."
    );
  }

  const allowed = nextDeliveryStatuses(from);
  if (!allowed.includes(to)) {
    const step = nextRiderStep(from);
    throw new ApiError(
      400,
      step
        ? `A ${from.replace(/_/g, " ")} delivery moves to ${step.replace(/_/g, " ")} first`
        : `This delivery is ${from.replace(/_/g, " ")} and can no longer be changed`
    );
  }

  const now = new Date();
  const setFields: Record<string, unknown> = { status: to, [STEP_TIMESTAMP[to]]: now };

  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, riderId: new Types.ObjectId(riderId), status: from },
    {
      $set: setFields,
      $push: {
        history: {
          status: to,
          at: now,
          note: input.note || "",
          by: riderId,
        },
      },
    },
    { new: true }
  ).populate("riderId", "name phone image vehicleType vehicleNumber");

  if (!updated) {
    throw new ApiError(409, "This delivery changed while you were updating it. Reload and try again.");
  }

  const orderNumber = shortOrderNumber(updated.orderId);
  const order = await Order.findById(updated.orderId).select("userId");

  if (to === "out_for_delivery") {
    // The customer now needs a code to read at the door.
    await ensureOtp(updated._id);
    if (order) {
      await notifyCustomerDelivery({
        userId: String(order.userId),
        deliveryId: String(updated._id),
        orderId: String(updated.orderId),
        orderNumber,
        title: "Out for delivery",
        detail: `${(updated.riderId as any)?.name || "Your rider"} is on the way. Your delivery code and their live position are on your tracking page.`,
        emailHeading: "Your order is out for delivery",
        emailRows: [
          { label: "Rider", value: (updated.riderId as any)?.name },
          { label: "Phone", value: (updated.riderId as any)?.phone },
          { label: "Vehicle", value: (updated.riderId as any)?.vehicleNumber },
        ],
      });
    }
  }

  return toDto(updated);
}

/**
 * Closes a job with the customer's code.
 *
 * The code is checked first, then the order is settled (stock, points,
 * warranties, payment), and only then does the delivery become `delivered`.
 * Order first is what makes a retry safe: closing an already-delivered order is
 * a no-op, so a failed second step can simply be repeated.
 *
 * Reaching `delivered` is also what pays the rider: the fee the store set on
 * this job is booked as paid here, and the same amount comes back off the
 * store's profit. There is no separate payout step to remember, so the two
 * numbers can never drift apart.
 */
export async function completeDelivery(riderId: string, id: string, code: string) {
  const delivery = await requireRiderDelivery(riderId, id);

  if (delivery.status === "delivered") return toDto(delivery);
  if (delivery.status !== "out_for_delivery") {
    throw new ApiError(
      400,
      `The customer's code closes an out for delivery job. This one is ${delivery.status.replace(/_/g, " ")}.`
    );
  }

  await verifyOtpCode(String(delivery._id), code);

  const orderNumber = shortOrderNumber(delivery.orderId);

  try {
    await updateOrderStatus(
      String(delivery.orderId),
      { orderStatus: "delivered" },
      riderId,
      { byRider: true }
    );
  } catch (err) {
    throw new ApiError(
      (err as any)?.statusCode || 400,
      `The code is correct, but the order could not be closed: ${(err as Error).message}`
    );
  }

  const now = new Date();
  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, riderId: new Types.ObjectId(riderId), status: "out_for_delivery" },
    {
      $set: { status: "delivered", deliveredAt: now, feePaidVia: "code" },
      $push: {
        history: { status: "delivered", at: now, note: "Code verified", by: riderId },
      },
    },
    { new: true }
  ).populate("riderId", "name phone image vehicleType vehicleNumber");

  await markOtpUsed(String(delivery._id));

  const order = await Order.findById(delivery.orderId).select("userId");
  if (updated && order) {
    await notifyCustomerDelivery({
      userId: String(order.userId),
      deliveryId: String(updated._id),
      orderId: String(updated.orderId),
      orderNumber,
      title: "Delivered",
      detail: "Your delivery code was confirmed. Thanks for shopping with us.",
      emailHeading: "Your order has been delivered",
      emailRows: [
        { label: "Order", value: orderNumber },
        { label: "Rider", value: (updated.riderId as any)?.name },
      ],
    });
  }

  await recordActivity({
    type: "delivery",
    title: `Delivery ${orderNumber} completed`,
    detail: `${(updated?.riderId as any)?.name || "Rider"} · ${money(updated?.fee)}`,
    ref: String(delivery.orderId),
  });

  return toDto(updated ?? delivery);
}

/** Asks for a new code, which the customer reads out instead. */
export async function regenerateOtpForDelivery(deliveryId: string) {
  const delivery = await requireDelivery(deliveryId);
  if (delivery.status !== "out_for_delivery" && delivery.status !== "accepted" && delivery.status !== "picked_up") {
    throw new ApiError(400, "A new code is only needed while the delivery is on its way");
  }
  await ensureOtp(delivery._id, true);
  return true;
}

// ─── Store: the delivery board ────────────────────────────────────────────────

/** Every job, filtered for the store's delivery page. */
export async function getAdminDeliveries(query: AdminDeliveryQuery) {
  const { status, riderId, search, sort, page, limit } = query;
  const conditions: any[] = [];

  if (status === "active") {
    conditions.push({ status: { $in: ACTIVE_DELIVERY_STATUSES } });
  } else if (status === "finished") {
    conditions.push({ status: { $in: FINISHED_DELIVERY_STATUSES } });
  } else if (status !== "all") {
    conditions.push({ status });
  }

  if (riderId && Types.ObjectId.isValid(riderId)) {
    conditions.push({ riderId: new Types.ObjectId(riderId) });
  }

  if (search?.trim()) {
    const q = search.trim();
    const matches: any[] = [
      { customerName: { $regex: q, $options: "i" } },
      { customerPhone: { $regex: q, $options: "i" } },
      { city: { $regex: q, $options: "i" } },
      { address: { $regex: q, $options: "i" } },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(q)) matches.push({ _id: q }, { orderId: q });
    conditions.push({ $or: matches });
  }

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    fee_desc: { fee: -1, createdAt: -1 },
  };

  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const [deliveries, total] = await Promise.all([
    Delivery.find(filter)
      .populate("riderId", "name phone image vehicleType vehicleNumber")
      .sort(sortMap[sort] ?? sortMap.newest)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Delivery.countDocuments(filter),
  ]);

  return {
    deliveries: deliveries.map(toDto),
    total,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** The numbers at the top of the delivery board. */
export async function getAdminDeliveryOverview() {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [statusRows, deliveredToday, riders, shippedWithoutRider, onTheRoad] = await Promise.all([
    Delivery.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Delivery.countDocuments({ status: "delivered", deliveredAt: { $gte: dayStart } }),
    User.aggregate([
      { $match: riderAccountsFilter() },
      { $group: { _id: "$availability", count: { $sum: 1 } } },
    ]),
    Order.countDocuments({
      orderStatus: "shipped",
      _id: {
        $nin: (
          await Delivery.distinct("orderId", {
            status: { $in: LIVE_DELIVERY_STATUSES },
          })
        ).map((id: any) => new Types.ObjectId(String(id))),
      },
    }),
    Delivery.countDocuments({ status: "out_for_delivery" }),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const row of statusRows) statusCounts[row._id] = row.count;

  const onlineRiders =
    riders.find((row: any) => row._id === "online")?.count ??
    riders.reduce((sum: number, row: any) => sum + row.count, 0);

  return {
    statusCounts,
    total: statusRows.reduce((sum: number, row: any) => sum + row.count, 0),
    active: (statusCounts.accepted || 0) + (statusCounts.picked_up || 0) + (statusCounts.out_for_delivery || 0),
    waiting: statusCounts.assigned || 0,
    deliveredToday,
    onlineRiders,
    shippedWithoutRider,
    // Every one of these is a parcel on the road with a code waiting at the door.
    onTheRoad,
  };
}

/**
 * Where a period's buckets start, in the store's own terms: the last 30 or 90
 * days read as days, a year and everything before it read as months. A day is
 * the right grain when a week of work fits on one screen; a month is the right
 * grain when the store is asking what a year cost them.
 */
function payoutWindow(range: string): { from: Date | null; format: string } {
  const now = new Date();
  if (range === "all") return { from: null, format: "%Y-%m" };

  const days = Number(range);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  from.setDate(from.getDate() - (days - 1));
  return { from, format: days <= 90 ? "%Y-%m-%d" : "%Y-%m" };
}

/**
 * The store's payout record.
 *
 * One row per job that paid a rider, which is one row per delivered delivery:
 * the fee is booked the moment the hand-over is confirmed, by the rider's code
 * or by the customer's own answer, so a delivered job always has a payout and a
 * job that never reached the door never does. Nothing is paid out later by hand,
 * so this list cannot fall behind the rider's own earnings screen and the two
 * always add up to the same money.
 *
 * Every number is folded in the database, not in a loop over every row: a store
 * with years of deliveries would otherwise pull its whole history into memory to
 * draw one chart. The record table is the only part that is paged.
 */
export async function getAdminPayouts(query: AdminPayoutsQuery) {
  const { from, format } = payoutWindow(query.range);

  const matched: any = { status: "delivered" };
  if (from) matched.deliveredAt = { $gte: from };
  if (query.riderId && Types.ObjectId.isValid(query.riderId)) {
    matched.riderId = new Types.ObjectId(query.riderId);
  }

  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const withDates = { ...matched, deliveredAt: { $ne: null, ...(from ? { $gte: from } : {}) } };

  const [bucketRows, totalRows, monthRows, riderRows, outstanding, records, count] =
    await Promise.all([
      Delivery.aggregate([
        { $match: withDates },
        {
          $group: {
            _id: { $dateToString: { format, date: "$deliveredAt" } },
            jobs: { $sum: 1 },
            paid: { $sum: "$fee" },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Delivery.aggregate([
        { $match: matched },
        { $group: { _id: null, jobs: { $sum: 1 }, paid: { $sum: "$fee" } } },
      ]),
      Delivery.aggregate([
        { $match: { ...matched, deliveredAt: { $gte: monthStart } } },
        { $group: { _id: null, jobs: { $sum: 1 }, paid: { $sum: "$fee" } } },
      ]),
      Delivery.aggregate([
        { $match: withDates },
        {
          $group: {
            _id: "$riderId",
            jobs: { $sum: 1 },
            paid: { $sum: "$fee" },
            lastAt: { $max: "$deliveredAt" },
          },
        },
        { $sort: { paid: -1 } },
      ]),
      // Money the store has promised but not spent yet: a job somebody is
      // riding, which pays its fee the moment it reaches the door.
      Delivery.aggregate([
        {
          $match: {
            status: { $in: ACTIVE_DELIVERY_STATUSES },
            ...(query.riderId && Types.ObjectId.isValid(query.riderId)
              ? { riderId: new Types.ObjectId(query.riderId) }
              : {}),
          },
        },
        { $group: { _id: null, jobs: { $sum: 1 }, amount: { $sum: "$fee" } } },
      ]),
      Delivery.find(matched)
        .populate("riderId", "name")
        .sort(
          query.sort === "oldest"
            ? { deliveredAt: 1 }
            : query.sort === "fee_desc"
              ? { fee: -1, deliveredAt: -1 }
              : { deliveredAt: -1 }
        )
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .select("orderId riderId city items orderTotal fee deliveredAt feePaidVia")
        .lean(),
      Delivery.countDocuments(matched),
    ]);

  const paid = Math.round((totalRows[0]?.paid ?? 0) * 100) / 100;
  const jobs = totalRows[0]?.jobs ?? 0;
  const owed = outstanding[0] ?? { jobs: 0, amount: 0 };

  // A rider's name is not copied onto the job, so the board asks for the names
  // it actually has payouts for instead of reading every account in the store.
  const riderIds = riderRows.map((row: any) => row._id).filter((id: any) => Types.ObjectId.isValid(String(id)));
  const riderDocs = riderIds.length
    ? await User.find({ _id: { $in: riderIds } }).select("name").lean()
    : [];
  const names = new Map(riderDocs.map((rider: any) => [String(rider._id), rider.name || ""]));

  return {
    range: query.range,
    totals: {
      jobs,
      paid,
      avgPerJob: jobs > 0 ? Math.round((paid / jobs) * 100) / 100 : 0,
      paidThisMonth: Math.round((monthRows[0]?.paid ?? 0) * 100) / 100,
      monthJobs: monthRows[0]?.jobs ?? 0,
    },
    // What the store still owes the riders it has sent out. Not a cost yet, so
    // it is never added to `paid`.
    outstanding: {
      jobs: owed.jobs,
      amount: Math.round(owed.amount * 100) / 100,
    },
    series: bucketRows.map((row: any) => ({
      label: String(row._id),
      jobs: row.jobs,
      paid: Math.round(row.paid * 100) / 100,
    })),
    byRider: riderRows.map((row: any) => ({
      riderId: String(row._id),
      name: names.get(String(row._id)) || "A rider",
      jobs: row.jobs,
      paid: Math.round(row.paid * 100) / 100,
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
    })),
    records: records.map((record: any) => ({
      _id: String(record._id),
      orderId: String(record.orderId),
      orderNumber: shortOrderNumber(record.orderId),
      riderName: record.riderId?.name || "A rider",
      city: record.city || "",
      items: Number(record.items || 0),
      orderTotal: Number(record.orderTotal || 0),
      fee: Number(record.fee || 0),
      deliveredAt: record.deliveredAt ? new Date(record.deliveredAt).toISOString() : null,
      // A job closed before the hand-over was recorded says nothing about how it
      // ended, and the code at the door is the only other way a job ever closed.
      paidVia: record.feePaidVia === "customer" ? "customer" : "code",
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total: count,
      totalPages: Math.ceil(count / query.limit) || 1,
    },
  };
}

/** Every assignment an order has had, newest first — the store's own history. */
export async function getOrderDeliveries(orderId: string) {
  if (!Types.ObjectId.isValid(orderId)) throw new ApiError(404, "Order not found");
  const deliveries = await Delivery.find({ orderId: new Types.ObjectId(orderId) })
    .populate("riderId", "name phone image vehicleType vehicleNumber")
    .sort({ createdAt: -1 })
    .lean();
  return { deliveries: deliveries.map(toDto) };
}

/** The store stopping a job, with a reason the rider is told. */
export async function cancelDeliveryByAdmin(
  deliveryId: string,
  reason: string | undefined,
  adminId?: string
) {
  const delivery = await requireDelivery(deliveryId);
  if (!LIVE_DELIVERY_STATUSES.includes(delivery.status as DeliveryStatus)) {
    throw new ApiError(400, "This delivery is already finished");
  }

  const now = new Date();
  const updated = await Delivery.findOneAndUpdate(
    { _id: delivery._id, status: delivery.status },
    {
      $set: { status: "cancelled", cancelledAt: now, declineReason: reason || "" },
      $push: {
        history: {
          status: "cancelled",
          at: now,
          note: reason || "Cancelled by the store",
          by: adminId ?? null,
        },
      },
    },
    { new: true }
  ).populate("riderId", "name phone image vehicleType vehicleNumber");

  if (!updated) throw new ApiError(409, "This delivery changed while you were updating it");

  const orderNumber = shortOrderNumber(updated.orderId);
  const order = await Order.findById(updated.orderId).select("userId");

  await recordActivity({
    type: "delivery",
    title: `Delivery ${orderNumber} cancelled by the store`,
    detail: reason || "No reason given",
    ref: String(updated.orderId),
  });

  if (updated.riderId) {
    // The rider is told in the app: the store made this call, so there is no
    // reason to email the store about its own decision.
    await notifyUser({
      userId: String((updated.riderId as any)._id ?? updated.riderId),
      role: "rider",
      type: "delivery_update",
      title: `Delivery ${orderNumber} was cancelled`,
      detail: reason || "The store cancelled this delivery.",
      ref: String(updated._id),
    });
  }

  if (order) {
    await notifyCustomerDelivery({
      userId: String(order.userId),
      deliveryId: String(updated._id),
      orderId: String(updated.orderId),
      orderNumber,
      title: "Your delivery was cancelled",
      detail: "The store will contact you about a new delivery.",
    });
  }

  return toDto(updated);
}

/**
 * Marks offers that nobody answered as cancelled.
 *
 * Accepting already refuses an expired row, so this sweep only tidies the
 * board. It is safe to run at any time, and it never touches a job a rider has
 * accepted. Each row is closed on its own so the rider who missed it is told
 * exactly once — a row a rider answered a moment earlier simply does not match.
 */
export async function expireStaleDeliveries() {
  const now = new Date();
  const stale = await Delivery.find({
    status: "assigned",
    expiresAt: { $ne: null, $lt: now },
  })
    .select("_id orderId riderId")
    .lean();

  if (stale.length === 0) return { expired: 0 };

  let expired = 0;

  for (const row of stale) {
    const closed = await Delivery.findOneAndUpdate(
      { _id: row._id, status: "assigned" },
      {
        $set: { status: "cancelled", cancelledAt: now },
        $push: {
          history: {
            status: "cancelled",
            at: now,
            note: "Request expired without an answer",
          },
        },
      },
      { new: true }
    )
      .select("_id orderId riderId")
      .lean();

    if (!closed) continue;
    expired += 1;

    // The rider is the one who lost a job: in-app only, because an email about
    // an offer they already ignored is noise.
    await notifyUser({
      userId: String(closed.riderId),
      role: "rider",
      type: "delivery_update",
      title: `Delivery request ${shortOrderNumber(closed.orderId)} expired`,
      detail: "The answer window closed without an answer. The store can offer it again.",
      ref: String(closed._id),
    });
  }

  if (expired > 0) {
    await recordActivity({
      type: "delivery",
      title: `${expired} delivery request${expired === 1 ? "" : "s"} expired`,
      detail: "Nobody answered inside the window, so the offers were closed.",
    });
  }

  return { expired };
}

// ─── Shared ───────────────────────────────────────────────────────────────────

/** The live job for one order, which is what a tracking page talks about. */
export async function getLiveDeliveryForOrder(orderId: string) {
  if (!Types.ObjectId.isValid(orderId)) return null;
  return Delivery.findOne({
    orderId: new Types.ObjectId(orderId),
    status: { $in: LIVE_DELIVERY_STATUSES },
  })
    .sort({ createdAt: -1 })
    .lean();
}

/** The newest position for a delivery, or null when the rider has not shared. */
export async function latestLocation(deliveryId: string) {
  const location = await RiderLocation.findOne({
    deliveryId: new Types.ObjectId(deliveryId),
  }).lean();
  if (!location) return null;

  return {
    lat: location.lat,
    lng: location.lng,
    accuracy: location.accuracy ?? null,
    heading: location.heading ?? null,
    speed: location.speed ?? null,
    updatedAt: new Date(location.updatedAt).toISOString(),
    trail: (location.trail || []).map((point: any) => ({
      lat: point.lat,
      lng: point.lng,
      at: point.at ? new Date(point.at).toISOString() : null,
    })),
  };
}

/**
 * A rough time of arrival.
 *
 * The store only records a road distance, not a route, so this divides what is
 * left of it by a city speed. It is an indication for the customer, not a
 * promise, and it is null when nobody entered a distance.
 */
export function etaFrom(distanceKm: number | null, speedMps: number | null, progress: number) {
  if (!distanceKm || distanceKm <= 0) return null;
  const kmh = speedMps && speedMps > 1 ? speedMps * 3.6 : FALLBACK_SPEED_KMH;
  const remaining = Math.max(0.2, distanceKm * (1 - Math.min(0.95, progress)));
  const minutes = Math.max(1, Math.round((remaining / kmh) * 60));
  return { minutes, at: new Date(Date.now() + minutes * 60_000).toISOString() };
}
