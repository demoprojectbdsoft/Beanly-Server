/**
 * Types and the one central plan table for the marketplace add-on.
 *
 * Every limit the store sells lives here. The services read the table, the
 * dashboards render it, and nothing else in the codebase is allowed to invent
 * a plan number — otherwise a "10 products" rule would exist twice and drift.
 */

/** Application lifecycle, exactly as the review screen names it. */
export const VENDOR_APPLICATION_STATUSES = [
  "pending",
  "under_review",
  "approved",
  "rejected",
  "cancelled",
] as const;

export type VendorApplicationStatus = (typeof VENDOR_APPLICATION_STATUSES)[number];

/** The account-level mirror of the application, carried on the user row. */
export const VENDOR_ACCOUNT_STATES = [
  "none",
  "pending",
  "under_review",
  "approved",
  "rejected",
  "cancelled",
] as const;

export type VendorAccountState = (typeof VENDOR_ACCOUNT_STATES)[number];

/** A pending or in-review applicant holds no access at all. */
export const BLOCKING_APPLICATION_STATUSES: VendorApplicationStatus[] = [
  "pending",
  "under_review",
];

export const isBlockingApplicationStatus = (status?: string | null): boolean =>
  BLOCKING_APPLICATION_STATUSES.includes((status || "") as VendorApplicationStatus);

/** The store's own lifecycle, separate from the application. */
export const VENDOR_STORE_STATUSES = ["active", "suspended", "closed"] as const;
export type VendorStoreStatus = (typeof VENDOR_STORE_STATUSES)[number];

/** What a vendor may set on a product they own. */
export const VENDOR_PRODUCT_STATUSES = [
  "draft",
  "pending_review",
  "published",
  "rejected",
  "archived",
  "out_of_stock",
] as const;
export type VendorProductStatus = (typeof VENDOR_PRODUCT_STATUSES)[number];

/**
 * The two statuses a buyer can reach.
 *
 * The public catalogue serves exactly these, a featured placement may only be
 * bought on these, and leaving them gives the shelf back — so the list lives
 * here once instead of three copies that could drift apart.
 */
export const VENDOR_LIVE_PRODUCT_STATUSES = ["published", "out_of_stock"] as const;

export const isLiveVendorProductStatus = (status?: string | null): boolean =>
  VENDOR_LIVE_PRODUCT_STATUSES.includes(
    status as (typeof VENDOR_LIVE_PRODUCT_STATUSES)[number]
  );

/**
 * The plans the store starts with.
 *
 * These three are seeded on first read; from then on the store team adds,
 * edits and removes plans from the dashboard, so a plan id is any string the
 * plan table holds — not a fixed union. `free` stays reserved because the code
 * falls back to it when a vendor has no live period.
 */
export const VENDOR_PLAN_IDS = ["free", "premium", "advanced"] as const;
export type VendorPlanId = string;

