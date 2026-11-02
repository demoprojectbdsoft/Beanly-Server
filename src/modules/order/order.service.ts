import { ClientSession } from "mongoose";
import { Order } from "./order.model";
import { Product } from "../product/product.model";
import { Cart } from "../cart/cart.model";
import { User } from "../user/user.model";
import { Transaction } from "../transaction/transaction.model";
import { ApiError } from "../../utils/apiError";
import { assertOwnerOrAdmin } from "../../utils/authz";
import { withTransaction } from "../../utils/transactions";
import { CreateOrderInput, UpdateOrderStatusInput, CustomerResponseInput, GetOrdersQuery } from "./order.validator";
import { isAllowedTransition, nextStatuses } from "./order.flow";
import { logOrderStatus } from "../order-status/order-status.service";
import { createTransaction, getLatestTransactionForOrder } from "../transaction/transaction.service";
import { getSiteSettings } from "../site-settings/site-settings.service";
import { createWarrantiesForOrder, voidWarrantiesForOrder } from "../warranty/warranty.service";
import {
  IssuedWarranty,
  notifyWarrantiesIssued,
} from "../warranty/warranty.notifications";
import { recordActivity, notifyUser } from "../activity/activity.service";
import {
  notifyOrderPlaced,
  notifyOrderStatusChanged,
} from "../activity/activity.notifications";
import {
  Delivery,
  ACTIVE_DELIVERY_STATUSES,
  LIVE_DELIVERY_STATUSES,
} from "../delivery/delivery.model";
import { isLapsedOffer } from "../delivery/delivery.flow";
import { createVendorOrdersForOrder, syncVendorOrdersForParentStatus } from "../vendor/vendor-order.create";
import {
  evaluateCoupon,
  loadCouponLines,
  redeemCoupon,
  releaseCouponForOrder,
} from "../coupon/coupon.service";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHIPPING_FEE       = 15.0;
const EXPRESS_DELIVERY_FEE = 25.0;
const FREE_SHIPPING_FROM = 50.0;
const POINTS_PER_DOLLAR  = 1;
/** 100 loyalty points convert into 1 currency unit at checkout. */
const POINTS_PER_CURRENCY = 100;
/** Below one full unit there is nothing worth deducting. */
const MIN_POINTS_TO_REDEEM = 100;

/**
 * Resolve the shipping option for an order from the live site settings.
 * Returns the chosen method ("free" | "standard" | "express"), the fee to
 * charge, and the estimated delivery window to display on the receipt.
 */
