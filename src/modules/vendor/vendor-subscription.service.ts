import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { withTransaction } from "../../utils/transactions";
import { Product } from "../product/product.model";
import { Coupon } from "../coupon/coupon.model";
import { FeaturedPromotion } from "./featured-promotion.model";
import { endPromotionsForVendor } from "./featured-promotion.service";
import { SubscriptionPlan } from "./subscription-plan.model";
import { SubscriptionTransaction, VendorSubscription } from "./vendor-subscription.model";
import { getPlan, commissionForPlan } from "./vendor-plan.service";
import { requireStore } from "./vendor-store.service";
import type { CheckoutSubscriptionInput } from "./vendor-subscription.validator";
import {
  VENDOR_LIVE_PRODUCT_STATUSES,
  billingDays,
  planPrice,
  planRank,
  type BillingCycle,
  type VendorPlan,
  type VendorPlanId,
} from "./vendor.types";

/**
 * Starting, renewing and expiring a vendor's subscription.
 *
 * The rules that matter live here, once: a period always gets an end date, a
 * vendor always has at most one live subscription (the database enforces it),
 * and a plan change never rewrites the price or commission already recorded on
 * an earlier period. Everything the dashboards show is read back from these
 * rows, so a rule cannot exist in the UI only.
 */

export interface PlanUsage {
  products: number;
  featuredProducts: number;
  activeCoupons: number;
}

export interface VendorPlanState {
  /** The live row, or the most recent one when nothing is live. */
  subscription: any | null;
  plan: VendorPlan;
  isLive: boolean;
  inGrace: boolean;
  isExpired: boolean;
  /** What the vendor has used against the plan's limits. */
  usage: PlanUsage;
  /** The date benefits stop, if the period is running. */
  effectiveUntil: Date | null;
}

/** The grace period an admin configured for a plan, in days. */
async function graceDaysFor(planId: string): Promise<number> {
  const row: any = await SubscriptionPlan.findOne({ planId } as any)
    .select("gracePeriodDays")
    .lean();
  return Number(row?.gracePeriodDays) || 0;
}

/** Adds `days` to a date without mutating it. */
function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

/** How many active products a vendor has, which is what the limit counts. */
export async function countVendorProducts(vendorId: string): Promise<number> {
  return Product.countDocuments({
    $or: [{ vendorId }, { ownerId: vendorId }],
    vendorProductStatus: { $in: [...VENDOR_LIVE_PRODUCT_STATUSES] },
  });
}

async function countFeatured(vendorId: string): Promise<number> {
  // Only placements the shop bought fill its allowance. A grant from the store
  // team lifts a product without eating a slot somebody paid for, so it is
  // counted on the board but not against the plan.
  return FeaturedPromotion.countDocuments({
    vendorId,
    kind: "product",
    status: "active",
    source: "subscription",
    endsAt: { $gt: new Date() },
  });
}

async function countActiveCoupons(vendorId: string): Promise<number> {
  return Coupon.countDocuments({
    vendorId,
    isActive: true,
    endDate: { $gt: new Date() },
  });
}

/** Everything the limit checks need, in one read pair. */
export async function getUsage(vendorId: string): Promise<PlanUsage> {
  const [products, featuredProducts, activeCoupons] = await Promise.all([
    countVendorProducts(vendorId),
    countFeatured(vendorId),
    countActiveCoupons(vendorId),
  ]);
  return { products, featuredProducts, activeCoupons };
}

/**
 * The live subscription, if any.
 *
 * A row whose period has run out is closed here rather than waiting for the
 * daily sweep, so a vendor who opens their dashboard after midnight sees the
 * truth immediately.
 */
export async function getLiveSubscription(vendorId: string) {
  const now = new Date();
  const rows = await VendorSubscription.find({
    vendorId,
    status: { $in: ["active", "grace"] },
  }).sort({ endDate: -1 });

  for (const row of rows) {
    // A grace row ends at graceEndsAt; an active row at endDate.
    const cutoff = row.status === "grace" ? row.graceEndsAt : row.endDate;
    if (cutoff && cutoff.getTime() > now.getTime()) return row;

    // The period is over: close it and keep going down the list.
    if (row.status === "grace") {
      row.status = "expired";
      row.history.push({ action: "expired", at: now, note: "Grace period ended" });
    } else {
      const graceDays = await graceDaysFor(row.plan);
      if (graceDays > 0) {
        row.status = "grace";
        row.graceEndsAt = addDays(row.endDate, graceDays);
        row.history.push({
          action: "grace",
          at: now,
          note: `${graceDays}-day grace period started`,
        });
        await row.save();
        if (row.graceEndsAt.getTime() > now.getTime()) return row;
        row.status = "expired";
      } else {
        row.status = "expired";
        row.history.push({ action: "expired", at: now, note: "Subscription ended" });
      }
    }
    await row.save();

    // The plan that paid for the featured shelves has ended with this row, so
    // nothing it bought stays lit while the daily sweep is still on its way.
    if (row.status === "expired") {
      await endPromotionsForVendor(String(row.vendorId), "Subscription ended");
    }
  }

  return null;
}

