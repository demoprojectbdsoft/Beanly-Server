/**
 * The order status flow.
 *
 *   confirmed ──▶ processing ──▶ shipped ──▶ delivered
 *       │             │            │
 *       └─────────────┴────────────┴──▶ cancelled
 *
 * Rules:
 * - An order only moves forward, one step at a time.
 * - "cancelled" can be reached from any stage that has not been handed over,
 *   and has no way out: a refunded order can never be revived.
 * - "delivered" is closed too. The sale ended when the parcel changed hands, so
 *   a later problem is a return or a refund, not a status that rewrites a
 *   completed delivery.
 */
export const ORDER_STATUSES = [
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

const NEXT_STATUSES: Record<OrderStatus, OrderStatus[]> = {
  confirmed: ["processing", "cancelled"],
  processing: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

/** The stages an admin may move this order to. Empty means "closed". */
export function nextStatuses(current: string): OrderStatus[] {
  return NEXT_STATUSES[current as OrderStatus] ?? [];
}

/** True when `to` is a legal next stage of `from`. */
export function isAllowedTransition(from: string, to: string): boolean {
  return nextStatuses(from).includes(to as OrderStatus);
}

/** True for statuses that nothing can move out of. */
export function isClosedStatus(status: string): boolean {
  return nextStatuses(status).length === 0;
}
