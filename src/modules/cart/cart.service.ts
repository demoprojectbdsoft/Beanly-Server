import { Cart } from "./cart.model";
import { Product } from "../product/product.model";
import { User } from "../user/user.model";
import { ApiError } from "../../utils/apiError";

// Fetches user cart with populated product data and precalculated totals
export async function getCartByUserId(userId: string) {
  const items = await Cart.find({ userId }).populate("productId").sort({ createdAt: -1 });

  let totalPrice = 0;
  let totalItems = 0;

  const formatted = items.map((item: any) => {
    const product = item.productId;
    const price = product?.price || 0;
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

export async function addToCart(userId: string, productId: string, quantity: number) {
  const user = await User.findById(userId);
  if (user && ((user.role || "").toLowerCase() === "admin" || (user.role || "").toLowerCase() === "demoadmin")) {
    throw new ApiError(403, "Admins cannot add products to cart");
  }

  const product = await Product.findById(productId);
  if (!product) throw new ApiError(404, "Product not found");

  if (!product.inStock || (product.stockQuantity != null && product.stockQuantity <= 0)) {
    throw new ApiError(400, `"${product.title}" is currently out of stock`);
  }

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
  const product = await Product.findById(productId);
  if (!product) throw new ApiError(404, "Product not found");

  if (!product.inStock || (product.stockQuantity != null && product.stockQuantity <= 0)) {
    throw new ApiError(400, `"${product.title}" is currently out of stock`);
  }

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