/**
 * The plan a vendor is on right now plus their usage.
 *
 * A vendor with no live row is on the Free limits but flagged expired: they can
 * still see their shop and history, while the services that need a paid plan
 * refuse. Nothing is deleted — an expired vendor keeps every product, order
 * and coupon they ever made.
 */
export async function getVendorPlanState(vendorId: string): Promise<VendorPlanState> {
  const live = await getLiveSubscription(vendorId);
  const latest =
    live ?? (await VendorSubscription.findOne({ vendorId }).sort({ createdAt: -1 }));

  const plan = await getPlan(latest?.plan || "free");
  const now = Date.now();
  const inGrace = Boolean(live && live.status === "grace");
  const isLive = Boolean(live);
  const effectiveUntil: Date | null = live
    ? ((inGrace ? live.graceEndsAt : live.endDate) ?? null)
    : null;
  const lastEnd = latest?.endDate ? latest.endDate.getTime() : null;

  return {
    subscription: latest,
    plan,
    isLive,
    inGrace,
    isExpired: lastEnd !== null && !isLive && lastEnd < now,
    usage: await getUsage(vendorId),
    effectiveUntil,
  };
}

/** A 403 that says what was hit and how to lift it, never a silent failure. */
export function limitMessage(kind: "product" | "featured" | "coupon", used: number, limit: number, plan: VendorPlan): string {
  const noun = kind === "product" ? "products" : kind === "featured" ? "featured products" : "active coupons";
  return `Your ${plan.name} plan allows ${limit} ${noun}. You are using ${used}. Upgrade your plan to add more.`;
}

/**
 * Refuses an action that would exceed a plan limit.
 *
 * Every caller passes the same numbers the screen shows, because the screen
 * reads them from `getVendorPlanState` too. A limit is never checked in the
 * browser only.
 */
export async function assertWithinLimit(
  vendorId: string,
  kind: "product" | "featured" | "coupon",
  state?: VendorPlanState
): Promise<VendorPlanState> {
  const current = state ?? (await getVendorPlanState(vendorId));

  if (!current.isLive) {
    throw new ApiError(
      403,
      "Your subscription has ended. Renew it to continue using vendor features."
    );
  }

  const limit =
    kind === "product"
      ? current.plan.maxProducts
      : kind === "featured"
        ? current.plan.featuredProducts
        : current.plan.activeCoupons;

  const used =
    kind === "product"
      ? current.usage.products
      : kind === "featured"
        ? current.usage.featuredProducts
        : current.usage.activeCoupons;

  if (used >= limit) {
    throw new ApiError(403, limitMessage(kind, used, limit, current.plan));
  }

  return current;
}

interface StartSubscriptionInput {
  vendorId: string;
  storeId: string;
  planId: VendorPlanId;
  billingCycle: BillingCycle;
  /** What the vendor paid, copied from the server-side price. */
  pricePaid?: number;
  purpose?: "activation" | "renewal" | "upgrade" | "downgrade" | "admin";
  /** Who caused it, for the history line. Null means the vendor did. */
  by?: string | null;
  note?: string;
  /** The payment row that paid for it, when there was one. */
  transactionId?: string | null;
}

/**
 * Creates the period a vendor is entitled to.
 *
 * It replaces any previous live row in the same unit of work, so the "one live
 * subscription" index never rejects a legitimate upgrade: the old row is closed
 * first and the new one inserted beside it as history.
 */
export async function startSubscription(input: StartSubscriptionInput) {
  const plan = await getPlan(input.planId);
  const days = billingDays(input.billingCycle);
  const price = input.pricePaid ?? planPrice(plan, input.billingCycle);

  return withTransaction(async (session) => {
    const now = new Date();

    // Close whatever is live, keeping it as history.
    await VendorSubscription.updateMany(
      { vendorId: input.vendorId, status: { $in: ["active", "grace"] } },
      {
        $set: { status: "expired", cancelledAt: now },
        $push: {
          history: {
            action: "expired",
            at: now,
            note: input.purpose === "upgrade" ? "Replaced by an upgrade" : "Replaced",
          },
        },
      },
      { session }
    );

    const subscription = new VendorSubscription({
      vendorId: input.vendorId,
      storeId: input.storeId,
      plan: plan.id,
      billingCycle: input.billingCycle,
      status: "active",
      pricePaid: price,
      startDate: now,
      endDate: addDays(now, days),
      autoRenew: false,
      note: input.note || "",
      history: [
        {
          action:
            input.purpose === "upgrade"
              ? "upgraded"
              : input.purpose === "downgrade"
                ? "downgraded"
                : input.purpose === "renewal"
                  ? "renewed"
                  : "started",
          at: now,
          toPlan: plan.id,
          note: input.note || "",
          by: input.by ?? null,
        },
      ],
    });
    await subscription.save({ session });

    if (input.transactionId) {
      await SubscriptionTransaction.updateOne(
        { _id: input.transactionId },
        {
          $set: {
            subscriptionId: subscription._id,
            periodStart: subscription.startDate,
            periodEnd: subscription.endDate,
          },
        },
        { session }
      );
    }

    return subscription;
  });
}

