import { Schema, model } from "mongoose";
import { BILLING_CYCLES } from "./vendor.types";

/**
 * A vendor's subscription.
 *
 * One row per period the vendor bought. The live row is the one whose status
 * is "active" or "grace"; a partial unique index makes a second live row
 * impossible, which is what stops a retried payment from activating twice.
 * Old rows are kept as the subscription history.
 */

export const SUBSCRIPTION_STATUSES = ["active", "grace", "expired", "cancelled"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

const subscriptionEventSchema = new Schema(
  {
    action: {
      type: String,
      enum: ["started", "renewed", "upgraded", "downgraded", "cancelled", "expired", "grace"],
      required: true,
    },
    at: { type: Date, default: Date.now },
    fromPlan: { type: String, default: null },
    toPlan: { type: String, default: null },
    note: { type: String, default: "" },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

const vendorSubscriptionSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: "VendorStore", required: true, index: true },

    plan: { type: String, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: "monthly" },

    status: { type: String, enum: SUBSCRIPTION_STATUSES, default: "active", index: true },

    /** The rate that applied when this period started, never re-read later. */
    pricePaid: { type: Number, default: 0 },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    /** End date plus the plan's grace period; benefits run until here. */
    graceEndsAt: { type: Date, default: null },

    /** False once the vendor cancels the renewal; the period still runs out. */
    autoRenew: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null },
    /** A short note an admin leaves when they change the plan by hand. */
    note: { type: String, default: "" },

    history: { type: [subscriptionEventSchema], default: [] },
  },
  { timestamps: true }
);

// One live subscription per vendor, enforced by the database.
vendorSubscriptionSchema.index(
  { vendorId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["active", "grace"] } },
    name: "one_live_subscription_per_vendor",
  }
);

// Admin list and the expiry sweep.
vendorSubscriptionSchema.index({ status: 1, endDate: 1 });

export const VendorSubscription = model("VendorSubscription", vendorSubscriptionSchema);

/**
 * One demo payment for a subscription.
 *
 * It is a record, not an integration: the amount is computed on the server,
 * the browser only asks for it. `idempotencyKey` is unique so a double-clicked
 * "Pay" button produces one payment, not two.
 */
const subscriptionTransactionSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: "VendorStore", default: null },
    subscriptionId: { type: Schema.Types.ObjectId, ref: "VendorSubscription", default: null },

    plan: { type: String, required: true },
    billingCycle: { type: String, enum: BILLING_CYCLES, required: true },
    amount: { type: Number, required: true, min: 0 },

    /** The demo wallet method the store already supports at checkout. */
    method: { type: String, enum: ["cod", "bkash", "rocket", "nagad", "wallet"], required: true },
    status: { type: String, enum: ["pending", "success", "failed"], default: "pending", index: true },
    reference: { type: String, required: true },

    /** Demo money, always labelled as such on every screen. */
    isDemo: { type: Boolean, default: true },

    /** Which flow paid for it: first activation, renewal, upgrade or downgrade. */
    purpose: {
      type: String,
      enum: ["activation", "renewal", "upgrade", "downgrade", "admin"],
      default: "activation",
    },
    idempotencyKey: { type: String, default: null, unique: true, sparse: true },

    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },
    failureReason: { type: String, default: "" },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true }
);

subscriptionTransactionSchema.index({ vendorId: 1, createdAt: -1 });

export const SubscriptionTransaction = model(
  "SubscriptionTransaction",
  subscriptionTransactionSchema
);
