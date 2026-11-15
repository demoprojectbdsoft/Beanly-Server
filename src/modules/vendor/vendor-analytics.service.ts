import { Types } from "mongoose";
import { VendorOrder, type VendorOrderStatus } from "./vendor-order.model";
import { getVendorPlanState, vendorCommission } from "./vendor-subscription.service";
import type { VendorAnalyticsQuery } from "./vendor-analytics.validator";

/**
 * What a seller sold, from the seller's own rows.
 *
 * Every number comes out of the vendor's fulfilment groups, so a shop can never
 * read another shop's turnover. The read is one pass over the vendor's own rows
 * and the folding happens here: totals, the chart, the top products and the
 * comparison against the previous window all come from the same snapshot, so no
 * two figures on the page can disagree.
 *
 * Money is counted when a group is delivered, not when it is ordered. A parcel
 * still on the way is shown separately as "on the way", because it is not income
 * yet and a seller budgeting on it would be wrong twice over.
 */

/** The stages that count as earned, and the ones still moving. */
const EARNED_STATUSES: VendorOrderStatus[] = ["delivered"];
const IN_FLIGHT_STATUSES: VendorOrderStatus[] = ["ready_for_shipment", "shipped"];
const STOPPED_STATUSES: VendorOrderStatus[] = ["rejected", "cancelled"];

/** The longest window each analytics level may ask for. */
const RANGE_BY_LEVEL: Record<string, number> = {
  basic: 30,
  detailed: 90,
  advanced: 365,
};

/** How many products each level may see ranked. */
const TOP_BY_LEVEL: Record<string, number> = {
  basic: 3,
  detailed: 10,
  advanced: 20,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight-to-midnight key for the day a moment belongs to. */
function dayKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

/** The key a month belongs to, used when the window is a whole year. */
function monthKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  return `${value.getFullYear()}-${month}`;
}

/** The moment a group was earned, taken from its own history. */
function earnedAt(row: any): Date | null {
  if (EARNED_STATUSES.includes(row.status as VendorOrderStatus)) {
    const events = (row.history || []).filter(
      (event: any) => event.status === "delivered" && event.at
    );
    const last = events.length ? events[events.length - 1].at : row.updatedAt;
    return last ? new Date(last) : null;
  }
  return null;
}

function unitsOf(row: any): number {
  return (row.items || []).reduce((sum: number, item: any) => sum + (Number(item.quantity) || 0), 0);
}

