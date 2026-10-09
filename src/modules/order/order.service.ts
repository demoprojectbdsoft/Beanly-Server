import { Order } from "./order.model";
import { Product } from "../product/product.model";
import { Cart } from "../cart/cart.model";
import { User } from "../user/user.model";
import { ApiError } from "../../utils/apiError";
import { CreateOrderInput, UpdateOrderStatusInput, GetOrdersQuery } from "./order.validator";
import { logOrderStatus } from "../order-status/order-status.service";
import { createTransaction, getLatestTransactionForOrder } from "../transaction/transaction.service";

const STANDARD_SHIPPING_FEE = 15.0;
const FREE_SHIPPING_THRESHOLD = 50.0;
const POINTS_PER_DOLLAR = 1;

/**
 * Calculates customer membership tier according to loyalty points:
 * - Silver:   0 – 999
 * - Gold:     1,000 – 3,999
 * - Platinum: 4,000 – 9,999
 * - Diamond:  10,000+
 */
export function getMembershipTier(points: number): "silver" | "gold" | "platinum" | "diamond" {
  if (points >= 10000) return "diamond";
  if (points >= 4000) return "platinum";
  if (points >= 1000) return "gold";
  return "silver";
}

export async function createOrder(data: CreateOrderInput) {
  if (data.paymentMethod !== "cod" && !data.transactionId) {
    throw new ApiError(400, "Transaction ID required for wallet payments");
  }

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
      title: product.title,
      price: product.price,
      quantity: item.quantity,
      image: product.image || item.image || "",
    });
  }

  const shippingFee = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING_FEE;
  const totalAmount = subtotal + shippingFee;
  const pointsEarned = Math.floor(subtotal * POINTS_PER_DOLLAR);

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

  const reference = data.paymentMethod === "cod" ? `COD-${order._id}` : data.transactionId!;
  await createTransaction({
    orderId: order._id.toString(),
    userId: data.userId,
    method: data.paymentMethod,
    amount: totalAmount,
    reference,
  });

  await logOrderStatus(order._id.toString(), "processing");

  for (const item of data.items) {
    await Product.findByIdAndUpdate(item.productId, { $inc: { stockQuantity: -item.quantity } });
  }

  await Cart.deleteMany({ userId: data.userId });

  // pointsEarned is calculated and locked onto the order now, but NOT credited
  // to the user yet — that only happens once an admin marks the order "delivered"
  // (see updateOrderStatus below), so a cancelled/undelivered order never pays out.

  return order;
}

export async function getOrders(query: GetOrdersQuery) {
  const { userId, status, search, sort, page, limit } = query;
  const conditions: any[] = [];

  if (userId) conditions.push({ userId });
  if (status && status !== "all") conditions.push({ orderStatus: status.toLowerCase() });

  if (search?.trim()) {
    const q = search.trim();
    const isId = /^[0-9a-fA-F]{24}$/.test(q);
    const searchOr: any[] = [
      { "shippingAddress.fullName": { $regex: q, $options: "i" } },
      { "shippingAddress.city": { $regex: q, $options: "i" } },
      { paymentMethod: { $regex: q, $options: "i" } },
    ];
    if (isId) searchOr.push({ _id: q }, { userId: q });
    conditions.push({ $or: searchOr });
  }

  const filter = conditions.length > 0 ? { $and: conditions } : {};

  const sortMap: Record<string, Record<string, 1 | -1>> = {
    newest: { createdAt: -1 },
    oldest: { createdAt: 1 },
    total_asc: { totalAmount: 1 },
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

export async function updateOrderStatus(id: string, data: UpdateOrderStatusInput) {
  const existingOrder = await Order.findById(id);
  if (!existingOrder) throw new ApiError(404, "Order not found");

  const order = await Order.findByIdAndUpdate(id, data, { new: true });
  if (!order) throw new ApiError(404, "Order not found");

  await logOrderStatus(id, data.orderStatus);

  // Credit loyalty points exactly once — only on the transition INTO "delivered",
  // never on a repeat update and never for a cancelled/undelivered order.
  if (data.orderStatus === "delivered" && existingOrder.orderStatus !== "delivered") {
    const updatedUser = await User.findByIdAndUpdate(
      order.userId,
      { $inc: { points: order.pointsEarned } },
      { new: true }
    );

    if (updatedUser) {
      const totalPoints =
        typeof updatedUser.points === "number" && !isNaN(updatedUser.points) ? updatedUser.points : 0;
      const newTier = getMembershipTier(totalPoints);
      if (updatedUser.member !== newTier) {
        await User.findByIdAndUpdate(order.userId, { $set: { member: newTier } });
      }
    }
  }

  return order;
}