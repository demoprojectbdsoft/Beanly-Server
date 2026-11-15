import { Cart } from "./cart.model";
import { Product } from "../product/product.model";
import { sellingPriceOf } from "../product/product.service";
import { User } from "../user/user.model";
import { ApiError } from "../../utils/apiError";
import { canShopWithRoles, canSwitchToShopper, roleLabel } from "../../utils/roles";

// Fetches user cart with populated product data and precalculated totals
export async function getCartByUserId(userId: string) {
  const items = await Cart.find({ userId }).populate("productId").sort({ createdAt: -1 });

  let totalPrice = 0;
  let totalItems = 0;

  const formatted = items.map((item: any) => {
    const product = item.productId;
    // The price on the product card is the price in the cart: a lapsed offer
    // has already reverted, so the total cannot charge the old deal.
    const price = product ? sellingPriceOf(product) : 0;
    const lineTotal = price * item.quantity;

    totalPrice += lineTotal;
    totalItems += item.quantity;

    return {
      id: item._id,
      product,
      quantity: item.quantity,
      lineTotal,
    };
  });

  return {
    items: formatted,
    totalItems,
    totalPrice: Number(totalPrice.toFixed(2)),
    itemCount: totalItems,
    subtotal: Number(totalPrice.toFixed(2)),
  };
}

/** Loads a product or fails the request with a 404. */
async function findProductOrThrow(productId: string) {
  const product = await Product.findById(productId);
  if (!product) throw new ApiError(404, "Product not found");
  return product;
}

/**
 * Rejects products that are flagged out of stock or have no units left.
 *
 * A product with no stock quantity was saved without stock tracking, so it has
 * no count to check and is always sellable.
 */
function assertInStock(product: any) {
  if (product.stockQuantity == null) return;
  if (!product.inStock || product.stockQuantity <= 0) {
    throw new ApiError(400, `"${product.title}" is currently out of stock`);
  }
}

export async function addToCart(userId: string, productId: string, quantity: number) {
  const user = await User.findById(userId);
  // The strict multi-role rule: an account may add to a cart only when its
  // approved `roles` array carries `customer` AND it is on the customer
  // dashboard. A rider or vendor who also holds `customer` must switch first;
  // the mirror `role` string is the fallback for legacy unmigrated rows.
  if (user && !canShopWithRoles(user.roles, user.role, user.activeRole)) {
    if (canSwitchToShopper(user.roles, user.activeRole || user.role)) {
      throw new ApiError(403, "Switch to the customer dashboard to add products to cart");
    }
    throw new ApiError(403, `${roleLabel(user.activeRole || user.role)} accounts cannot add products to cart`);
  }

  const product = await findProductOrThrow(productId);
  assertInStock(product);

  const existing = await Cart.findOne({ userId, productId });
  const requestedTotal = existing ? existing.quantity + quantity : quantity;

  if (product.stockQuantity != null && requestedTotal > product.stockQuantity) {
    throw new ApiError(
      400,
      `Cannot add more items. Only ${product.stockQuantity} unit(s) available in stock`
    );
  }

  if (existing) {
    existing.quantity = requestedTotal;
    await existing.save();
    return existing.populate("productId");
  }

  const item = await Cart.create({ userId, productId, quantity });
  return item.populate("productId");
}

export async function updateCartItem(userId: string, productId: string, quantity: number) {
  const product = await findProductOrThrow(productId);
  assertInStock(product);

  if (product.stockQuantity != null && quantity > product.stockQuantity) {
    throw new ApiError(
      400,
      `Cannot exceed available stock of ${product.stockQuantity} unit(s) for "${product.title}"`
    );
  }

  const item = await Cart.findOneAndUpdate(
    { userId, productId },
    { quantity },
    { new: true }
  ).populate("productId");

  if (!item) throw new ApiError(404, "Item not found in cart");
  return item;
}

export async function removeFromCart(userId: string, productId: string) {
  const item = await Cart.findOneAndDelete({ userId, productId });
  if (!item) throw new ApiError(404, "Item not found in cart");
  return item;
}

export async function clearCart(userId: string) {
  await Cart.deleteMany({ userId });
}

export async function isCarted(userId: string, productId: string) {
  const item = await Cart.findOne({ userId, productId });
  return { isCarted: !!item, isInCart: !!item };
}