async function resolveShippingConfig(subtotal: number): Promise<{
  method: "free" | "standard" | "express";
  fee: number;
  estimatedDelivery: string;
  expressFee: number;
}> {
  // Defaults mirror AdminSettingsClient → Shipping & Delivery card
  let freeEnabled = true;
  let freeThreshold = FREE_SHIPPING_FROM;
  let standardFee = SHIPPING_FEE;
  let expressFee = EXPRESS_DELIVERY_FEE;
  let estimatedDelivery = "2-4 business days";

  try {
    const settings: any = await getSiteSettings();
    const s = settings?.shipping || {};
    if (typeof s.freeShippingEnabled === "boolean") freeEnabled = s.freeShippingEnabled;
    if (typeof s.freeShippingThreshold === "number") freeThreshold = s.freeShippingThreshold;
    if (typeof s.standardDeliveryFee === "number") standardFee = s.standardDeliveryFee;
    if (typeof s.expressDeliveryFee === "number") expressFee = s.expressDeliveryFee;
    if (typeof s.estimatedDeliveryDays === "string" && s.estimatedDeliveryDays.trim()) {
      estimatedDelivery = s.estimatedDeliveryDays;
    }
  } catch {
    // Backend unreachable — fall back to the constants above
  }

  if (freeEnabled && subtotal >= freeThreshold) {
    return { method: "free", fee: 0, estimatedDelivery, expressFee };
  }
  return { method: "standard", fee: standardFee, estimatedDelivery, expressFee };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the membership tier for a given loyalty points total. */
export function getMembershipTier(points: number): "silver" | "gold" | "platinum" | "diamond" {
  if (points >= 10000) return "diamond";
  if (points >= 4000)  return "platinum";
  if (points >= 1000)  return "gold";
  return "silver";
}

/** Writes the tier that matches the user's current points balance. */
async function syncMembershipTier(user: any, session?: ClientSession) {
  const points = typeof user.points === "number" && !isNaN(user.points) ? user.points : 0;
  const tier = getMembershipTier(points);

  if (user.member !== tier) {
    await User.findByIdAndUpdate(user._id, { $set: { member: tier } }, { session });
  }
}

/** Order item references may be raw ids or populated documents. */
function orderItemProductId(item: any) {
  const ref = item.productId;
  return typeof ref === "object" && ref !== null && "_id" in ref ? ref._id : ref;
}

/** Loads every ordered product, verifies stock, and builds the priced line items. */
async function buildOrderItems(items: CreateOrderInput["items"]) {
  let subtotal = 0;
  const orderItems = [];

  for (const item of items) {
    const product = await Product.findById(item.productId);
    if (!product) throw new ApiError(404, `Product not found: ${item.productId}`);
    if (product.stockQuantity != null && product.stockQuantity < item.quantity) {
      throw new ApiError(400, `Insufficient stock for ${product.title}`);
    }

    subtotal += product.price * item.quantity;
    orderItems.push({
      productId: product._id,
      // The seller this line belongs to, copied now so a later product edit
      // cannot move a past order to another store.
      vendorId: product.vendorId || null,
      storeId: product.storeId || null,
      title:     product.title,
      price:     product.price,
      quantity:  item.quantity,
      image:     product.image || item.image || "",
    });
  }

  return { orderItems, subtotal };
}

/**
 * An explicit choice from checkout wins; otherwise the fee and delivery window
 * are derived from the live site settings.
 */
async function resolveShipping(subtotal: number, requested?: "free" | "standard" | "express") {
  const resolved = await resolveShippingConfig(subtotal);
  if (!requested) return resolved;

  const fee =
    requested === "free"    ? 0 :
    requested === "express" ? resolved.expressFee :
    resolved.method === "free" ? 0 : resolved.fee;

  return { method: requested, fee, estimatedDelivery: resolved.estimatedDelivery };
}

/** Free-text search over customer name, city, payment method and ids. */
function buildOrderSearchCondition(search: string) {
  const q = search.trim();
  const matches: any[] = [
    { "shippingAddress.fullName": { $regex: q, $options: "i" } },
    { "shippingAddress.city":     { $regex: q, $options: "i" } },
    { paymentMethod:              { $regex: q, $options: "i" } },
  ];
  if (/^[0-9a-fA-F]{24}$/.test(q)) matches.push({ _id: q }, { userId: q });
  return { $or: matches };
}

/**
 * Cancelling: fail the payment, retire any warranty coverage, put the stock
 * back, and — when the order had already been delivered — undo the sale and
 * the loyalty points it paid out.
 */
async function applyCancellation(
  order: any,
  orderId: string,
  previousStatus: string,
  session?: ClientSession
) {
  await Transaction.updateMany(
    { orderId, status: { $ne: "failed" } },
    { $set: { status: "failed" } },
    { session }
  );

  // Errors are left to bubble up: the transaction then rolls the whole
  // cancellation back instead of leaving warranties open on a cancelled order.
  await voidWarrantiesForOrder(orderId, session);

  const wasDelivered = previousStatus === "delivered";

  for (const item of order.items || []) {
    const productId = orderItemProductId(item);
    if (!productId || !item.quantity) continue;

    // Delivery counted this as a sale, so a return undoes the count even for a
    // product that is not stock-tracked.
    if (wasDelivered) {
      await Product.findByIdAndUpdate(
        productId,
        { $inc: { sellCount: -item.quantity } },
        { session }
      );
    }

    // Only a tracked product has a number to give back. The guard keeps `$inc`
    // away from a missing field, which it would otherwise turn into NaN.
    await Product.updateOne(
      { _id: productId, stockQuantity: { $ne: null } },
      { $inc: { stockQuantity: item.quantity } },
      { session }
    );
  }

  // Points spent at checkout are always returned, delivered or not.
  if (order.pointsRedeemed) {
    const refundedUser = await User.findByIdAndUpdate(
      order.userId,
      { $inc: { points: order.pointsRedeemed } },
      { new: true, session }
    );
    if (refundedUser) await syncMembershipTier(refundedUser, session);
  }

  // A code that saved this customer money has its use handed back, so the
  // allowance the seller set is not eaten by an order that never happened.
  await releaseCouponForOrder(order, session);

  if (!wasDelivered || !order.pointsEarned) return;

  // Delivery credited these points, so a return takes them back and re-checks
  // the tier the customer belongs to now.
  const updatedUser = await User.findByIdAndUpdate(
    order.userId,
    { $inc: { points: -order.pointsEarned } },
    { new: true, session }
  );
  if (updatedUser) await syncMembershipTier(updatedUser, session);
}

/**
 * Delivery: settle the payment, then (on the first delivery only) count the
 * sale, credit loyalty points, re-check the tier, and issue warranties.
 */
async function applyDelivery(
  order: any,
  orderId: string,
  previousStatus: string,
  session?: ClientSession
): Promise<IssuedWarranty[]> {
  await Transaction.updateMany(
    { orderId, status: { $ne: "success" } },
    { $set: { status: "success" } },
    { session }
  );

  if (previousStatus === "delivered") return [];

  for (const item of order.items || []) {
    const productId = orderItemProductId(item);
    if (productId && item.quantity) {
      await Product.findByIdAndUpdate(
        productId,
        { $inc: { sellCount: item.quantity } },
        { session }
      );
    }
  }

  const updatedUser = await User.findByIdAndUpdate(
    order.userId,
    { $inc: { points: order.pointsEarned } },
    { new: true, session }
  );

  if (updatedUser) {
    await syncMembershipTier(updatedUser, session);
  }

  // Idempotent — one warranty per (user, product, order). A failure here rolls
  // the delivery back, so retrying it cannot settle the order twice. The
  // summaries are returned so the confirmation email can go out after commit.
  return createWarrantiesForOrder(orderId, order.userId.toString(), order.items || [], session);
}

/**
 * Turns requested loyalty points into a cash discount and takes them off the
 * customer's balance. The guarded update only matches when the balance still
 * covers the request, so two tabs can never spend the same points twice.
 */
async function redeemPoints(
  userId: string,
  subtotal: number,
  requested: number,
  session?: ClientSession
) {
  const pointsToRedeem = Math.floor(requested);

  if (pointsToRedeem < MIN_POINTS_TO_REDEEM) {
    throw new ApiError(400, `Redeem at least ${MIN_POINTS_TO_REDEEM} points`);
  }

  // Points pay for products only - the delivery fee is always collected.
  const maxPointsForOrder = Math.floor(subtotal * POINTS_PER_CURRENCY);
  if (pointsToRedeem > maxPointsForOrder) {
    throw new ApiError(400, "Points can only cover the product total, not the delivery fee");
  }

  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, points: { $gte: pointsToRedeem } },
    { $inc: { points: -pointsToRedeem } },
    { new: true, session }
  );

  if (!updatedUser) {
    throw new ApiError(400, "You do not have enough reward points");
  }

  await syncMembershipTier(updatedUser, session);

  return {
    pointsRedeemed: pointsToRedeem,
    pointsDiscount: pointsToRedeem / POINTS_PER_CURRENCY,
  };
}