/** The day keys of the window, oldest first, so a quiet day is still a point. */
function windowKeys(days: number, monthly: boolean): string[] {
  const keys: string[] = [];
  const now = new Date();

  if (monthly) {
    for (let i = 11; i >= 0; i--) {
      keys.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
    }
    return keys;
  }

  for (let i = days - 1; i >= 0; i--) {
    keys.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

/** The key a moment is filed under for the current window. */
function bucketKey(value: Date, monthly: boolean): string {
  return monthly ? monthKey(value) : dayKey(value);
}

/**
 * Folds the seller's rows into the report.
 *
 * `from`..`to` is the window the screen asked for; the window right before it is
 * measured the same way so the change figure compares like with like.
 */
function summarise(rows: any[], from: number, to: number) {
  let revenue = 0;
  let orders = 0;
  let units = 0;

  for (const row of rows) {
    const at = earnedAt(row);
    if (!at) continue;
    const time = at.getTime();
    if (time < from || time > to) continue;
    revenue += Number(row.subtotal) || 0;
    orders += 1;
    units += unitsOf(row);
  }

  return {
    revenue: Math.round(revenue * 100) / 100,
    orders,
    units,
    avgOrderValue: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0,
  };
}

/**
 * The seller's report for one window.
 *
 * The plan is read first because it decides the window: a request for a year on
 * a basic account is answered with the longest window that account owns, and the
 * page is told which window was actually used so it never shows a range the
 * vendor does not have.
 */
export async function getVendorAnalytics(vendorId: string, query: VendorAnalyticsQuery) {
  const [{ plan, isLive }, commission] = await Promise.all([
    getVendorPlanState(vendorId),
    vendorCommission(vendorId),
  ]);

  const level = plan.analytics;
  const maxRange = RANGE_BY_LEVEL[level] ?? 30;
  const topLimit = TOP_BY_LEVEL[level] ?? 3;
  const range = Math.min(query.range || 30, maxRange);
  const monthly = range > 90;

  const now = Date.now();
  const from = now - range * DAY_MS;
  const previousFrom = now - range * 2 * DAY_MS;

  const rows = await VendorOrder.find({
    vendorId: new Types.ObjectId(vendorId),
    // Anything that could still land in either window: placed recently, or moved
    // recently even if it was placed long ago. A parcel still on the way is
    // read whatever its age, because it is money the seller is still owed and
    // it must not drop out of the "on the way" figure as the window slides.
    $or: [
      { createdAt: { $gte: new Date(previousFrom) } },
      { updatedAt: { $gte: new Date(previousFrom) } },
      { status: { $in: IN_FLIGHT_STATUSES } },
    ],
  })
    .select("status subtotal items createdAt updatedAt history orderNumber city")
    .lean();

  const current = summarise(rows, from, now);
  const previous = summarise(rows, previousFrom, from);

  // The chart keeps a point for every day (or month) in the window, so a quiet
  // week reads as flat instead of as missing data.
  const keys = windowKeys(range, monthly);
  const buckets = new Map(keys.map((key) => [key, { revenue: 0, orders: 0 }]));

  const statusCounts: Record<string, number> = {};
  const products = new Map<string, { title: string; image: string; units: number; revenue: number }>();
  const placed: any[] = [];

  let inFlight = 0;

  for (const row of rows) {
    const status = row.status as VendorOrderStatus;

    if (IN_FLIGHT_STATUSES.includes(status)) {
      inFlight += Number(row.subtotal) || 0;
    }

    const at = earnedAt(row);
    if (at && at.getTime() >= from) {
      const bucket = buckets.get(bucketKey(at, monthly));
      if (bucket) {
        bucket.revenue += Number(row.subtotal) || 0;
        bucket.orders += 1;
      }

      for (const item of row.items || []) {
        const id = String(item.productId?._id ?? item.productId ?? item.title);
        const entry =
          products.get(id) ||
          {
            title: item.title || "Product",
            image: item.image || (item.productId as any)?.image || "",
            units: 0,
            revenue: 0,
          };
        entry.units += Number(item.quantity) || 0;
        entry.revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
        products.set(id, entry);
      }
    }

    // The pipeline is about what the seller was asked to do in this window, so it
    // counts by the day the order was placed.
    if (new Date(row.createdAt).getTime() >= from) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      placed.push(row);
    }
  }

  const deliveredCount = statusCounts["delivered"] || 0;
  const stoppedCount = STOPPED_STATUSES.reduce((sum, status) => sum + (statusCounts[status] || 0), 0);
  const closed = deliveredCount + stoppedCount;

  const topProducts = [...products.values()]
    .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
    .slice(0, topLimit)
    .map((product) => ({
      ...product,
      image: product.image || "",
      revenue: Math.round(product.revenue * 100) / 100,
    }));

  const commissionTaken = Math.round(current.revenue * (commission / 100) * 100) / 100;

  return {
    range,
    maxRange,
    monthly,
    level,
    plan: { id: plan.id, name: plan.name, analytics: plan.analytics, exports: plan.exports },
    isLive,
    totals: {
      revenue: current.revenue,
      orders: current.orders,
      units: current.units,
      avgOrderValue: current.avgOrderValue,
      inFlight: Math.round(inFlight * 100) / 100,
      commission: Math.round(commission * 10) / 10,
      commissionTaken,
      netPayout: Math.round((current.revenue - commissionTaken) * 100) / 100,
      fulfilmentRate: closed > 0 ? Math.round((deliveredCount / closed) * 100) : 0,
      stopped: stoppedCount,
      placed: placed.length,
    },
    previous: {
      revenue: previous.revenue,
      orders: previous.orders,
      revenueChange:
        previous.revenue > 0
          ? Math.round(((current.revenue - previous.revenue) / previous.revenue) * 1000) / 10
          : null,
    },
    series: keys.map((key) => {
      const bucket = buckets.get(key)!;
      return {
        label: key,
        revenue: Math.round(bucket.revenue * 100) / 100,
        orders: bucket.orders,
      };
    }),
    statusCounts,
    topProducts,
    recent: [...placed]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8)
      .map((row) => ({
        id: String(row._id),
        orderNumber: row.orderNumber || "",
        status: row.status as VendorOrderStatus,
        subtotal: Number(row.subtotal) || 0,
        units: unitsOf(row),
        city: row.city || "",
        placedAt: new Date(row.createdAt).toISOString(),
      })),
  };
}
