import { ApiError } from "../../utils/apiError";
import { SubscriptionPlan } from "./subscription-plan.model";
import { VendorSubscription } from "./vendor-subscription.model";
import {
  DEFAULT_VENDOR_PLANS,
  VENDOR_PLAN_IDS,
  planOfferActive,
  type BillingCycle,
  type PlanExports,
  type VendorPlan,
} from "./vendor.types";

/**
 * The single place a plan is read from.
 *
 * The defaults in `vendor.types.ts` seed the collection once; after that the
 * rows here are the price list the store team maintains from the dashboard.
 * Everything — the pricing cards, the limit checks, the expiry sweep — goes
 * through this file, so a changed price can never disagree with a changed
 * limit, and a plan added later needs no code change.
 */

/** What a plan looks like when the store team leaves a limit out. */
const BLANK_PLAN = {
  name: "Plan",
  monthlyPrice: 0,
  yearlyPrice: 0,
  maxProducts: 0,
  featuredProducts: 0,
  featuredDurationDays: 0,
  activeCoupons: 0,
  analytics: "basic",
  salesReports: "basic",
  exports: "none",
  storeCustomization: "basic",
  promotionalCampaigns: "none",
  storeVisibility: "standard",
  support: "standard",
  highlights: [],
  isActive: true,
  commissionPercent: 0,
  gracePeriodDays: 0,
  billingCycles: ["monthly", "yearly"] as BillingCycle[],
  sortOrder: 0,
  offerPercent: 0,
  offerReason: "",
  offerEndsAt: null,
} satisfies Omit<VendorPlan, "id">;

/**
 * Reads the export rung from rows written before the three rungs existed.
 *
 * "limited" was a totals-and-chart file, so the free rung keeps no file at all
 * while any paid row keeps the CSV; "full" always meant the PDF as well.
 */
function normalizeExports(value: unknown, planId: string): PlanExports {
  if (value === "none" || value === "csv" || value === "csv+pdf") return value;
  if (value === "full") return "csv+pdf";
  if (value === "limited") return planId === "free" ? "none" : "csv";
  return "none";
}

/** Turns one stored row into the shape the rest of the app uses. */
function fromRow(row: any): VendorPlan {
  const fallback = DEFAULT_VENDOR_PLANS[row.planId] ?? BLANK_PLAN;
  return {
    id: String(row.planId),
    name: row.name ?? fallback.name,
    monthlyPrice: Number(row.monthlyPrice ?? fallback.monthlyPrice) || 0,
    yearlyPrice: Number(row.yearlyPrice ?? fallback.yearlyPrice) || 0,
    maxProducts: Number(row.maxProducts ?? fallback.maxProducts) || 0,
    featuredProducts: Number(row.featuredProducts ?? fallback.featuredProducts) || 0,
    featuredDurationDays:
      Number(row.featuredDurationDays ?? fallback.featuredDurationDays) || 0,
    activeCoupons: Number(row.activeCoupons ?? fallback.activeCoupons) || 0,
    analytics: row.analytics ?? fallback.analytics,
    salesReports: row.salesReports ?? fallback.salesReports,
    exports: normalizeExports(row.exports ?? fallback.exports, String(row.planId)),
    storeCustomization: row.storeCustomization ?? fallback.storeCustomization,
    promotionalCampaigns: row.promotionalCampaigns ?? fallback.promotionalCampaigns,
    storeVisibility: row.storeVisibility ?? fallback.storeVisibility,
    support: row.support ?? fallback.support,
    highlights: row.highlights?.length ? row.highlights : fallback.highlights,
    isActive: row.isActive ?? fallback.isActive,
    commissionPercent: Number(row.commissionPercent ?? fallback.commissionPercent) || 0,
    gracePeriodDays: Number(row.gracePeriodDays ?? fallback.gracePeriodDays) || 0,
    billingCycles: row.billingCycles?.length ? row.billingCycles : fallback.billingCycles,
    sortOrder: Number(row.sortOrder ?? fallback.sortOrder) || 0,
    offerPercent: Number(row.offerPercent ?? fallback.offerPercent) || 0,
    offerReason: row.offerReason ?? fallback.offerReason ?? "",
    offerEndsAt: row.offerEndsAt
      ? new Date(row.offerEndsAt).toISOString()
      : fallback.offerEndsAt ?? null,
    offerActive: planOfferActive({
      offerPercent: Number(row.offerPercent ?? fallback.offerPercent) || 0,
      offerEndsAt: row.offerEndsAt
        ? new Date(row.offerEndsAt).toISOString()
        : fallback.offerEndsAt ?? null,
    }),
  };
}

/**
 * Writes the starting price list into an empty collection.
 *
 * It only seeds when no plan exists at all, so a plan the store team deleted
 * stays deleted instead of reappearing on the next page load. Two concurrent
 * first reads race here; the unique `planId` index keeps one set of rows and
 * the duplicate error is ignored.
 */
export async function ensurePlansSeeded(): Promise<void> {
  const existing = await SubscriptionPlan.estimatedDocumentCount();
  if (existing > 0) return;

  try {
    await SubscriptionPlan.insertMany(
      VENDOR_PLAN_IDS.map((planId) => ({ ...DEFAULT_VENDOR_PLANS[planId], planId }))
    );
  } catch {
    // Another request seeded at the same moment.
  }
}

/** The whole price list, cheapest rung first. */
export async function listPlans(): Promise<VendorPlan[]> {
  await ensurePlansSeeded();
  const rows = await SubscriptionPlan.find({}).lean();

  // A store that has deleted every row still needs prices to show, so the
  // defaults answer rather than an empty page.
  if (rows.length === 0) {
    return VENDOR_PLAN_IDS.map((planId) => DEFAULT_VENDOR_PLANS[planId]);
  }

  return rows
    .map(fromRow)
    .sort(
      (a, b) =>
        (a.sortOrder ?? 0) - (b.sortOrder ?? 0) ||
        a.monthlyPrice - b.monthlyPrice ||
        a.name.localeCompare(b.name)
    );
}

