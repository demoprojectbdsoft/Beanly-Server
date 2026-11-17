import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { Product } from "../product/product.model";
import * as promotionService from "./featured-promotion.service";
import { requireTradingStore } from "./vendor-store.service";
import { assertWithinLimit } from "./vendor-subscription.service";
import { isLiveVendorProductStatus, type BillingCycle } from "./vendor.types";
import type { FeatureProductInput, PromotionQuery } from "./featured-promotion.validator";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The seller's featured placements.
 *
 * A placement is bought, not claimed: the number of products that may be pinned
 * at once and how long each one stays up both come from the live plan, and the
 * plan is read here rather than trusted from the screen. Lifting the whole shop
 * is deliberately absent — being a featured *store* is the store team's call, so
 * only they can grant one, and it arrives here as a row the seller can see and
 * count down but never write.
 */

/** The product, this seller's own, and nothing else. */
async function requireOwnProduct(userId: string, productId: string) {
  const product = await Product.findOne({
    _id: new Types.ObjectId(productId),
    $or: [{ vendorId: userId }, { ownerId: userId }],
  });

  if (!product) {
    throw new ApiError(404, "No such product in your store");
  }
  return product;
}

export async function listMyPromotions(userId: string, query: PromotionQuery) {
  return promotionService.listPromotions(query, { vendorId: userId });
}

/**
 * Pins one of the seller's own live listings for the plan's own length.
 *
 * A draft or an archived row cannot be featured: the shelves a buyer reads are
 * the point, and a placement on something nobody can reach would use up a slot
 * for nothing.
 */
export async function featureMyProduct(userId: string, input: FeatureProductInput) {
  const store = await requireTradingStore(userId, "featuring a product");
  const product = await requireOwnProduct(userId, input.productId);

  if (!isLiveVendorProductStatus(product.vendorProductStatus)) {
    throw new ApiError(
      400,
      `Only a listed product can be featured. "${product.title}" is ${product.vendorProductStatus}`
    );
  }

  // The allowance is what refuses a seller whose slots are all taken, and it
  // says how many they have and how to get more.
  const state = await assertWithinLimit(userId, "featured");

  const planDays = state.plan.featuredDurationDays;
  if (planDays <= 0) {
    throw new ApiError(
      403,
      `Your ${state.plan.name} plan has no featured period. Upgrade to buy shelf space.`
    );
  }

  // The package states the length, and the package is also the ceiling: a
  // placement never outlives the period that paid for it. A plan with a day or
  // less left still gives one honest day, and the expiry sweep then closes it.
  const until = state.effectiveUntil;
  const remainingDays = until
    ? Math.max(1, Math.ceil((until.getTime() - Date.now()) / DAY_MS))
    : planDays;
  const days = Math.min(planDays, remainingDays);

  return promotionService.createPromotion(
    { kind: "product", productId: input.productId, days },
    {
      vendorId: userId,
      storeId: String(store._id),
      plan: state.plan.id,
      // The period as it was bought, which is the second thing the featured
      // shelf ranks on after the plan tier.
      billingCycle: (state.subscription?.billingCycle as BillingCycle) ?? null,
      source: "subscription",
      // The period that was live when the shelf was bought, so the row can be
      // read back against a payment history that later changed.
      subscriptionId: state.isLive && state.subscription ? String(state.subscription._id) : null,
    }
  );
}

/**
 * Frees a slot early.
 *
 * A seller can only ever cancel their own placement, and the row is kept: the
 * desk still explains what ran and when it stopped.
 */
export async function cancelMyPromotion(userId: string, id: string) {
  return promotionService.endPromotion(id, "Ended by the seller", { vendorId: userId });
}