export const BILLING_CYCLES = ["monthly", "yearly"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

/**
 * How good a plan is, for naming an upgrade or a downgrade.
 *
 * Admin-made plans have no fixed rung in a ladder, so the comparison is the
 * monthly price: a dearer plan is an upgrade, a cheaper one a downgrade.
 */
export function planRank(plan: Pick<VendorPlan, "monthlyPrice">): number {
  return Number(plan.monthlyPrice) || 0;
}

export interface VendorPlanLimits {
  /** Active (published) products the plan allows. */
  maxProducts: number;
  /** Products the vendor may pin as featured at the same time. */
  featuredProducts: number;
  /** How long one featured placement runs, in days. */
  featuredDurationDays: number;
  /** Coupons that may be active at the same time. */
  activeCoupons: number;
  analytics: "basic" | "detailed" | "advanced";
  salesReports: "basic" | "advanced";
  exports: PlanExports;
  storeCustomization: "basic" | "enhanced" | "full";
  promotionalCampaigns: "none" | "limited" | "priority";
  storeVisibility: "standard" | "enhanced" | "priority";
  support: "standard" | "priority";
}

/**
 * What a plan may export.
 *
 * Three rungs, not two: the free shop gets no file, the paid plan writes the
 * CSV, and the top plan also builds the PDF — exactly what the report screen
 * offers and what the pricing cards promise.
 */
export const PLAN_EXPORTS = ["none", "csv", "csv+pdf"] as const;
export type PlanExports = (typeof PLAN_EXPORTS)[number];

export interface VendorPlan extends VendorPlanLimits {
  id: VendorPlanId;
  name: string;
  /** Monthly price in the store currency (BDT). */
  monthlyPrice: number;
  /** Yearly price; the default gives two months free. */
  yearlyPrice: number;
  /** Short list the pricing cards show; the limits above stay authoritative. */
  highlights: string[];
  /** Admin can retire a plan without deleting it. */
  isActive: boolean;
  /** Platform commission on this plan, in percent. */
  commissionPercent?: number;
  /** Days a lapsed subscription keeps its benefits before it stops. */
  gracePeriodDays?: number;
  /** Billing periods the plan may be bought for. */
  billingCycles?: BillingCycle[];
  /** Where the plan sits in the admin's list and on the pricing cards. */
  sortOrder?: number;
  /** A price offer, applied while `offerEndsAt` has not passed. */
  offerPercent?: number;
  offerReason?: string;
  offerEndsAt?: string | null;
  /** Decided on the server when the plan is read, so a screen never guesses. */
  offerActive?: boolean;
}

/**
 * The defaults the store starts with. An admin edit is stored as a
 * `subscriptionplans` row and wins over this table; this is only the seed.
 */
export const DEFAULT_VENDOR_PLANS: Record<string, VendorPlan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    yearlyPrice: 0,
    maxProducts: 10,
    featuredProducts: 0,
    featuredDurationDays: 0,
    activeCoupons: 2,
    analytics: "basic",
    salesReports: "basic",
    exports: "none",
    storeCustomization: "basic",
    promotionalCampaigns: "none",
    storeVisibility: "standard",
    support: "standard",
    highlights: [
      "10 active products",
      "2 active coupons",
      "Basic store analytics",
      "Standard store visibility",
    ],
    isActive: true,
    sortOrder: 0,
  },
  premium: {
    id: "premium",
    name: "Premium",
    monthlyPrice: 499,
    yearlyPrice: 4990,
    maxProducts: 50,
    featuredProducts: 3,
    featuredDurationDays: 7,
    activeCoupons: 10,
    analytics: "detailed",
    salesReports: "advanced",
    exports: "csv",
    storeCustomization: "enhanced",
    promotionalCampaigns: "limited",
    storeVisibility: "enhanced",
    support: "priority",
    highlights: [
      "50 active products",
      "3 featured products for 7 days",
      "10 active coupons",
      "Detailed analytics and CSV reports",
      "Enhanced storefront visibility",
      "Priority support",
    ],
    isActive: true,
    sortOrder: 1,
  },
  advanced: {
    id: "advanced",
    name: "Advanced",
    monthlyPrice: 999,
    yearlyPrice: 9990,
    maxProducts: 150,
    featuredProducts: 10,
    featuredDurationDays: 30,
    activeCoupons: 30,
    analytics: "advanced",
    salesReports: "advanced",
    exports: "csv+pdf",
    storeCustomization: "full",
    promotionalCampaigns: "priority",
    storeVisibility: "priority",
    support: "priority",
    highlights: [
      "150 active products",
      "10 featured products for 30 days",
      "30 active coupons",
      "Advanced analytics and conversion reports",
      "Priority featured placement",
      "Full store customization",
      "Priority support",
    ],
    isActive: true,
    sortOrder: 2,
  },
};

/** Price of one billing period for a plan. */
export function planPrice(plan: VendorPlan, cycle: BillingCycle): number {
  return cycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
}

/**
 * True while a plan's price offer is running.
 *
 * An offer with no deadline runs until the store team clears it; a deadline in
 * the past is history, so the full price comes back without anyone editing the
 * row again.
 */
export function planOfferActive(
  plan: Pick<VendorPlan, "offerPercent" | "offerEndsAt">,
  now: number = Date.now()
): boolean {
  const percent = Number(plan.offerPercent) || 0;
  if (percent <= 0 || percent >= 100) return false;
  if (!plan.offerEndsAt) return true;
  const ends = new Date(plan.offerEndsAt).getTime();
  return Number.isFinite(ends) && ends > now;
}

/**
 * What one period costs today.
 *
 * The discount is a percentage of the plan's own price, so it follows a price
 * edit instead of freezing an old amount. The checkout charges this figure and
 * the cards print it, so the two can never disagree.
 */
export function planEffectivePrice(plan: VendorPlan, cycle: BillingCycle): number {
  const price = planPrice(plan, cycle);
  if (price <= 0 || !planOfferActive(plan)) return price;
  const percent = Number(plan.offerPercent) || 0;
  return Math.round(price * (1 - percent / 100) * 100) / 100;
}

/** How many days a billing period covers. */
export function billingDays(cycle: BillingCycle): number {
  return cycle === "yearly" ? 365 : 30;
}

/** A free plan never reaches the demo checkout. */
export const isPaidPlan = (plan: Pick<VendorPlan, "monthlyPrice">): boolean =>
  (Number(plan.monthlyPrice) || 0) > 0;