/** The plans a buyer may choose: everything the store has not retired. */
export async function listActivePlans(): Promise<VendorPlan[]> {
  const plans = await listPlans();
  return plans.filter((plan) => plan.isActive !== false);
}

/** One plan, or a 400 naming the value that was sent. */
export async function getPlan(planId: string): Promise<VendorPlan> {
  await ensurePlansSeeded();
  const row: any = await SubscriptionPlan.findOne({ planId }).lean();
  if (row) return fromRow(row);

  // `free` is the rung the code falls back to when a vendor has no live
  // period, so it answers even before the row exists.
  if (planId === "free") return DEFAULT_VENDOR_PLANS.free;

  throw new ApiError(400, "Unknown subscription plan");
}

/** A plan id made from the name, so a new plan needs no code change. */
function slugifyPlanId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "plan";
}

/** Everything an admin may write on a plan. */
export interface PlanInput {
  name?: string;
  monthlyPrice?: number;
  yearlyPrice?: number;
  maxProducts?: number;
  featuredProducts?: number;
  featuredDurationDays?: number;
  activeCoupons?: number;
  analytics?: string;
  salesReports?: string;
  exports?: string;
  storeCustomization?: string;
  promotionalCampaigns?: string;
  storeVisibility?: string;
  support?: string;
  highlights?: string[];
  isActive?: boolean;
  commissionPercent?: number;
  gracePeriodDays?: number;
  billingCycles?: string[];
  sortOrder?: number;
  offerPercent?: number;
  offerReason?: string;
  offerEndsAt?: Date | null;
}

const WRITABLE_FIELDS = [
  "name",
  "monthlyPrice",
  "yearlyPrice",
  "maxProducts",
  "featuredProducts",
  "featuredDurationDays",
  "activeCoupons",
  "analytics",
  "salesReports",
  "exports",
  "storeCustomization",
  "promotionalCampaigns",
  "storeVisibility",
  "support",
  "highlights",
  "isActive",
  "commissionPercent",
  "gracePeriodDays",
  "billingCycles",
  "sortOrder",
  "offerPercent",
  "offerReason",
  "offerEndsAt",
] as const;

/** Copies only the fields that were sent, so a partial edit stays partial. */
function pickWritable(patch: PlanInput): Record<string, unknown> {
  const allowed: Record<string, unknown> = {};
  for (const field of WRITABLE_FIELDS) {
    if (patch[field] !== undefined) allowed[field] = patch[field];
  }
  return allowed;
}

/**
 * Adds a plan to the price list.
 *
 * The id is derived from the name, so two plans cannot share one and a link to
 * a plan keeps working after a rename is refused by the caller's edit path.
 */
export async function createPlan(input: PlanInput, adminId?: string): Promise<VendorPlan> {
  const name = (input.name || "").trim();
  if (name.length < 2) throw new ApiError(400, "Give the plan a name");

  await ensurePlansSeeded();

  const planId = slugifyPlanId(name);
  const existing = await SubscriptionPlan.findOne({ planId }).lean();
  if (existing) throw new ApiError(400, "A plan with this name already exists");

  const last: any = await SubscriptionPlan.findOne({}).sort({ sortOrder: -1 }).lean();
  const row = {
    ...pickWritable(input),
    planId,
    name,
    sortOrder: input.sortOrder ?? Number(last?.sortOrder ?? -1) + 1,
    updatedBy: adminId ?? null,
  };

  await SubscriptionPlan.create(row);
  return getPlan(planId);
}

/**
 * An admin edit. Only the fields sent are written, and a plan can be retired
 * (`isActive: false`) without deleting the vendors already on it.
 */
export async function updatePlan(
  planId: string,
  patch: PlanInput,
  adminId?: string
): Promise<VendorPlan> {
  await getPlan(planId);

  const allowed = pickWritable(patch);
  if (Object.keys(allowed).length === 0) {
    throw new ApiError(400, "Nothing to update");
  }

  allowed.updatedBy = adminId ?? null;

  await SubscriptionPlan.updateOne({ planId }, { $set: allowed }, { upsert: true });
  return getPlan(planId);
}

/**
 * Removes a plan from the price list.
 *
 * The free rung stays because the code falls the back on it, and a plan a
 * vendor is still subscribed to stays until those periods end — deleting it
 * would leave a live period pointing at nothing.
 */
export async function deletePlan(planId: string): Promise<{ planId: string }> {
  if (planId === "free") {
    throw new ApiError(400, "The free plan cannot be deleted. Deactivate it instead.");
  }

  const live = await VendorSubscription.countDocuments({
    plan: planId,
    status: { $in: ["active", "grace"] },
  });
  if (live > 0) {
    throw new ApiError(
      400,
      `${live} vendor${live === 1 ? "" : "s"} still on this plan. Deactivate it and delete it once those periods end.`
    );
  }

  const result = await SubscriptionPlan.deleteOne({ planId });
  if (result.deletedCount === 0) throw new ApiError(404, "Plan not found");

  return { planId };
}

/**
 * The commission that applies to a plan, in percent.
 *
 * It is read from the plan row, so changing the rate changes future sales only:
 * each delivered line stores the rate it was sold under.
 */
export async function commissionForPlan(planId: string): Promise<number> {
  await ensurePlansSeeded();
  const row: any = await SubscriptionPlan.findOne({ planId })
    .select("commissionPercent")
    .lean();
  return Number(row?.commissionPercent) || 0;
}
