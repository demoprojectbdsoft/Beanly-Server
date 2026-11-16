import { VendorOrder, VENDOR_ORDER_STATUSES } from "./vendor-order.model";
import { VendorStore } from "./vendor-store.model";
import { VendorSubscription, SubscriptionTransaction } from "./vendor-subscription.model";
import { listPlans } from "./vendor-plan.service";

/**
 * What the marketplace earns from its sellers.
 *
 * Three money streams meet here and nowhere else: the subscriptions a seller
 * pays to keep their store open, the commission the store takes out of their
 * sales, and the size of those sales in the first place. The desk is read-only
 * — the plan editor and the payout record stay where they are — so this service
 * only has to answer "how much, from whom, and how is it trending".
 */

/** Orders that never became a sale are excluded from every figure. */
const DEAD_STATUSES: (typeof VENDOR_ORDER_STATUSES)[number][] = ["rejected", "cancelled"];

function monthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(value: Date): string {
  const month = value.toLocaleString("en", { month: "short" });
  return `${month} ${String(value.getFullYear()).slice(2)}`;
}

/** The first day of the first month in the window. */
function windowStart(months: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
}

export interface VendorDeskQuery {
  months?: number;
}

export async function getVendorDeskReport(query: VendorDeskQuery = {}) {
  const months = Math.min(12, Math.max(3, Math.round(query.months ?? 6)));
  const from = windowStart(months);

  const [plans, stores, liveSubs, paidSubs, orders] = await Promise.all([
    listPlans(),
    VendorStore.find().select("name vendorId createdAt").lean(),
    VendorSubscription.find({ status: { $in: ["active", "grace"] } })
      .select("vendorId plan billingCycle pricePaid endDate status")
      .lean(),
    SubscriptionTransaction.find({ status: "success", createdAt: { $gte: from } })
      .select("vendorId plan billingCycle amount createdAt")
      .lean(),
    VendorOrder.find({
      createdAt: { $gte: from },
      status: { $nin: DEAD_STATUSES },
    })
      .select("vendorId storeId subtotal createdAt")
      .lean(),
  ]);

  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const planName = (id: string) => planById.get(id)?.name ?? id;
  const commissionOf = (id: string) => Number(planById.get(id)?.commissionPercent) || 0;

  // The live subscription says which rung each seller is on, so commission is
  // taken at that seller's own rate rather than one blended percentage.
  const planOfVendor = new Map<string, string>();
  for (const sub of liveSubs as any[]) {
    planOfVendor.set(String(sub.vendorId), String(sub.plan));
  }

  const storeById = new Map<string, string>();
  for (const store of stores as any[]) {
    storeById.set(String(store.vendorId), String(store.name || ""));
  }

  // One bucket per month in the window, so a quiet month draws a zero instead
  // of collapsing the axis.
  const buckets: { key: string; label: string }[] = [];
  for (let index = months - 1; index >= 0; index -= 1) {
    const date = new Date();
    date.setDate(1);
    date.setMonth(date.getMonth() - index);
    buckets.push({ key: monthKey(date), label: monthLabel(date) });
  }

  const series = buckets.map((bucket) => ({
    month: bucket.key,
    label: bucket.label,
    subscriptions: 0,
    sales: 0,
    commission: 0,
  }));
  const byMonth = new Map(series.map((row) => [row.month, row]));

  let subscriptionIncome = 0;
  const planIncome = new Map<string, number>();
  const planVendors = new Map<string, number>();

  for (const tx of paidSubs as any[]) {
    const amount = Number(tx.amount) || 0;
    subscriptionIncome += amount;
    const key = String(tx.plan);
    planIncome.set(key, (planIncome.get(key) ?? 0) + amount);

    const row = byMonth.get(monthKey(new Date(tx.createdAt)));
    if (row) row.subscriptions += amount;
  }

  for (const [vendorId, planId] of planOfVendor) {
    void vendorId;
    planVendors.set(planId, (planVendors.get(planId) ?? 0) + 1);
  }

  // Sales and commission, grouped by seller so the ranking and the totals are
  // built from the same numbers.
  const perVendor = new Map<
    string,
    { vendorId: string; sales: number; orders: number }
  >();
  let vendorSales = 0;
  let vendorOrders = 0;

  for (const order of orders as any[]) {
    const vendorId = String(order.vendorId);
    const subtotal = Number(order.subtotal) || 0;
    vendorSales += subtotal;
    vendorOrders += 1;

    const entry = perVendor.get(vendorId) ?? { vendorId, sales: 0, orders: 0 };
    entry.sales += subtotal;
    entry.orders += 1;
    perVendor.set(vendorId, entry);

    const row = byMonth.get(monthKey(new Date(order.createdAt)));
    if (row) {
      row.sales += subtotal;
      row.commission += subtotal * (commissionOf(planOfVendor.get(vendorId) ?? "free") / 100);
    }
  }

  let commissionEarned = 0;
  const topVendors = Array.from(perVendor.values())
    .map((entry) => {
      const planId = planOfVendor.get(entry.vendorId) ?? "free";
      const commission = entry.sales * (commissionOf(planId) / 100);
      commissionEarned += commission;
      return {
        id: entry.vendorId,
        store: storeById.get(entry.vendorId) ?? "",
        plan: planName(planId),
        sales: Math.round(entry.sales * 100) / 100,
        orders: entry.orders,
        commission: Math.round(commission * 100) / 100,
      };
    })
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 8);

  // What the live book is worth per month, with yearly rows spread over the
  // twelve months they cover so a big annual payment cannot spike one figure.
  let monthlyRecurring = 0;
  const soon = Date.now() + 7 * 24 * 60 * 60 * 1000;
  let expiringSoon = 0;
  let inGrace = 0;

  for (const sub of liveSubs as any[]) {
    const paid = Number(sub.pricePaid) || 0;
    monthlyRecurring += sub.billingCycle === "yearly" ? paid / 12 : paid;
    if (String(sub.status) === "grace") inGrace += 1;
    const end = sub.endDate ? new Date(sub.endDate).getTime() : 0;
    if (end && end <= soon) expiringSoon += 1;
  }

  return {
    months,
    totals: {
      vendors: stores.length,
      activePlans: liveSubs.length,
      subscriptionIncome: Math.round(subscriptionIncome * 100) / 100,
      monthlyRecurring: Math.round(monthlyRecurring * 100) / 100,
      vendorSales: Math.round(vendorSales * 100) / 100,
      vendorOrders,
      commissionEarned: Math.round(commissionEarned * 100) / 100,
      expiringSoon,
      inGrace,
    },
    series: series.map((row) => ({
      ...row,
      subscriptions: Math.round(row.subscriptions * 100) / 100,
      sales: Math.round(row.sales * 100) / 100,
      commission: Math.round(row.commission * 100) / 100,
    })),
    plans: plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      price: Number(plan.monthlyPrice) || 0,
      vendors: planVendors.get(plan.id) ?? 0,
      income: Math.round((planIncome.get(plan.id) ?? 0) * 100) / 100,
    })),
    topVendors,
  };
}
