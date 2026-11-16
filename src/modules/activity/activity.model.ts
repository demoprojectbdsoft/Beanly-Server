import { Schema, model } from "mongoose";

/**
 * How long one activity line is kept. Activities answer "what just happened",
 * so older lines delete themselves instead of piling up forever.
 */
export const ACTIVITY_TTL_DAYS = 30;

/** Every line the store team's feed can hold. */
export const STORE_ACTIVITY_TYPES = [
  "order",
  "transaction",
  "user",
  "user_deleted",
  "order_cancelled",
  "message",
  "review",
  // A delivery was offered, accepted, declined or stopped.
  "delivery",
  // A vendor applied, resubmitted, or changed plan.
  "vendor",
  // A rider applied, was approved, rejected or had their access revoked.
  "rider",
] as const;

/**
 * Every line a customer or rider can be told about. "order_cancelled" is shared
 * with the store feed: one cancellation is one event, written for both sides.
 */
export const PERSONAL_ACTIVITY_TYPES = [
  "order_placed",
  "order_confirmed",
  "order_processing",
  "order_shipped",
  "order_delivered",
  "order_cancelled",
  "delivery_assigned",
  "delivery_update",
  "delivery_declined",
  // The vendor side. One type per stream keeps the bell's chips readable.
  "vendor_application",
  "vendor_subscription",
  "vendor_order",
  "vendor_product",
  "vendor_promotion",
  "vendor_coupon",
  "vendor_review",
  "vendor_stock",
  "vendor_limit",
  "vendor_payment",
  // The rider side. One line per application event keeps the bell's chips short.
  "rider_application",
] as const;

/** The two lists overlap on purpose, so the enum is built from the union. */
const ALL_ACTIVITY_TYPES = [...new Set<string>([...STORE_ACTIVITY_TYPES, ...PERSONAL_ACTIVITY_TYPES])];

/**
 * One line in an activity feed.
 *
 * The same collection serves both feeds. A line with no `userId` belongs to the
 * store team; a line with a `userId` belongs to that one person and carries
 * their read state. One model means one history: nothing a customer is told can
 * drift away from what the store sees.
 *
 * It stores what changed and the value the dashboard can search for, but never
 * the screen to open: the link is built in the app, so an old line still points
 * at the right page after a route is renamed.
 */
const activitySchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      enum: ALL_ACTIVITY_TYPES,
    },
    // For example: "New order #ORD-A1B2C3"
    title: { type: String, required: true },
    // For example: "Nihal Ahmed · 2 items · $129.00"
    detail: { type: String, default: "" },
    // An order id, an email, a message address — whatever the list screen
    // knows how to search by.
    ref: { type: String, default: "" },

    // ── Personal line ────────────────────────────────────────────────────────
    // The one person this line is for. Empty means it belongs to the store feed.
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // Which side of the app the line is written for. "vendor" is already
    // accepted so the seller add-on can be notified without a schema change.
    role: { type: String, enum: ["customer", "rider", "vendor", "admin"], default: null },
    // When its owner opened it. Empty until they do.
    readAt: { type: Date, default: null },

    // The TTL index removes the whole line once it is this many seconds old.
    createdAt: {
      type: Date,
      default: Date.now,
      expires: 60 * 60 * 24 * ACTIVITY_TTL_DAYS,
    },
  },
  { versionKey: false }
);

// The bell asks "mine, unread first, newest first" on every poll.
activitySchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export const Activity = model("Activity", activitySchema);
