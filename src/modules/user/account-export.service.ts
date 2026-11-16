import { Address } from "../address/address.model";
import { Cart } from "../cart/cart.model";
import { Order } from "../order/order.model";
import { OrderStatusLog } from "../order-status/order-status.model";
import { ProductReview } from "../review/review.model";
import { Transaction } from "../transaction/transaction.model";
import { Wishlist } from "../wishlist/wishlist.model";
import { ApiError } from "../../utils/apiError";
import { idQuery } from "../../utils/ids";
import { User } from "./user.model";

/**
 * Everything one account owns, as a single JSON-ready object.
 *
 * This is what the "Export Account Data" button downloads, so the customer can
 * keep their own records before deleting the account. Only the caller's own
 * rows are collected — the id is always taken from the bearer token.
 */
export async function exportAccountData(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user) throw new ApiError(404, "User not found");

  const orders = await Order.find({ userId }).sort({ createdAt: -1 }).lean();
  const orderIds = orders.map((order) => order._id);

  const [transactions, reviews, wishlist, cart, addresses, orderStatusHistory] =
    await Promise.all([
      Transaction.find({ userId }).sort({ createdAt: -1 }).lean(),
      // Review.userId is a Mixed field, so both the string and ObjectId forms
      // have to be matched.
      ProductReview.find({ userId: idQuery(userId) }).sort({ createdAt: -1 }).lean(),
      Wishlist.find({ userId }).populate("productId", "title price image").lean(),
      Cart.find({ userId }).populate("productId", "title price image").lean(),
      Address.find({ userId }).sort({ createdAt: -1 }).lean(),
      OrderStatusLog.find({ orderId: { $in: orderIds } }).sort({ createdAt: 1 }).lean(),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    account: user,
    orders,
    orderStatusHistory,
    transactions,
    reviews,
    wishlist,
    cart,
    addresses,
  };
}
