import { Schema, model } from "mongoose";

/**
 * The stages a delivery moves through.
 *
 * `assigned` is the store offering the job; `accepted` is the rider taking it.
 * After that only the rider moves it forward. `declined` and `cancelled` are
 * the two ways a delivery stops without being handed over.
 */
export const DELIVERY_STATUSES = [
  "assigned",
  "accepted",
  "picked_up",
  "out_for_delivery",
  "delivered",
  "cancelled",
  "declined",
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Statuses that mean the rider is working on it right now. */
export const ACTIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  "accepted",
  "picked_up",
  "out_for_delivery",
];

/** Statuses that mean the job is over, however it ended. */
export const FINISHED_DELIVERY_STATUSES: DeliveryStatus[] = [
  "delivered",
  "cancelled",
  "declined",
];

/**
 * Every stage where the order still has somebody attached to it. "assigned"
 * belongs here even though no work has started: the offer is what lets the
 * store ship, so it counts as a live assignment for the one-job-per-order rule.
 */
export const LIVE_DELIVERY_STATUSES: DeliveryStatus[] = [
  "assigned",
  ...ACTIVE_DELIVERY_STATUSES,
];

/** One step in the delivery's own timeline, kept beside the order timeline. */
const deliveryEventSchema = new Schema(
  {
    status: { type: String, enum: DELIVERY_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    note: { type: String, default: "" },
    // Who moved it: the rider, or the store team on a cancellation.
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { _id: false }
);

/**
 * One delivery job.
 *
 * The order carries the money and the customer; the delivery carries who is
 * riding it and how far it got. Keeping them apart means a reassignment never
 * touches the order, and the order's own timeline still shows the sale.
 */
const deliverySchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    riderId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // The admin who offered the job, for the assignment history.
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },

    status: {
      type: String,
      enum: DELIVERY_STATUSES,
      default: "assigned",
      index: true,
    },

    // A copy of what the rider needs at the door, so the job still reads
    // correctly after an order edit.
    customerName: { type: String, default: "" },
    customerPhone: { type: String, default: "" },
    address: { type: String, default: "" },
    city: { type: String, default: "" },
    items: { type: Number, default: 0 },
    orderTotal: { type: Number, default: 0 },

    // What the rider is paid for this job, and what the shop charges for it.
    // A job that reaches `delivered` has paid its fee: the amount is booked at
    // the moment the hand-over is confirmed, by whichever of the two confirms
    // it. `feePaidVia` says who that was, which is the difference between the
    // rider reading the code at the door and the customer confirming the parcel
    // arrived themselves. Rows closed before that rule was written say nothing,
    // and are read as the code path, which is what closed them.
    fee: { type: Number, default: 0 },
    feePaidVia: { type: String, enum: ["code", "customer", null], default: null },
    distanceKm: { type: Number, default: null },

    // A decline says why, so the store can fix the cause instead of guessing.
    declineReason: { type: String, default: "" },
    // A request that nobody answers in time stops blocking the order.
    expiresAt: { type: Date, default: null },

    acceptedAt: { type: Date, default: null },
    pickedUpAt: { type: Date, default: null },
    outForDeliveryAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    history: { type: [deliveryEventSchema], default: [] },
  },
  { timestamps: true }
);

// The rider's own screens: "mine, in this stage, newest first".
deliverySchema.index({ riderId: 1, status: 1, createdAt: -1 });
// One live job per order: the store cannot ship the same parcel twice. Finished
// rows (delivered, cancelled, declined) stay for the history and are outside
// the filter, so a reassignment can still be recorded beside them.
deliverySchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_DELIVERY_STATUSES } } }
);

export const Delivery = model("Delivery", deliverySchema);
