import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { Product } from "../product/product.model";
import { Order } from "../order/order.model";
import { Delivery } from "../delivery/delivery.model";
import { recordActivity } from "../activity/activity.service";
import { notifyAdminDeliveryEmail } from "../activity/activity.notifications";
import { updateOrderStatus } from "../order/order.service";
import { VendorOrder, VENDOR_ORDER_STATUSES, type VendorOrderStatus } from "./vendor-order.model";
import type { VendorOrderQuery, VendorOrderStatusInput } from "./vendor-order.validator";

/**
 * The seller's side of an order.
 *
 * Every read starts from `{ vendorId }` taken out of the token, and every write
 * loads the row with that same filter, so another seller's group answers 404
 * exactly like a made-up id. The parent order keeps owning the money, the
 * customer and delivery; this module only moves the seller's own fulfilment
 * forward, and it refuses to touch an order that was already cancelled or
 * delivered.
 */

/** Statuses the seller is still working on. */
const ACTIVE_STATUSES: VendorOrderStatus[] = ["accepted", "processing", "ready_for_shipment"];

/** Which moves a seller may make from the current status. */
const VENDOR_TRANSITIONS: Record<string, VendorOrderStatus[]> = {
  // One answer, and then the store takes the parcel over: saying yes is the
  // seller's whole job on an order, so there is no preparing stage for them to
  // drive afterwards. A rider is put on it from the store's board.
  pending: ["accepted", "rejected"],
};

function assertObjectId(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "Order not found");
}

/** The parent order, when the list or detail read populated it. */
function parentOf(value: any) {
  return value && typeof value === "object" && "_id" in value ? value : null;
}

