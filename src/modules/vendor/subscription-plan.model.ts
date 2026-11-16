import { Schema, model } from "mongoose";

/**
 * One plan in the store's price list.
 *
 * The defaults in `vendor.types.ts` seed this collection; from then on a row
 * here wins. The store team adds, edits and removes rows from the dashboard,
 * which is how prices, limits, features and billing duration stay editable
 * without touching code. `planId` is a slug derived from the name, so a plan
 * added later needs no code change either.
 */
const subscriptionPlanSchema = new Schema(
  {
    planId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },

    monthlyPrice: { type: Number, required: true, min: 0 },
    yearlyPrice: { type: Number, required: true, min: 0 },

    maxProducts: { type: Number, required: true, min: 0 },
    featuredProducts: { type: Number, required: true, min: 0 },
    featuredDurationDays: { type: Number, required: true, min: 0 },
    activeCoupons: { type: Number, required: true, min: 0 },

    analytics: { type: String, enum: ["basic", "detailed", "advanced"], required: true },
    salesReports: { type: String, enum: ["basic", "advanced"], required: true },
    exports: { type: String, enum: ["limited", "full"], required: true },
    storeCustomization: { type: String, enum: ["basic", "enhanced", "full"], required: true },
    promotionalCampaigns: { type: String, enum: ["none", "limited", "priority"], required: true },
    storeVisibility: { type: String, enum: ["standard", "enhanced", "priority"], required: true },
    support: { type: String, enum: ["standard", "priority"], required: true },

    highlights: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },

    /** Platform commission on this plan, in percent. */
    commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
    /** Days a lapsed subscription keeps its benefits before it stops. */
    gracePeriodDays: { type: Number, default: 0, min: 0 },
    /** Billing periods the plan may be bought for. */
    billingCycles: { type: [String], enum: ["monthly", "yearly"], default: ["monthly", "yearly"] },

    /** Where the plan sits in the admin list and on the pricing cards. */
    sortOrder: { type: Number, default: 0 },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export const SubscriptionPlan = model("SubscriptionPlan", subscriptionPlanSchema);
