import { z } from "zod";
import { DELIVERY_STATUSES } from "./delivery.model";
import { objectIdSchema } from "../../utils/ids";

/**
 * The rider's own list: a stage, a search, and a page.
 *
 * `active` and `finished` are shortcuts over several stages, so each dashboard
 * tab can ask for exactly the rows it shows without repeating a status list.
 */
export const getRiderDeliveriesQuerySchema = z.object({
  status: z.enum(["all", "active", "finished", ...DELIVERY_STATUSES]).default("all"),
  search: z.string().optional(),
  sort: z.enum(["newest", "oldest", "fee_desc"]).default("newest"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** How far back the overview charts look. */
export const riderStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(14),
});

/**
 * The store offers a job to one rider. `ship` also moves the order to
 * "shipped" in the same request, so the admin's single click cannot leave an
 * order that nobody can ship.
 */
export const assignDeliverySchema = z.object({
  orderId: objectIdSchema("A valid order id is required"),
  riderId: objectIdSchema("A valid rider id is required"),
  fee: z.coerce.number().min(0).max(100000).optional(),
  distanceKm: z.coerce.number().min(0).max(10000).optional(),
  ship: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
});

export const reassignDeliverySchema = z.object({
  riderId: objectIdSchema("A valid rider id is required"),
  fee: z.coerce.number().min(0).max(100000).optional(),
  note: z.string().trim().max(300).optional(),
});

/** A decline says why: the store cannot fix a cause it never hears. */
export const declineDeliverySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Please tell the store why you cannot take this delivery")
    .max(300, "Keep the reason under 300 characters"),
});

export const cancelDeliverySchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

/**
 * The rider's own step. `delivered` is not accepted here: a hand-over is
 * confirmed with the customer's code, on its own endpoint. `cancelled` is not
 * accepted either: a rider who has taken a job cannot put it back, so the only
 * way a delivery stops is the customer calling the order off or the store
 * stopping the job, and both of those are said elsewhere.
 */
export const riderStepSchema = z.object({
  status: z.enum(["picked_up", "out_for_delivery"], {
    message:
      "An accepted delivery only moves forward: picked up, then out for delivery. Only the customer or the store can cancel it.",
  }),
  note: z.string().trim().max(300).optional(),
});

/** One position ping from the rider's phone. */
export const locationSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100000).optional(),
  heading: z.coerce.number().min(0).max(360).optional(),
  speed: z.coerce.number().min(0).max(200).optional(),
});

export const verifyOtpSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{4,6}$/, "Enter the delivery code the customer read to you"),
});

/** The store's own delivery board. */
export const adminDeliveryQuerySchema = z.object({
  status: z.enum(["all", "active", "finished", ...DELIVERY_STATUSES]).default("all"),
  riderId: z.string().optional(),
  search: z.string().optional(),
  sort: z.enum(["newest", "oldest", "fee_desc"]).default("newest"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/**
 * The store's payout record.
 *
 * `range` is how far back the graph looks, in days; `all` is every job the store
 * has ever paid. Thirty and ninety days fold into daily buckets because a store
 * asking about a month wants to see the days, and a year wants the months.
 */
export const adminPayoutsQuerySchema = z.object({
  range: z.enum(["30", "90", "365", "all"]).default("365"),
  riderId: z.string().optional(),
  sort: z.enum(["newest", "oldest", "fee_desc"]).default("newest"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(20),
});

/** Who may look at a tracking page: the buyer, or the store. */
export const trackingQuerySchema = z.object({
  orderId: objectIdSchema("A valid order id is required").optional(),
});

export type GetRiderDeliveriesQuery = z.infer<typeof getRiderDeliveriesQuerySchema>;
export type RiderStatsQuery = z.infer<typeof riderStatsQuerySchema>;
export type AssignDeliveryInput = z.infer<typeof assignDeliverySchema>;
export type ReassignDeliveryInput = z.infer<typeof reassignDeliverySchema>;
export type DeclineDeliveryInput = z.infer<typeof declineDeliverySchema>;
export type CancelDeliveryInput = z.infer<typeof cancelDeliverySchema>;
export type RiderStepInput = z.infer<typeof riderStepSchema>;
export type LocationInput = z.infer<typeof locationSchema>;
export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;
export type AdminDeliveryQuery = z.infer<typeof adminDeliveryQuerySchema>;
export type AdminPayoutsQuery = z.infer<typeof adminPayoutsQuerySchema>;
export type TrackingQuery = z.infer<typeof trackingQuerySchema>;
