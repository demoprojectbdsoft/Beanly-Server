import { Schema, model } from "mongoose";

/**
 * One promotional placement bought with a subscription.
 *
 * A row exists for both kinds of placement the store sells: a product pinned
 * to the featured shelves, and a whole store lifted into the featured vendors
 * row. `endsAt` is written when the promotion activates and is checked on the
 * server before anything is shown as featured, so an expired placement can
 * never survive on a stale screen.
 */

export const PROMOTION_KINDS = ["product", "store"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export const PROMOTION_STATUSES = ["active", "expired", "cancelled"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

const featuredPromotionSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: "VendorStore", required: true, index: true },

    kind: { type: String, enum: PROMOTION_KINDS, required: true },
    /** Empty for a store promotion. */
    productId: { type: Schema.Types.ObjectId, ref: "Product", default: null, index: true },

    status: { type: String, enum: PROMOTION_STATUSES, default: "active", index: true },

    /** Which subscription paid for it, and on which plan. */
    subscriptionId: { type: Schema.Types.ObjectId, ref: "VendorSubscription", default: null },
    plan: { type: String, required: true },
    source: { type: String, enum: ["subscription", "admin"], default: "subscription" },

    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true, index: true },

    /** Set when the sweep or an admin closes the promotion. */
    endedAt: { type: Date, default: null },
    endedReason: { type: String, default: "" },
  },
  { timestamps: true }
);

// "Is this product featured right now?" — the public shelves ask this.
featuredPromotionSchema.index({ kind: 1, status: 1, endsAt: 1 });
// One live placement per product, so pressing "Feature" twice cannot buy two.
featuredPromotionSchema.index(
  { productId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active", kind: "product" },
    name: "one_active_product_promotion",
  }
);
// One live store placement per vendor.
featuredPromotionSchema.index(
  { vendorId: 1, kind: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active", kind: "store" },
    name: "one_active_store_promotion",
  }
);

export const FeaturedPromotion = model("FeaturedPromotion", featuredPromotionSchema);