/**
 * The Free plan, activated the moment an application is approved.
 *
 * Free has no payment, so it also writes a zero-amount row: the subscription
 * history should read the same whether the vendor paid or not.
 */
export async function activateFreePlan(params: {
  vendorId: string;
  storeId: string;
  billingCycle?: BillingCycle;
  by?: string | null;
}) {
  const subscription = await startSubscription({
    vendorId: params.vendorId,
    storeId: params.storeId,
    planId: "free",
    billingCycle: params.billingCycle || "monthly",
    pricePaid: 0,
    purpose: "activation",
    by: params.by ?? null,
    note: "Free plan activated on approval",
  });

  await SubscriptionTransaction.create({
    vendorId: params.vendorId,
    storeId: params.storeId,
    subscriptionId: subscription._id,
    plan: "free",
    billingCycle: params.billingCycle || "monthly",
    amount: 0,
    method: "wallet",
    status: "success",
    reference: `FREE-${String(subscription._id).slice(-6).toUpperCase()}`,
    isDemo: true,
    purpose: "activation",
    periodStart: subscription.startDate,
    periodEnd: subscription.endDate,
    paidAt: new Date(),
  }).catch(() => undefined);

  return subscription;
}

/** The commission rate a vendor's current plan carries, in percent. */
export async function vendorCommission(vendorId: string): Promise<number> {
  const live = await getLiveSubscription(vendorId);
  if (!live) return 0;
  return commissionForPlan(live.plan);
}

/** Ends renewals without cutting the current period short. */
export async function cancelRenewal(vendorId: string) {
  const live = await getLiveSubscription(vendorId);
  if (!live) throw new ApiError(404, "You do not have an active subscription");

  live.autoRenew = false;
  live.cancelledAt = new Date();
  live.history.push({
    action: "cancelled",
    at: new Date(),
    note: "Renewal cancelled; the current period still runs",
  });
  await live.save();
  return live;
}

/**
 * Closes every period that has run past its grace window.
 *
 * Called by the cron endpoint and by an admin by hand. Expiring a subscription
 * stops its benefits and its featured placements; it never deletes a product,
 * an order or a coupon.
 */
export async function expireDueSubscriptions() {
  const now = new Date();
  const rows = await VendorSubscription.find({ status: { $in: ["active", "grace"] } });

  let expired = 0;
  for (const row of rows) {
    const cutoff = row.status === "grace" ? row.graceEndsAt : row.endDate;
    if (cutoff && cutoff.getTime() > now.getTime()) continue;

    if (row.status === "active") {
      const graceDays = await graceDaysFor(row.plan);
      if (graceDays > 0) {
        row.status = "grace";
        row.graceEndsAt = addDays(row.endDate, graceDays);
        row.history.push({ action: "grace", at: now, note: `${graceDays}-day grace period` });
        await row.save();
        continue;
      }
    }

    row.status = "expired";
    row.history.push({ action: "expired", at: now, note: "Subscription ended" });
    await row.save();
    expired += 1;

    // Expired placements stop being featured and dim what they lifted; the
    // products themselves stay exactly as the seller left them.
    await endPromotionsForVendor(String(row.vendorId), "Subscription ended");
  }

  return { expired };
}