// ─── Notification helpers ─────────────────────────────────────────────────────

/** The short "#ORD-A1B2C3" form the dashboard shows for an order. */
function shortOrderNumber(id: unknown): string {
  return `#ORD-${String(id).slice(-6).toUpperCase()}`;
}

/** "$129.00" — the shop trades in one currency, so no formatting table here. */
function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** How a payment method is named in the notification feed. */
const PAYMENT_LABELS: Record<string, string> = {
  cod: "Cash on delivery",
  bkash: "bKash",
  rocket: "Rocket",
  nagad: "Nagad",
};

/** "Nihal Ahmed · 2 items · $129.00" for the order notification line. */
function orderSummary(order: {
  items: { quantity: number }[];
  shippingAddress?: { fullName?: string | null } | null;
  totalAmount: number;
}): string {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  return [
    order.shippingAddress?.fullName,
    `${units} item${units === 1 ? "" : "s"}`,
    money(order.totalAmount),
  ]
    .filter(Boolean)
    .join(" · ");
}

// ─── Create Order ─────────────────────────────────────────────────────────────

/**
 * What a typed code is worth on this basket, or why it is worth nothing.
 *
 * The lines are re-read from the database instead of trusted from the request, so
 * the coupon is judged on the price, the seller and the category that are stored
 * right now — the same reading the cart was shown a moment earlier.
 */
