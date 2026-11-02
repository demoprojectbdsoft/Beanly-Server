import { DeliveryStatus } from "./delivery.model";

/**
 * The delivery lifecycle.
 *
 *   assigned ──▶ accepted ──▶ picked_up ──▶ out_for_delivery ──▶ delivered
 *       │
 *       └─▶ declined
 *
 * `assigned` is the store offering the job and the rider taking it. From
 * `accepted` on, only the rider moves it forward, and the rider has no way to
 * stop it: an accepted job ends at the customer's door with the code, or the
 * store ends it. `declined` is the one answer a rider may still give, and only
 * while the job is theirs to refuse.
 *
 * `cancelled` is deliberately absent. It is not a step anybody on the job can
 * take: the store stops a delivery through its own path, and a customer calling
 * an order off is executed by the store. Both of those check the live statuses
 * directly, so this table stays what its name says — the rider's forward moves.
 *
 * `delivered`, `cancelled` and `declined` have no way out: a finished job is
 * history, and a new offer is a new row.
 */
const TRANSITIONS: Record<DeliveryStatus, DeliveryStatus[]> = {
  assigned: ["accepted", "declined"],
  accepted: ["picked_up"],
  picked_up: ["out_for_delivery"],
  out_for_delivery: ["delivered"],
  delivered: [],
  cancelled: [],
  declined: [],
};

/** The stages a rider may move this delivery to. Empty means "closed". */
export function nextDeliveryStatuses(current: string): DeliveryStatus[] {
  return TRANSITIONS[current as DeliveryStatus] ?? [];
}

/** True when `to` is a legal next stage of `from`. */
export function isAllowedDeliveryTransition(from: string, to: string): boolean {
  return nextDeliveryStatuses(from).includes(to as DeliveryStatus);
}

/**
 * Whether a request has run out of its answer window.
 *
 * The sweep closes these rows, but the sweep runs on a schedule, so a request
 * nobody answered can still look live in the database. Anything that enforces
 * the one-claim-per-order rule has to read the clock itself instead of trusting
 * the status, or a timed-out offer would hold an order hostage.
 *
 * Lives here rather than in the service because both the delivery module and the
 * order module ask it, and the order module cannot import the delivery service
 * without a cycle.
 */
export function isLapsedOffer(delivery: { status?: string; expiresAt?: any } | null): boolean {
  if (!delivery || delivery.status !== "assigned") return false;
  if (!delivery.expiresAt) return false;
  return new Date(delivery.expiresAt).getTime() <= Date.now();
}

/**
 * The stage a rider's own button advances to. `delivered` is deliberately not
 * here: a hand-over is confirmed with the customer's delivery code instead, so
 * the rider cannot close a job at the door without meeting them. Nothing here
 * stops a job either: cancelling is the customer's move and the store's call.
 */
export const RIDER_STEP_STATUSES: DeliveryStatus[] = [
  "picked_up",
  "out_for_delivery",
];

/** The single button a rider sees next, or null when there is nothing to do. */
export function nextRiderStep(current: string): DeliveryStatus | null {
  if (current === "accepted") return "picked_up";
  if (current === "picked_up") return "out_for_delivery";
  return null;
}