/** A vendor's own subscription plus the plans it can move to. */
export async function getSubscriptionOverview(vendorId: string) {
  const state = await getVendorPlanState(vendorId);
  const planService = await import("./vendor-plan.service");
  const [offered, payments, history] = await Promise.all([
    planService.listActivePlans(),
    SubscriptionTransaction.find({ vendorId }).sort({ createdAt: -1 }).limit(50).lean(),
    VendorSubscription.find({ vendorId }).sort({ createdAt: -1 }).limit(50).lean(),
  ]);

  // A plan the store team retired still shows for the vendor standing on it,
  // so the comparison never hides the price they are currently paying.
  const plans = offered.some((plan) => plan.id === state.plan.id)
    ? offered
    : [...offered, state.plan].sort(
        (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.monthlyPrice - b.monthlyPrice
      );

  return { ...state, plans, payments, history };
}

/** Wallet SMS references are letters and digits, never spaces or dashes. */
const WALLET_REFERENCE = /^[A-Z0-9]{8,20}$/;

function normaliseReference(value?: string): string {
  return (value || "").replace(/[\s-]/g, "").toUpperCase();
}

/** Which kind of change a purchase is, read from what the vendor already has. */
function purchasePurpose(
  state: VendorPlanState,
  plan: VendorPlan
): "activation" | "renewal" | "upgrade" | "downgrade" {
  if (!state.isLive) return state.subscription ? "renewal" : "activation";
  if (state.plan.id === plan.id) return "renewal";
  // Plans are not a fixed ladder any more, so a dearer plan is the upgrade.
  return planRank(plan) > planRank(state.plan) ? "upgrade" : "downgrade";
}

/**
 * Buys one plan period.
 *
 * Everything that decides money happens here: the price comes from the plan
 * table, the store and vendor come from the token, and a repeated request with
 * the same `idempotencyKey` returns the first outcome instead of charging
 * twice. A malformed wallet reference is written down as a failed payment so
 * the vendor's history explains why nothing changed.
 */
export async function checkoutSubscription(
  vendorId: string,
  input: CheckoutSubscriptionInput
) {
  const store = await requireStore(vendorId);
  const plan = await getPlan(input.planId);

  // A retired plan cannot be bought, and a plan sold monthly only cannot be
  // taken for a year, whatever a stale tab still shows.
  if (plan.isActive === false) {
    throw new ApiError(400, "This plan is no longer offered");
  }
  if (plan.billingCycles?.length && !plan.billingCycles.includes(input.billingCycle)) {
    throw new ApiError(400, `This plan is only sold ${plan.billingCycles.join(" or ")}`);
  }

  const state = await getVendorPlanState(vendorId);
  const price = planPrice(plan, input.billingCycle);
  const purpose = purchasePurpose(state, plan);

  if (input.idempotencyKey) {
    const previous = await SubscriptionTransaction.findOne({
      vendorId,
      idempotencyKey: input.idempotencyKey,
    }).lean();
    if (previous) {
      return {
        transaction: previous,
        subscription: state.subscription,
        plan,
        price,
        purpose,
        duplicate: true,
      };
    }
  }

  const reference = normaliseReference(input.transactionId);
  const paidByWallet = input.method !== "wallet";

  if (paidByWallet && !WALLET_REFERENCE.test(reference)) {
    await SubscriptionTransaction.create({
      vendorId,
      storeId: store._id,
      plan: plan.id,
      billingCycle: input.billingCycle,
      amount: price,
      method: input.method,
      status: "failed",
      reference: reference || "MISSING",
      purpose,
      idempotencyKey: input.idempotencyKey ?? null,
      failureReason: "The wallet transaction id is missing or malformed",
    }).catch(() => undefined);

    throw new ApiError(
      400,
      "Enter the transaction id from the wallet confirmation SMS, for example 8 to 20 letters or digits."
    );
  }

  let transaction;
  try {
    transaction = await SubscriptionTransaction.create({
      vendorId,
      storeId: store._id,
      plan: plan.id,
      billingCycle: input.billingCycle,
      amount: price,
      method: input.method,
      status: "success",
      reference: reference || `DEMO-${String(store._id).slice(-6).toUpperCase()}`,
      isDemo: true,
      purpose,
      idempotencyKey: input.idempotencyKey ?? null,
      paidAt: new Date(),
    });
  } catch (error) {
    // Two clicks raced past the read above; the unique key kept one payment.
    if ((error as { code?: number }).code === 11000 && input.idempotencyKey) {
      const previous = await SubscriptionTransaction.findOne({
        vendorId,
        idempotencyKey: input.idempotencyKey,
      }).lean();
      return {
        transaction: previous,
        subscription: state.subscription,
        plan,
        price,
        purpose,
        duplicate: true,
      };
    }
    throw error;
  }

  const subscription = await startSubscription({
    vendorId,
    storeId: String(store._id),
    planId: plan.id,
    billingCycle: input.billingCycle,
    pricePaid: price,
    purpose,
    transactionId: String(transaction._id),
    note: `${plan.name} plan · ${input.billingCycle}`,
  });

  return { transaction, subscription, plan, price, purpose, duplicate: false };
}

/** True when the id is a usable ObjectId, so a stray string is a 404 not a crash. */
export function assertObjectId(id: string, message = "Not found"): void {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, message);
}