async function priceCouponCode(
  code: string,
  userId: string,
  items: { productId: string; quantity: number }[]
) {
  const lines = await loadCouponLines(items);
  const outcome = await evaluateCoupon({ code, userId, lines });

  return {
    couponId: String(outcome.coupon._id),
    code: outcome.coupon.code as string,
    discount: outcome.discount,
  };
}

export async function createOrder(data: CreateOrderInput, userId: string) {
  if (data.paymentMethod !== "cod" && !data.transactionId) {
    throw new ApiError(400, "Transaction ID required for wallet payments");
  }

  // Pricing only reads, so it stays outside the transaction.
  const { orderItems, subtotal } = await buildOrderItems(data.items);
  const shipping = await resolveShipping(subtotal, data.shippingMethod);
  const pointsRequested = data.pointsToRedeem ?? 0;
  const couponCode = data.couponCode?.trim();

  // The order, its payment row, its first timeline entry, the stock decrement,
  // the points deduction and the cart reset are one unit of work: either all of
  // them land or none.
  const order = await withTransaction(async (session) => {
    // A code is priced inside the transaction too, because the usage counters it
    // reads are the ones it is about to write.
    const coupon = couponCode
      ? await priceCouponCode(couponCode, userId, data.items)
      : null;
    const couponDiscount = coupon?.discount ?? 0;

    // Spending points validates the request and updates the balance, so it runs
    // inside the transaction as well. The coupon goes first, so points are only
    // ever asked to cover what the code left to pay for.
    const redemption = pointsRequested
      ? await redeemPoints(userId, subtotal - couponDiscount, pointsRequested, session)
      : { pointsRedeemed: 0, pointsDiscount: 0 };

    const totalAmount = subtotal - couponDiscount + shipping.fee - redemption.pointsDiscount;
    // Points are earned on what is really paid for the products, never on the
    // part that a code or the customer's own points covered.
    const pointsEarned = Math.floor(
      (subtotal - couponDiscount - redemption.pointsDiscount) * POINTS_PER_DOLLAR
    );

    const order = new Order({
      userId,
      items: orderItems,
      shippingAddress: data.shippingAddress,
      paymentMethod: data.paymentMethod,
      subtotal,
      shippingFee: shipping.fee,
      totalAmount,
      shippingMethod: shipping.method,
      estimatedDelivery: shipping.estimatedDelivery,
      pointsEarned,
      pointsRedeemed: redemption.pointsRedeemed,
      pointsDiscount: redemption.pointsDiscount,
      couponId: coupon?.couponId ?? null,
      couponCode: coupon?.code ?? "",
      couponDiscount,
    });
    await order.save({ session });

    const orderId = order._id.toString();

    // The code is spent in the same unit of work, so an order that rolls back
    // never burns a redemption and every redemption names the order that caused
    // it — which is what lets a cancellation hand the use straight back.
    if (coupon) {
      await redeemCoupon(
        coupon.couponId,
        { orderId, customerId: userId, amount: couponDiscount },
        session
      );
    }

    const reference = data.paymentMethod === "cod" ? `COD-${orderId}` : data.transactionId!;
    await createTransaction(
      { orderId, userId, method: data.paymentMethod, amount: totalAmount, reference },
      session
    );

    // A new order always enters the flow at "confirmed".
    await logOrderStatus(orderId, "confirmed", { session });

    // One row per seller, inside the same unit of work: the customer pays for
    // one checkout, each seller gets their own fulfilment record from it.
    await createVendorOrdersForOrder(order, session);

    for (const item of data.items) {
      // A product saved with no stock quantity is not stock-tracked, so it has
      // no number to lower. The filter skips those rows; without it `$inc`
      // would write NaN into the field.
      await Product.updateOne(
        { _id: item.productId, stockQuantity: { $ne: null } },
        { $inc: { stockQuantity: -item.quantity } },
        { session }
      );
    }
    await Cart.deleteMany({ userId }, { session });

    return order;
  });

  // Written after the commit on purpose: a rolled-back order never shows up as
  // a notification, and a feed problem can never undo a real order.
  const orderRef = order._id.toString();
  const shortNumber = shortOrderNumber(order._id);

  await recordActivity({
    type: "order",
    title: `New order ${shortNumber}`,
    detail: orderSummary(order),
    ref: orderRef,
  });

  // Cash on delivery is not money in hand yet: its payment row starts as
  // "pending" and only settles at delivery, so the line has to say the same
  // thing the transactions screen shows instead of claiming a payment landed.
  const paymentLabel = PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod;
  const isCashOnDelivery = order.paymentMethod === "cod";

  await recordActivity({
    type: "transaction",
    title: isCashOnDelivery
      ? `Cash on delivery order ${shortNumber}`
      : `Payment recorded for ${shortNumber}`,
    detail: isCashOnDelivery
      ? `${paymentLabel} · ${money(order.totalAmount)} due on delivery`
      : `${paymentLabel} · ${money(order.totalAmount)}`,
    ref: orderRef,
  });

  // The customer's own copy of the same event: one line in their feed and the
  // confirmation email. Also post-commit, so a rolled-back order announces
  // nothing.
  await notifyOrderPlaced(order);

  return order;
}