function iso(value?: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

/** A group as the vendor screens read it. */
export function toVendorOrderDto(row: any) {
  const parent = parentOf(row.orderId);
  const rider = parentOf(row.riderId);

  return {
    _id: String(row._id),
    orderId: String(parent?._id ?? row.orderId),
    orderNumber: row.orderNumber || "",
    status: row.status as VendorOrderStatus,
    rejectionReason: row.rejectionReason || "",
    items: (row.items || []).map((item: any) => ({
      productId: String(item.productId?._id ?? item.productId),
      title: item.title || "Item",
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
      image: item.image || item.productId?.image || "",
    })),
    subtotal: Number(row.subtotal) || 0,
    customerName: row.customerName || parent?.shippingAddress?.fullName || "",
    customerPhone: row.customerPhone || parent?.shippingAddress?.phone || "",
    city: row.city || parent?.shippingAddress?.city || "",
    paymentMethod: row.paymentMethod || parent?.paymentMethod || "",
    parentStatus: parent?.orderStatus || null,
    totalAmount: parent ? Number(parent.totalAmount) || 0 : null,
    shippingAddress: parent?.shippingAddress || null,
    estimatedDelivery: parent?.estimatedDelivery || "",
    placedAt: iso(row.createdAt),
    pickupRequestedAt: iso(row.pickupRequestedAt),
    deliveryId: row.deliveryId ? String(row.deliveryId) : null,
    rider: rider
      ? {
          _id: String(rider._id),
          name: rider.name || "",
          phone: rider.phone || "",
          vehicleType: rider.vehicleType || "",
          vehicleNumber: rider.vehicleNumber || "",
        }
      : null,
    history: (row.history || []).map((event: any) => ({
      status: event.status as VendorOrderStatus,
      at: iso(event.at),
      note: event.note || "",
    })),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** The seller's incoming orders, filtered and paged. */
export async function listMyVendorOrders(vendorId: string, query: VendorOrderQuery) {
  const { status, search, page, limit } = query;
  const conditions: any[] = [{ vendorId: new Types.ObjectId(vendorId) }];

  if (status === "active") {
    conditions.push({ status: { $in: ACTIVE_STATUSES } });
  } else if (status === "completed") {
    conditions.push({ status: { $in: ["shipped", "delivered"] } });
  } else if (status !== "all") {
    conditions.push({ status });
  }

  if (search) {
    const q = search.trim();
    const matches: any[] = [
      { orderNumber: { $regex: q, $options: "i" } },
      { customerName: { $regex: q, $options: "i" } },
      { city: { $regex: q, $options: "i" } },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(q)) matches.push({ _id: q }, { orderId: q });
    conditions.push({ $or: matches });
  }

  const filter = { $and: conditions };

  const [rows, total, counts] = await Promise.all([
    VendorOrder.find(filter)
      .populate("orderId", "orderStatus totalAmount paymentMethod shippingAddress estimatedDelivery")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    VendorOrder.countDocuments(filter),
    VendorOrder.aggregate([
      { $match: { vendorId: new Types.ObjectId(vendorId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const typeCounts: Record<string, number> = {};
  for (const row of counts) typeCounts[row._id] = row.count;

  return {
    orders: rows.map(toVendorOrderDto),
    total,
    typeCounts,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * One group plus the live delivery carrying it.
 *
 * The group is loaded with `{ _id, vendorId }`, so a guessed id belonging to
 * another seller is indistinguishable from an id that does not exist.
 */
export async function getMyVendorOrder(vendorId: string, id: string) {
  assertObjectId(id);

  const row = await VendorOrder.findOne({
    _id: new Types.ObjectId(id),
    vendorId: new Types.ObjectId(vendorId),
  })
    .populate("orderId", "orderStatus totalAmount paymentMethod shippingAddress estimatedDelivery createdAt")
    .populate("riderId", "name phone vehicleType vehicleNumber")
    .lean();

  if (!row) throw new ApiError(404, "Order not found");

  const dto = toVendorOrderDto(row);

  // The live job is read from the delivery row rather than trusted from the
  // group, so a rider who cancelled is reflected immediately.
  let delivery: { status: string; rider: any; expiresAt: string | null } | null = null;
  if (row.deliveryId) {
    const job = await Delivery.findById(row.deliveryId)
      .populate("riderId", "name phone vehicleType vehicleNumber")
      .lean();
    if (job) {
      const rider = parentOf(job.riderId);
      delivery = {
        status: job.status,
        rider: rider
          ? {
              _id: String(rider._id),
              name: rider.name || "",
              phone: rider.phone || "",
              vehicleType: rider.vehicleType || "",
              vehicleNumber: rider.vehicleNumber || "",
            }
          : null,
        expiresAt: iso(job.expiresAt ?? null),
      };
    }
  }

  return { ...dto, delivery };
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/** Puts the rejected lines' stock back, exactly like an order cancellation. */
async function restockItems(items: any[]) {
  for (const item of items || []) {
    if (!item.productId || !item.quantity) continue;
    await Product.updateOne(
      { _id: item.productId, stockQuantity: { $ne: null } },
      { $inc: { stockQuantity: item.quantity } }
    );
  }
}

/**
 * Moves the seller's group one step forward.
 *
 * The status is re-read with the vendor filter and the legal next steps are
 * checked before writing, so a stale tab cannot skip a stage. Rejecting is the
 * one step that changes stock: the lines go back on the shelf and the store
 * team is told, because the money side of a partial rejection is theirs.
 */
export async function updateMyVendorOrderStatus(
  vendorId: string,
  id: string,
  input: VendorOrderStatusInput
) {
  assertObjectId(id);

  const row = await VendorOrder.findOne({
    _id: new Types.ObjectId(id),
    vendorId: new Types.ObjectId(vendorId),
  });
  if (!row) throw new ApiError(404, "Order not found");

  const parent = await Order.findById(row.orderId).select("orderStatus").lean();
  if (!parent) throw new ApiError(404, "Order not found");
  if (parent.orderStatus === "cancelled" || parent.orderStatus === "delivered") {
    throw new ApiError(400, `This order is already ${parent.orderStatus} and cannot be changed`);
  }

  const allowed = VENDOR_TRANSITIONS[row.status] || [];
  if (!allowed.includes(input.status)) {
    throw new ApiError(
      400,
      allowed.length
        ? `A ${row.status.replace(/_/g, " ")} order can only move to: ${allowed
            .map((value) => value.replace(/_/g, " "))
            .join(", ")}`
        : `This order is ${row.status.replace(/_/g, " ")} and can no longer be changed`
    );
  }

  const reason = (input.reason || "").trim();
  if (input.status === "rejected" && reason.length < 5) {
    throw new ApiError(400, "Tell us why you cannot fulfil this order (at least 5 characters)");
  }

  const previous = row.status;
  row.status = input.status;
  if (input.status === "rejected") row.rejectionReason = reason;
  // Accepting is the seller asking for a rider: the parcel waits on the counter
  // until the store puts one on it, and that clock starts now.
  if (input.status === "accepted" && !row.pickupRequestedAt) {
    row.pickupRequestedAt = new Date();
  }
  row.history.push({
    status: input.status,
    at: new Date(),
    note: input.status === "rejected" ? reason : "",
    by: new Types.ObjectId(vendorId),
  });
  await row.save();

  if (input.status === "rejected") {
    await restockItems(row.items);
  }

  await recordActivity({
    type: input.status === "accepted" ? "delivery" : "vendor",
    title:
      input.status === "accepted"
        ? `${row.orderNumber || "Order"} accepted by the seller — assign a rider`
        : `${row.orderNumber || "Order"} rejected by the seller`,
    detail:
      input.status === "rejected"
        ? reason
        : `${row.customerName || "Customer"} · ${row.city || "—"} · ${row.items.length} item${
            row.items.length === 1 ? "" : "s"
          } · the store assigns the rider`,
    ref: String(row.orderId),
  });

  /*
   * An accepted order is the store's to move from here. It gets one line in the
   * shared feed (above) and one email, so the team is asked for a rider even
   * when nobody has the board open, and the parent leaves "confirmed" so it
   * shows up in the lane that still needs somebody carrying it.
   */
  if (input.status === "accepted") {
    await notifyAdminDeliveryEmail({
      heading: "A seller accepted an order",
      intro: `${row.orderNumber || "An order"} is waiting for a rider. Assign one from the orders board.`,
      orderNumber: row.orderNumber || "",
      rows: [
        { label: "Customer", value: row.customerName || "Customer" },
        { label: "City", value: row.city || "—" },
        { label: "Items", value: row.items.length },
        { label: "Your subtotal", value: row.subtotal },
      ],
      note: "The seller has nothing left to do: the parcel ships when the rider accepts.",
      actionLabel: "Open accepted orders",
      actionPath: "/dashboard/admin/orders?vendor=accepted",
    });

    if (parent.orderStatus === "confirmed") {
      await updateOrderStatus(String(row.orderId), { orderStatus: "processing" }, vendorId);
    }
  }

  // The store goes through the same read the screens use, so the response and
  // the next page render agree.
  return getMyVendorOrder(vendorId, String(row._id));
}

/** Counts the seller's live work for the overview card. */
export async function getVendorOrderSummary(vendorId: string) {
  const [pending, active, completed, total] = await Promise.all([
    VendorOrder.countDocuments({ vendorId, status: "pending" }),
    VendorOrder.countDocuments({ vendorId, status: { $in: ACTIVE_STATUSES } }),
    VendorOrder.countDocuments({ vendorId, status: { $in: ["shipped", "delivered"] } }),
    VendorOrder.countDocuments({ vendorId }),
  ]);

  return { pending, active, completed, total };
}

/** Kept for callers that need the enum list without importing the model. */
export const vendorOrderStatuses = VENDOR_ORDER_STATUSES;
