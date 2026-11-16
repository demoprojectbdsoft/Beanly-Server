import { Schema, model } from "mongoose";

/**
 * One product's activity on one day.
 *
 * Views and clicks are folded into a per-day counter instead of an event log,
 * so any window is a small range read and the collection stays the size of the
 * catalogue rather than the size of the traffic. `vendorId` is copied onto the
 * row when it is first written, so a seller's report can be scoped without a
 * join and keeps working if the product is later reassigned.
 */
const productEngagementSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    /** The server's local day, "YYYY-MM-DD", so a report can match by string. */
    day: { type: String, required: true },
    /** The detail page was opened. */
    views: { type: Number, default: 0 },
    /** An intent action on the product — add to cart, buy now. */
    clicks: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One row per product per day; the counter is incremented, never inserted twice.
productEngagementSchema.index({ productId: 1, day: 1 }, { unique: true });
productEngagementSchema.index({ day: 1 });

export const ProductEngagement = model("ProductEngagement", productEngagementSchema);
