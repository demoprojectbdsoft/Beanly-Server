import { Order } from "./order.model";
import { Product } from "../product/product.model";
import { Cart } from "../cart/cart.model";
import { User } from "../user/user.model";
import { Transaction } from "../transaction/transaction.model";
import { ApiError } from "../../utils/apiError";
import { CreateOrderInput, UpdateOrderStatusInput, CustomerResponseInput, GetOrdersQuery } from "./order.validator";
import { logOrderStatus } from "../order-status/order-status.service";
import { createTransaction, getLatestTransactionForOrder } from "../transaction/transaction.service";

// ─── Constants ────────────────────────────────────────────────────────────────

const SHIPPING_FEE       = 15.0;
const FREE_SHIPPING_FROM = 50.0;
const POINTS_PER_DOLLAR  = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the membership tier for a given loyalty points total. */
export function getMembershipTier(points: number): "silver" | "gold" | "platinum" | "diamond" {
  if (points >= 10000) return "diamond";
  if (points >= 4000)  return "platinum";
  if (points >= 1000)  return "gold";
  return "silver";
}

// ─── Create Order ─────────────────────────────────────────────────────────────

export async function createOrder(data: CreateOrderInput) {
  if (data.paymentMethod !== "cod" && !data.transactionId) {
    throw new ApiError(400, "Transaction ID required for wallet payments");
  }

  // Build order items and calculate subtotal
  let subtotal = 0;
  const orderItems = [];

  for (const item of data.items) {
    const product = await Product.findById(item.productId);
    if (!product) throw new ApiError(404, `Product not found: ${item.productId}`);
    if (product.stockQuantity != null && product.stockQuantity < item.quantity) {
      throw new ApiError(400, `Insufficient stock for ${product.title}`);
    }

    subtotal += product.price * item.quantity;
    orderItems.push({
      productId: product._id,
      title:     product.title,
      price:     product.price,
      quantity:  item.quantity,
      image:     product.image || item.image || "",
    });
  }

  const shippingFee   = subtotal >= FREE_SHIPPING_FROM ? 0 : SHIPPING_FEE;
  const totalAmount   = subtotal + shippingFee;
  const pointsEarned  = Math.floor(subtotal * POINTS_PER_DOLLAR);

  // Save order
  const order = await Order.create({
    userId: data.userId,
    items: orderItems,
    shippingAddress: data.shippingAddress,
    paymentMethod: data.paymentMethod,
    subtotal,
    shippingFee,
    totalAmount,
    pointsEarned,
  });

  // Create transaction record
  const reference = data.paymentMethod === "cod" ? `COD-${order._id}` : data.transactionId!;
  await createTransaction({
    orderId:  order._id.toString(),
    userId:   data.userId,
    method:   data.paymentMethod,
    amount:   totalAmount,
    reference,
  });

  // Log initial status
  await logOrderStatus(order._id.toString(), "processing");

  // Deduct stock and clear cart
  for (const item of data.items) {
    await Product.findByIdAndUpdate(item.productId, { $inc: { stockQuantity: -item.quantity } });
  }
  await Cart.deleteMany({ userId: data.userId });

  return order;
}

// ─── Get Orders ───────────────────────────────────────────────────────────────

export async function getOrders(query: GetOrdersQuery) {
  const { userId, status, search, sort, page, limit } = query;
  const conditions: any[] = [];

  if (userId) conditions.push({ userId });
  if (status && status !== "all") conditions.push({ orderStatus: status.toLowerCase() });

  if (search?.trim()) {
    const q = search.trim();
    const searchOr: any[] = [
      { "shippingAddress.fullName": { $regex: q, $options: "i" } },
      { "shippingAddress.city":     { $regex: q, $options: "i" } },
      { paymentMethod:              { $regex: q, $options: "i" } },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(q)) searchOr.push({ _id: q }, { userId: q });
    conditions.push({ $or: searchOr });
  }

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

  return {
    orders,
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

  return {
    ...order.toObject(),
    transactionId: transaction?.reference,
    paymentStatus: transaction?.status,
  };
}

// ─── Update Order Status (Admin) ──────────────────────────────────────────────

export async function updateOrderStatus(id: string, data: UpdateOrderStatusInput) {
  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, "Order not found");

  // Cannot cancel a shipped order until the customer has responded
  if (order.orderStatus === "shipped" && data.orderStatus === "cancelled" && !order.customerResponse) {
    throw new ApiError(400, "Customer must respond before a shipped order can be cancelled");
  }

  const updated = await Order.findByIdAndUpdate(id, data, { new: true });
  if (!updated) throw new ApiError(404, "Order not found");

  await logOrderStatus(id, data.orderStatus);

  // On cancel → mark transaction failed
  if (data.orderStatus === "cancelled") {
    await Transaction.updateMany(
      { orderId: id, status: { $ne: "failed" } },
      { $set: { status: "failed" } }
    );
  }

  // On delivered → mark transaction success + credit loyalty points (once)
  if (data.orderStatus === "delivered") {
    await Transaction.updateMany(
      { orderId: id, status: { $ne: "success" } },
      { $set: { status: "success" } }
    );

    if (order.orderStatus !== "delivered") {
      const updatedUser = await User.findByIdAndUpdate(
        updated.userId,
        { $inc: { points: updated.pointsEarned } },
        { new: true }
      );

      if (updatedUser) {
        const points  = typeof updatedUser.points === "number" && !isNaN(updatedUser.points) ? updatedUser.points : 0;
        const newTier = getMembershipTier(points);
        if (updatedUser.member !== newTier) {
          await User.findByIdAndUpdate(updated.userId, { $set: { member: newTier } });
        }
      }
    }
  }

  return updated;
}

// ─── Customer Order Response ───────────────────────────────────────────────────

export async function updateCustomerResponse(
  id: string,
  data: CustomerResponseInput,
  userId?: string,
  userRole?: string
) {
  const order = await Order.findById(id);
  if (!order) throw new ApiError(404, "Order not found");

  if (userRole !== "admin" && userId && order.userId.toString() !== userId) {
    throw new ApiError(403, "You are not authorized to respond to this order");
  }

  if (order.orderStatus !== "shipped") {
    throw new ApiError(400, "Response can only be submitted when the order is shipped");
  }

  order.customerResponse     = data.response;
  order.customerResponseNote = data.note ?? order.customerResponseNote;
  order.customerResponseAt   = new Date();
  await order.save();

  const noteLog = data.note ? ` - "${data.note}"` : "";
  await logOrderStatus(id, order.orderStatus, `Customer response: ${data.response}${noteLog}`);

  return order;
}