// ─── Get Orders ───────────────────────────────────────────────────────────────

export async function getOrders(query: GetOrdersQuery) {
  const { userId, status, search, sort, page, limit } = query;
  const conditions: any[] = [];

  if (userId) conditions.push({ userId });
  if (status && status !== "all") conditions.push({ orderStatus: status.toLowerCase() });

  if (search?.trim()) conditions.push(buildOrderSearchCondition(search));

  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest:     { createdAt: -1 },
    oldest:     { createdAt:  1 },
    total_asc:  { totalAmount:  1 },
    total_desc: { totalAmount: -1 },
  };
  const sortCriteria = sortMap[sort ?? ""] ?? { createdAt: -1 };

  const skip = (page - 1) * limit;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .populate("userId", "name email image avatar")
      .populate("items.productId")
      .sort(sortCriteria)
      .skip(skip)
      .limit(limit),
    Order.countDocuments(filter),
  ]);

  // Whether a rider already holds the job decides what the store may still do to
  // an order, and the status menu lives on this list. So the live claim comes
  // with the rows in one extra read instead of a call per order.
  const ids = orders.map((order) => order._id);
  let claims: any[] = [];
  if (ids.length) {
    claims = await Delivery.find({
      orderId: { $in: ids },
      status: { $in: LIVE_DELIVERY_STATUSES },
    })
      .select("orderId status fee expiresAt riderId")
      .populate("riderId", "name")
      .lean();
  }
  const claimByOrder = new Map<string, any>(
    claims.map((row) => [String(row.orderId), row] as [string, any])
  );

  return {
    orders: orders.map((order) => {
      const claim = claimByOrder.get(String(order._id));
      return {
        ...order.toObject(),
        delivery: claim
          ? {
              _id: String(claim._id),
              status: claim.status,
              fee: claim.fee ?? 0,
              expiresAt: claim.expiresAt ?? null,
              // An offer nobody answered is not a claim. The sweep closes it in
              // a moment, but the store cannot be locked out of an order until
              // then, so the row says which of the two it is.
              holds: !isLapsedOffer(claim),
              rider: claim.riderId ? { name: (claim.riderId as any)?.name || "" } : null,
            }
          : null,
      };
    }),
    total,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

// ─── Get Order By ID ──────────────────────────────────────────────────────────

export async function getOrderById(id: string) {
  const order = await Order.findById(id)
    .populate("userId", "name email image avatar")
    .populate("items.productId");
  if (!order) throw new ApiError(404, "Order not found");

  const transaction = await getLatestTransactionForOrder(id);

  // The live job beside the sale: who is carrying it and how far it got. The
  // order itself never stores that, so a reassignment cannot rewrite history.
  const delivery = await Delivery.findOne({
    orderId: id,
    status: { $in: LIVE_DELIVERY_STATUSES },
  })
    .populate("riderId", "name phone vehicleType vehicleNumber")
    .lean();

  return {
    ...order.toObject(),
    transactionId: transaction?.reference,
    paymentStatus: transaction?.status,
    delivery: delivery
      ? {
          _id: String(delivery._id),
          status: delivery.status,
          fee: delivery.fee ?? 0,
          expiresAt: delivery.expiresAt ?? null,
          holds: !isLapsedOffer(delivery),
          rider: delivery.riderId
            ? {
                name: (delivery.riderId as any)?.name || "",
                phone: (delivery.riderId as any)?.phone || "",
                vehicleType: (delivery.riderId as any)?.vehicleType || "",
                vehicleNumber: (delivery.riderId as any)?.vehicleNumber || "",
              }
            : null,
        }
      : null,
  };
}

// ─── Update Order Status (Admin) ──────────────────────────────────────────────

export async function updateOrderStatus(
  id: string,
  data: UpdateOrderStatusInput,
  changedBy?: string,
  /**
   * Who is behind this change, and what that lets it past the two closing gates.
   *
   * `byRider` is the code read at the door. `byCustomer` is the customer saying
   * the parcel arrived, which is the same fact from the other side of the
   * counter. Both are confirmations of a hand-over, so neither is held back by a
   * rider still carrying the job or by an older report from the buyer; an admin
   * changing the stage gets neither, and has to deal with whoever is on the job.
   */
  options: { byRider?: boolean; byCustomer?: boolean } = {}
) {
  // Warranty confirmations are collected inside the transaction but only sent
  // after it commits, so a rolled-back delivery never announces coverage that
  // does not exist.
  let issuedWarranties: IssuedWarranty[] = [];
  // The status before this change, needed by the feed outside the transaction.
  let previousStatus = "";
  // Re-selecting the same stage is a no-op, and a no-op must not be announced.
  let statusChanged = false;

  // The status write, the timeline entry and the settlement side effects must
  // not be left half-applied if one of them fails.
  const updated = await withTransaction(async (session) => {
    // Reads need the explicit session, otherwise they may see data from
    // before the transaction started. Writes just take a `{ session }` option,
    // which is harmless when there is no session.
    const order = session
      ? await Order.findById(id).session(session)
      : await Order.findById(id);
    if (!order) throw new ApiError(404, "Order not found");
    previousStatus = order.orderStatus;

    // Re-selecting the current stage is a no-op, not a new timeline row.
    if (order.orderStatus === data.orderStatus) return order;

    if (!isAllowedTransition(order.orderStatus, data.orderStatus)) {
      const allowed = nextStatuses(order.orderStatus);
      throw new ApiError(
        400,
        allowed.length > 0
          ? `A ${order.orderStatus} order can only move to: ${allowed.join(", ")}`
          : `This order is ${order.orderStatus} and can no longer be changed`
      );
    }

    // A parcel only leaves the store with somebody carrying it: the rider has
    // to be offered the job first, and the offer has to still be alive.
    if (data.orderStatus === "shipped") {
      const riderReady = await Delivery.findOne({
        orderId: id,
        status: { $in: LIVE_DELIVERY_STATUSES },
        $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      })
        .select("_id")
        .session(session ?? null);

      if (!riderReady) {
        throw new ApiError(
          400,
          "Assign a rider before marking this order shipped. Open the order and choose Ship with a rider."
        );
      }
    }

    // The last mile belongs to whoever is carrying it. Once a rider has been
    // handed the job — offered it and still answering, or already working it —
    // the store cannot close the sale or call it off behind that person's back.
    // Stopping the job is a separate, deliberate step: cancel the delivery
    // first, and the order is the store's again. A request nobody answered is
    // not a claim, so the expiry is read here rather than trusting the sweep.
    //
    // The customer's own cancellation is the one case where the store is only
    // executing what the buyer asked for, so a rider is stood down instead of
    // holding the order open.
    if (
      !options.byRider &&
      !options.byCustomer &&
      (data.orderStatus === "delivered" || data.orderStatus === "cancelled") &&
      !(data.orderStatus === "cancelled" && order.customerResponse === "cancelled")
    ) {
      const claim = await Delivery.findOne({
        orderId: id,
        status: { $in: LIVE_DELIVERY_STATUSES },
      })
        .select("_id status expiresAt")
        .session(session ?? null)
        .lean();

      if (claim && !isLapsedOffer(claim)) {
        throw new ApiError(
          400,
          claim.status === "assigned"
            ? "A rider has been offered this job and has not answered yet. Cancel the delivery first if this order has to be called off."
            : "A rider is carrying this delivery, so only the rider can close it. Cancel the delivery first if this order has to be called off."
        );
      }
    }

    // The customer said the parcel never arrived, or that they called it off,
    // so the store marking it delivered would contradict them. A rider with the
    // code and a customer confirming the hand-over are the exceptions on
    // purpose: each is the buyer's own answer, newer than a report typed hours
    // earlier, which is exactly what the report is for.
    if (
      !options.byRider &&
      !options.byCustomer &&
      data.orderStatus === "delivered" &&
      (order.customerResponse === "not_received" || order.customerResponse === "cancelled")
    ) {
      throw new ApiError(
        400,
        `The customer reported "${order.customerResponse}", so this order cannot be marked delivered`
      );
    }

    // Orders answered before the report stopped asking still carry "received".
    // That answer says the parcel is in the customer's hands, so it cannot be
    // cancelled afterwards.
    if (
      order.orderStatus === "shipped" &&
      data.orderStatus === "cancelled" &&
      order.customerResponse === "received"
    ) {
      throw new ApiError(
        400,
        "The customer already confirmed this order as received, so it can only be marked delivered"
      );
    }

    const updated = await Order.findByIdAndUpdate(id, data, { new: true, session });
    if (!updated) throw new ApiError(404, "Order not found");
    statusChanged = true;

    await logOrderStatus(id, data.orderStatus, { session, changedBy });

    // The seller rows carry the same shipping stage, so a vendor's board never
    // keeps saying "ready" after the parcel has left the store.
    await syncVendorOrdersForParentStatus(id, data.orderStatus, session ?? undefined);

    // Settle the side effects of the new status. These need the *previous*
    // status, which is why the original document is kept around.
    if (data.orderStatus === "cancelled") {
      await applyCancellation(order, id, order.orderStatus, session);

      // The rider is standing down: the job they were offered no longer has a
      // parcel. A cancelled row keeps the history without blocking a future
      // assignment, because the one-live-job index ignores finished rows.
      await Delivery.updateMany(
        { orderId: id, status: { $in: LIVE_DELIVERY_STATUSES } },
        {
          $set: { status: "cancelled", cancelledAt: new Date() },
          $push: {
            history: {
              status: "cancelled",
              at: new Date(),
              note:
                order.customerResponse === "cancelled"
                  ? "Order cancelled by the customer"
                  : "Order cancelled by the store",
              by: changedBy ?? null,
            },
          },
        },
        { session }
      );
    }

    if (data.orderStatus === "delivered") {
      issuedWarranties = await applyDelivery(updated, id, order.orderStatus, session);
    }

    return updated;
  });

  // Cash on delivery settles at the door. applyDelivery just flipped its
  // payment row to "success", so this is the moment a payment really was
  // recorded — the checkout only promised one.
  const wasDelivered = previousStatus === "delivered";
  if (data.orderStatus === "delivered" && !wasDelivered && updated.paymentMethod === "cod") {
    await recordActivity({
      type: "transaction",
      title: `Payment collected for ${shortOrderNumber(updated._id)}`,
      detail: `Cash on delivery · ${money(updated.totalAmount)}`,
      ref: updated._id.toString(),
    });
  }

  if (issuedWarranties.length) {
    await notifyWarrantiesIssued(updated, issuedWarranties);
    await recordActivity({
      type: "warranty",
      title: `${issuedWarranties.length} warranty record${
        issuedWarranties.length === 1 ? "" : "s"
      } issued`,
      detail: `Order ${shortOrderNumber(updated._id)} was delivered`,
      ref: updated._id.toString(),
    });
  }

  // The customer is told about every stage they can see, after the commit.
  if (statusChanged) {
    await notifyOrderStatusChanged(updated, data.orderStatus);
  }

  return updated;
}

// ─── Customer Order Response ───────────────────────────────────────────────────

/**
 * What the customer says about an order, and how long they may keep saying it.
 *
 * Three answers: not received yet, cancelled, and received. None of them is
 * final on its own, because a parcel reported missing can still turn up and a
 * hand-over described in the moment can be corrected the next day. The report
 * stays open through delivery and after it, and closes only when the order
 * itself is called off and refunded — after that there is no outcome left to
 * describe, and the conversation belongs to support.
 *
 * "Received" is the customer's own version of reading the code at the door, so
 * it does what the code does: the order settles, the rider's job closes, and the
 * fee the store set on that job is booked as paid. It is the one answer with
 * side effects, which is why it cannot be given while the parcel is still on the
 * shelf — nobody can confirm the arrival of something that has not left.
 */
export async function updateCustomerResponse(
  id: string,
  data: CustomerResponseInput,
  requester?: { id?: string; role?: string }
) {
  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, "Order not found");

  assertOwnerOrAdmin(order.userId, requester, "You are not authorized to respond to this order");

  // A cancelled order has been refunded and written off. Nothing the buyer says
  // afterwards can reopen it.
  if (order.orderStatus === "cancelled") {
    throw new ApiError(400, "This order is already cancelled");
  }

  const wasDelivered = order.orderStatus === "delivered";
  const leftTheStore = wasDelivered || order.orderStatus === "shipped";

  // Both answers about the parcel describe something that has left the store, so
  // neither can be given while it is still being packed. Somebody who changed
  // their mind before that cancels instead.
  if (data.response !== "cancelled" && !leftTheStore) {
    throw new ApiError(
      400,
      "Only a shipped order can be reported as received or not received. Cancel this order if you changed your mind."
    );
  }

  order.customerResponse     = data.response;
  order.customerResponseNote = data.note ?? order.customerResponseNote;
  order.customerResponseAt   = new Date();
  await order.save();

  /*
   * Reading the jobs before anything is written, so each rider can be told what
   * closed theirs. Only a job somebody is actually riding has a fee to pay: an
   * offer nobody answered is not work done, and a job the store already stopped
   * has nothing left to settle, so both stay out of the payout record.
   */
  const closesTheSale = data.response === "received" && !wasDelivered;
  const paidJobs = closesTheSale
    ? await Delivery.find({ orderId: id, status: { $in: ACTIVE_DELIVERY_STATUSES } })
        .select("_id riderId fee")
        .lean()
    : [];

  if (closesTheSale) {
    // The order first, exactly as the code path does it: settling the sale is
    // what pays the rider, issues the warranties and converts the points, and
    // closing an order that is already delivered is a no-op — so a second click
    // or a retried request cannot book the fee twice.
    await updateOrderStatus(id, { orderStatus: "delivered" }, requester?.id, {
      byCustomer: true,
    });

    const now = new Date();
    await Delivery.updateMany(
      { orderId: id, status: { $in: ACTIVE_DELIVERY_STATUSES } },
      {
        $set: { status: "delivered", deliveredAt: now, feePaidVia: "customer" },
        $push: {
          history: {
            status: "delivered",
            at: now,
            note: "Confirmed received by the customer",
            by: requester?.id ?? null,
          },
        },
      }
    );
  }

  const noteLog = data.note ? ` - "${data.note}"` : "";
  await logOrderStatus(id, closesTheSale ? "delivered" : order.orderStatus, {
    note: `Customer response: ${data.response}${noteLog}`,
    changedBy: requester?.id,
  });

  // A cancellation is the one status change the admin did not make, so it gets
  // its own line in the notification feed. The order is not cancelled yet: the
  // store has to act on it, which is what the line has to say.
  if (data.response === "cancelled") {
    await recordActivity({
      type: "order_cancelled",
      title: `Order ${shortOrderNumber(order._id)} cancellation requested`,
      detail: data.note
        ? `Reason: ${data.note}`
        : "No reason given. Cancel the order to refund it, or the rider will deliver it.",
      ref: order._id.toString(),
    });
  }

  /*
   * A hand-over confirmed by the buyer is money leaving the store, so the store
   * board says so on the same line it uses for every other delivery: what was
   * paid, and to whom. The rider is told separately, because a rider who is
   * still riding to an address that has just been signed for needs to know.
   */
  if (closesTheSale && paidJobs.length > 0) {
    const paidTotal = paidJobs.reduce((sum, job) => sum + Number(job.fee || 0), 0);
    const riders = paidJobs
      .map((job) => String(job.riderId))
      .filter((riderId) => riderId.length > 0);

    await recordActivity({
      type: "delivery",
      title: `Delivery ${shortOrderNumber(order._id)} confirmed by the customer`,
      detail: `${money(paidTotal)} paid to the rider · deducted from the store's profit`,
      ref: order._id.toString(),
    });

    await Promise.all(
      riders.map((riderId) =>
        notifyUser({
          userId: riderId,
          role: "rider",
          type: "delivery_update",
          title: `Delivery ${shortOrderNumber(order._id)} was signed for`,
          detail: "The customer confirmed the parcel themselves, so your job is closed and the fee is booked to your earnings.",
          ref: String(paidJobs.find((job) => String(job.riderId) === riderId)?._id ?? ""),
        })
      )
    );
  }

  // The stages above rewrote the row, so the caller gets what is actually stored.
  if (closesTheSale) {
    const settled = await Order.findById(id).lean();
    if (settled) return settled;
  }
  return order;
}