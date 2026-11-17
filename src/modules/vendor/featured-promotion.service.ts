import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { Product } from "../product/product.model";
import { VendorStore } from "./vendor-store.model";
import { VendorSubscription } from "./vendor-subscription.model";
import { FeaturedPromotion, type PromotionKind } from "./featured-promotion.model";
import { notifyVendorPromotion } from "./vendor.notifications";
import { isLiveVendorProductStatus, planTierRank, type BillingCycle, type VendorPlanId } from "./vendor.types";
import { getPlan } from "./vendor-plan.service";
import type { GrantPromotionInput } from "./featured-promotion.validator";

/**
 * Featured placements — the one writer of "this is featured".
 *
 * A placement is a dated row: who paid for it (a plan or the store team), what
 * it lifts (one product, or the whole shop) and until when. `Product.isFeatured`
 * and `VendorStore.isFeatured` are only the display switches that this file
 * flips, so a placement that ends can never leave a product shining on the
 * shelves because nobody remembered to turn it off.
 *
 * The state a screen shows is read from the row's status *and* its clock: a host
 * without a running process may not have swept yet, and a placement that has run
 * past `endsAt` is over the moment it does, whoever looks.
 */

/** Who is behind this placement, once the plan check has already been made. */
export interface PromotionActor {
  /** Empty for the store team's own stock, which has no seller behind it. */
  vendorId: string | null;
  /** Empty for the store team's own stock, which has no shop behind it. */
  storeId: string | null;
  plan: VendorPlanId;
  /** The billing period the placement was bought under, when a plan paid for it. */
  billingCycle?: BillingCycle | null;
  /** "subscription" was bought by the seller; "admin" was given by the store team. */
  source: "subscription" | "admin";
  subscriptionId?: string | null;
}

export interface PromotionListQuery {
  status: "all" | "live" | "ended" | "cancelled";
  kind: "all" | PromotionKind;
  page: number;
  limit: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Stops a typo in the admin desk from booking a decade of shelf space. */
const MAX_PROMOTION_DAYS = 365;

/**
 * How the featured shelves are ordered.
 *
 * The store's own stock always leads — the house sits at its own table. Behind
 * it, a seller ranks by the plan that paid: the tier the pricing cards promise
 * (advanced over detailed over basic), then a yearly period over a monthly one,
 * then a longer placement over a shorter. The score is written onto the product
 * while the placement runs, so a public shelf sorts one stored number instead of
 * joining the plan table on every read.
 */
const ADMIN_FEATURED_RANK = 1_000_000;
const TIER_STEP = 10_000;
const YEARLY_BONUS = 5_000;

/**
 * The ordering key one placement writes onto what it lifts.
 *
 * A deleted plan still answers a placement that is already running: the row's
 * own stored key is used in that case, and only a row without one falls back to
 * the bottom tier.
 */
async function featuredRankFor(params: {
  vendorId: string | null;
  plan: VendorPlanId;
  billingCycle?: BillingCycle | null;
  days: number;
}): Promise<number> {
  if (!params.vendorId) return ADMIN_FEATURED_RANK;

  const length = Math.max(0, Math.min(Math.round(params.days) || 0, MAX_PROMOTION_DAYS));
  let tier = 1;
  try {
    tier = planTierRank(await getPlan(params.plan));
  } catch {
    // The plan table no longer holds this row; the placement still ranks, just
    // on the entry tier, rather than the sweep failing over one old plan.
    tier = 1;
  }

  return tier * TIER_STEP + (params.billingCycle === "yearly" ? YEARLY_BONUS : 0) + length;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function daysLeft(endsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS));
}

/** A placement is only truly running while its row is active and its clock is. */
function isLive(row: { status: string; endsAt: Date }, now: Date): boolean {
  return row.status === "active" && row.endsAt.getTime() > now.getTime();
}

type PopulatedProduct = {
  _id?: unknown;
  title?: string;
  image?: string;
  price?: number;
  vendorProductStatus?: string;
  isFeatured?: boolean;
};

type PopulatedStore = { _id?: unknown; name?: string; slug?: string; logo?: string };
type PopulatedUser = { _id?: unknown; name?: string };

/** Enough of the shop and its owner for a board that lists everyone's rows. */
const POPULATE_PRODUCT = "title image price vendorProductStatus isFeatured";
const POPULATE_STORE = "name slug logo";
const POPULATE_VENDOR = "name";

/** What every desk and screen is handed for one placement. */
export interface PromotionDto {
  _id: string;
  kind: PromotionKind;
  /** The stored row: a sweep has not necessarily run yet. */
  status: string;
  /** The same row read against the clock, which is what a screen should show. */
  state: "live" | "ended" | "cancelled";
  source: "subscription" | "admin";
  plan: string;
  vendorId: string | null;
  storeId: string | null;
  subscriptionId: string | null;
  productId: string | null;
  product: {
    _id: string;
    title: string;
    image: string;
    price: number;
    vendorProductStatus: string;
    isFeatured: boolean;
  } | null;
  /** The shop the placement lifts, named so a board of everyone's rows reads. */
  store: { _id: string; name: string; slug: string; logo: string } | null;
  vendorName: string;
  startsAt: Date | null;
  endsAt: Date | null;
  endedAt: Date | null;
  endedReason: string;
  daysRemaining: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

/** The shape every screen reads. Money, ownership and dates come from the row. */
export function toPromotionDto(row: any): PromotionDto {
  const now = new Date();
  const live = isLive(row, now);
  const product = (row.productId && typeof row.productId === "object"
    ? (row.productId as PopulatedProduct)
    : null) as PopulatedProduct | null;
  const populatedStore = (row.storeId && typeof row.storeId === "object"
    ? (row.storeId as PopulatedStore)
    : null) as PopulatedStore | null;
  const populatedVendor = (row.vendorId && typeof row.vendorId === "object"
    ? (row.vendorId as PopulatedUser)
    : null) as PopulatedUser | null;

  let state: "live" | "ended" | "cancelled" = "ended";
  if (row.status === "cancelled") state = "cancelled";
  else if (live) state = "live";

  return {
    _id: String(row._id),
    kind: row.kind,
    status: row.status,
    state,
    source: row.source,
    plan: row.plan,
    vendorId: row.vendorId ? String(row.vendorId) : null,
    storeId: row.storeId ? String(row.storeId) : null,
    subscriptionId: row.subscriptionId ? String(row.subscriptionId) : null,
    productId: row.productId
      ? String(typeof row.productId === "object" ? (row.productId as any)._id ?? row.productId : row.productId)
      : null,
    /** Enough to draw the row without a second read per placement. */
    product: product
      ? {
          _id: String(product._id),
          title: product.title || "",
          image: product.image || "",
          price: Number(product.price) || 0,
          vendorProductStatus: product.vendorProductStatus || "",
          isFeatured: Boolean(product.isFeatured),
        }
      : null,
    /** Both are null / empty when the row was read without its joins. */
    store: populatedStore
      ? {
          _id: String(populatedStore._id),
          name: populatedStore.name || "",
          slug: populatedStore.slug || "",
          logo: populatedStore.logo || "",
        }
      : null,
    vendorName: populatedVendor?.name || "",
    startsAt: row.startsAt ?? null,
    endsAt: row.endsAt ?? null,
    endedAt: row.endedAt ?? null,
    endedReason: row.endedReason || "",
    /** What the desk counts down, and what a seller sees before renewing. */
    daysRemaining: live ? daysLeft(row.endsAt, now) : 0,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** One placement with its product, its shop and its owner attached. */
async function readPromotion(id: string) {
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, "No such promotion");

  const row = await FeaturedPromotion.findById(id)
    .populate("productId", POPULATE_PRODUCT)
    .populate("storeId", POPULATE_STORE)
    .populate("vendorId", POPULATE_VENDOR);
  if (!row) throw new ApiError(404, "No such promotion");
  return row;
}

/**
 * Turns the display switch on for whatever the placement lifted.
 *
 * This is the only place the flags are written from a placement, so the product
 * and the shop can never disagree with the row that paid for them. A product
 * also takes its deadline and its shelf order from the same write.
 */
async function lightUp(
  row: { kind: PromotionKind; productId?: any; storeId?: any },
  endsAt: Date,
  rank: number
) {
  if (row.kind === "product") {
    await Product.updateOne(
      { _id: row.productId },
      { $set: { isFeatured: true, featuredUntil: endsAt, featuredRank: rank } }
    );
    return;
  }

  await VendorStore.updateOne(
    { _id: row.storeId },
    { $set: { isFeatured: true, featuredUntil: endsAt } }
  );
}

/**
 * Puts the shelf back to dark once a placement is over.
 *
 * The ordering key is cleared with the flag: a product that is featured again
 * later is ranked by the placement that lifts it then, never by a stale score
 * from a placement that ended long ago.
 */
async function dim(row: { kind: PromotionKind; productId?: any; storeId?: any }) {
  if (row.kind === "product") {
    await Product.updateOne(
      { _id: row.productId },
      { $set: { isFeatured: false, featuredUntil: null, featuredRank: 0 } }
    );
    return;
  }

  await VendorStore.updateOne(
    { _id: row.storeId },
    { $set: { isFeatured: false, featuredUntil: null } }
  );
}

/** The message a second press gets: the shelf is already booked, and by how long. */
async function assertSlotIsFree(kind: PromotionKind, target: { productId?: string; vendorId?: string }) {
  const now = new Date();
  const clash = await FeaturedPromotion.findOne({
    kind,
    status: "active",
    endsAt: { $gt: now },
    ...(kind === "product" ? { productId: target.productId } : { vendorId: target.vendorId }),
  });

  if (clash) {
    throw new ApiError(
      409,
      kind === "product"
        ? `This product is already featured for ${daysLeft(clash.endsAt, now)} more day(s)`
        : `This store is already featured for ${daysLeft(clash.endsAt, now)} more day(s)`
    );
  }
}

/**
 * Books a placement and switches it on.
 *
 * Every limit question has been answered before this runs — the seller's desk
 * checks the plan, the admin desk checks nothing but its own role. The length
 * always comes from the caller, never from the browser.
 */
export async function createPromotion(
  input: { kind: PromotionKind; productId?: string; days: number },
  actor: PromotionActor
) {
  if (!Number.isFinite(input.days) || input.days <= 0) {
    throw new ApiError(400, "A featured placement needs a length in days");
  }
  if (input.days > MAX_PROMOTION_DAYS) {
    throw new ApiError(400, `A placement cannot run longer than ${MAX_PROMOTION_DAYS} days`);
  }

  if (input.kind === "product") {
    if (!input.productId) throw new ApiError(400, "Choose the product to feature");
    if (!Types.ObjectId.isValid(input.productId)) throw new ApiError(400, "Choose the product to feature");
    await assertSlotIsFree("product", { productId: input.productId });
  } else {
    if (input.productId) throw new ApiError(400, "A store placement does not take a product");
    // A shop always has a seller; the store's own stock has no shop to lift.
    if (!actor.vendorId) throw new ApiError(400, "A store placement needs the seller whose shop to lift");
    await assertSlotIsFree("store", { vendorId: actor.vendorId });
  }

  const now = new Date();
  const endsAt = addDays(now, Math.min(input.days, MAX_PROMOTION_DAYS));
  const rank = await featuredRankFor({
    vendorId: actor.vendorId,
    plan: actor.plan,
    billingCycle: actor.billingCycle ?? null,
    days: input.days,
  });

  const created = await FeaturedPromotion.create({
    // Both are empty for the store team's own stock, which has no seller and no
    // shop behind it; the placement is still dated and still the store's own.
    vendorId: actor.vendorId ? new Types.ObjectId(actor.vendorId) : null,
    storeId: actor.storeId ? new Types.ObjectId(actor.storeId) : null,
    kind: input.kind,
    productId: input.kind === "product" ? new Types.ObjectId(input.productId!) : null,
    status: "active",
    subscriptionId: actor.subscriptionId ? new Types.ObjectId(actor.subscriptionId) : null,
    plan: actor.plan,
    source: actor.source,
    billingCycle: actor.billingCycle ?? null,
    featuredRank: rank,
    startsAt: now,
    endsAt,
  });

  await lightUp(created, endsAt, rank);
  return toPromotionDto(await readPromotion(String(created._id)));
}

/** One vendor's placements, newest first. The store team may ask for everyone's. */
export async function listPromotions(query: PromotionListQuery, scope?: { vendorId?: string }) {
  const now = new Date();
  const filter: Record<string, unknown> = {};
  if (scope?.vendorId) filter.vendorId = new Types.ObjectId(scope.vendorId);
  if (query.kind !== "all") filter.kind = query.kind;

  if (query.status === "live") {
    filter.status = "active";
    filter.endsAt = { $gt: now };
  } else if (query.status === "ended") {
    filter.$or = [{ status: "expired" }, { status: "active", endsAt: { $lte: now } }];
  } else if (query.status === "cancelled") {
    filter.status = "cancelled";
  }

  const rows = await FeaturedPromotion.find(filter)
    .populate("productId", POPULATE_PRODUCT)
    .populate("storeId", POPULATE_STORE)
    .populate("vendorId", POPULATE_VENDOR)
    .sort({ startsAt: -1, createdAt: -1 })
    .lean();

  // The tabs count the same reading the rows use, so a "live" chip and the rows
  // beneath it cannot disagree while a sweep is still on its way.
  const dtos = rows.map(toPromotionDto);
  const stateCounts = dtos.reduce<Record<string, number>>((counts, row) => {
    counts[row.state as string] = (counts[row.state as string] || 0) + 1;
    counts.all = (counts.all || 0) + 1;
    return counts;
  }, {});

  const total = dtos.length;
  const start = (query.page - 1) * query.limit;

  return {
    promotions: dtos.slice(start, start + query.limit),
    total,
    stateCounts,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.max(Math.ceil(total / query.limit), 1),
    },
  };
}

/**
 * Closes one placement early.
 *
 * A foreign id answers 404 rather than confirming the row exists. Cancelling is
 * not a deletion: the row stays so the seller's desk can still say what ran, for
 * how long and why it stopped, and the slot it occupied is freed by the row no
 * longer being active.
 */
export async function endPromotion(id: string, reason: string, scope?: { vendorId?: string }) {
  const row = await readPromotion(id);
  if (scope?.vendorId && String(row.vendorId) !== String(scope.vendorId)) {
    throw new ApiError(404, "No such promotion");
  }

  if (row.status !== "active") {
    throw new ApiError(400, "This placement has already ended");
  }

  row.status = "cancelled";
  row.endedAt = new Date();
  row.endedReason = reason;
  await row.save();
  await dim(row);

  return toPromotionDto(await readPromotion(id));
}

/** The daily sweep: everything whose clock ran out stops being featured. */
export async function expireDuePromotions() {
  const now = new Date();
  const stale = await FeaturedPromotion.find({ status: "active", endsAt: { $lte: now } });

  for (const row of stale) {
    row.status = "expired";
    row.endedAt = now;
    row.endedReason = row.endedReason || "Featured period ended";
    await row.save();
    await dim(row);
  }

  // Every placement still running re-states the shelf order it wrote, which
  // repairs a row that was lit before the order existed (or edited by hand)
  // without anybody having to press a button.
  const live = await FeaturedPromotion.find({
    kind: "product",
    status: "active",
    endsAt: { $gt: now },
  }).lean();

  for (const row of live) {
    const stored = Number((row as any).featuredRank) || 0;
    const rank =
      stored > 0
        ? stored
        : await featuredRankFor({
            vendorId: row.vendorId ? String(row.vendorId) : null,
            plan: String(row.plan || "free"),
            billingCycle: ((row as any).billingCycle as BillingCycle | null) ?? null,
            days: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / DAY_MS),
          });

    await Product.updateOne(
      { _id: row.productId },
      { $set: { isFeatured: true, featuredUntil: row.endsAt, featuredRank: rank } }
    );
  }

  return { expired: stale.length };
}

/**
 * Closes whatever placement is lifting one product.
 *
 * A listing the seller archived or unpublished cannot be bought, so the shelf it
 * was pinned to is given back instead of going on showing something nobody can
 * reach. Not a placement to end is a normal answer, so this is safe to call from
 * any status change.
 */
export async function endPlacementForProduct(productId: string, reason: string) {
  if (!Types.ObjectId.isValid(productId)) return { ended: 0 };

  const rows = await FeaturedPromotion.find({
    productId: new Types.ObjectId(productId),
    kind: "product",
    status: "active",
  });
  const now = new Date();

  for (const row of rows) {
    row.status = "cancelled";
    row.endedAt = now;
    row.endedReason = reason;
    await row.save();
    await dim(row);
  }

  return { ended: rows.length };
}

/**
 * Closes a vendor's whole board of placements, with a reason.
 *
 * Called when a subscription ends: the shop keeps its products, orders and
 * coupons, but nothing it bought with the expired plan stays on the shelves.
 */
export async function endPromotionsForVendor(vendorId: string, reason: string) {
  const rows = await FeaturedPromotion.find({ vendorId: new Types.ObjectId(vendorId), status: "active" });
  const now = new Date();

  for (const row of rows) {
    row.status = "expired";
    row.endedAt = now;
    row.endedReason = reason;
    await row.save();
    await dim(row);
  }

  return { ended: rows.length };
}

/**
 * The store team's own grant, outside any plan.
 *
 * A grant is still a dated placement, not a permanent flag: it runs for the days
 * the admin chose and then lapses through the same sweep, so a favour done last
 * quarter cannot still be lighting up a shelf nobody remembers. Who it belongs to
 * is read from the row being lifted, so no request can park a shop's goods on
 * someone else's shelf.
 */
export async function grantByAdmin(input: GrantPromotionInput) {
  if (input.kind === "product") {
    const product = await Product.findById(input.productId).lean();
    if (!product) throw new ApiError(404, "No such product");

    const row = product as any;
    // `vendorId` is what tells a seller's listing from the store's own stock: a
    // platform row has an owner but no seller. Both may be featured here, but a
    // seller's row is always lifted on that seller's shop, never on another's.
    const vendorId = String(row.vendorId || "");
    const sellerOwned = Types.ObjectId.isValid(vendorId);

    // A grant obeys the same rule as a purchase: the shelf is bought on something
    // a buyer can actually reach, or the paid-for space shows nothing.
    if (row.isVisible === false) {
      throw new ApiError(
        400,
        `Only a listed product can be featured. "${row.title || "This product"}" is hidden from buyers`
      );
    }
    if (sellerOwned && !isLiveVendorProductStatus(row.vendorProductStatus)) {
      throw new ApiError(
        400,
        `Only a listed product can be featured. "${row.title || "This product"}" is ${
          row.vendorProductStatus || "not on sale"
        }`
      );
    }

    // The store's own stock has no shop to read and nobody to notify, but the
    // shelf is still dated: it goes dark on the same sweep as everyone else's.
    if (!sellerOwned) {
      return createPromotion(
        { kind: "product", productId: String(product._id), days: input.days },
        { vendorId: null, storeId: null, plan: "platform", source: "admin" }
      );
    }

    // The shop is read from the seller rather than trusted from the product, so
    // a row cannot be pointed at somebody else's storefront.
    const store = await VendorStore.findOne({ userId: vendorId });
    if (!store) throw new ApiError(404, "That product's seller has no store on the marketplace");

    const sellerPlan = await planFor(vendorId);

    const created = await createPromotion(
      { kind: "product", productId: String(product._id), days: input.days },
      {
        vendorId,
        storeId: String(store._id),
        plan: sellerPlan.plan,
        billingCycle: sellerPlan.billingCycle,
        source: "admin",
      }
    );

    await notifyVendorPromotion({
      userId: vendorId,
      title: `"${(product as any).title || "A product"}" is featured`,
      detail: input.reason
        ? `${input.days} days on the featured shelves — ${input.reason}`
        : `${input.days} days on the featured shelves, granted by the store team`,
      promotionId: String(created._id),
    });

    return created;
  }

  const vendorId = String(input.vendorId);
  const store = await VendorStore.findOne({ userId: vendorId });
  if (!store) throw new ApiError(404, "No store is linked to that seller");

  const sellerPlan = await planFor(vendorId);

  const created = await createPromotion(
    { kind: "store", days: input.days },
    {
      vendorId,
      storeId: String(store._id),
      plan: sellerPlan.plan,
      billingCycle: sellerPlan.billingCycle,
      source: "admin",
    }
  );

  await notifyVendorPromotion({
    userId: vendorId,
    title: "Your store is featured",
    detail: input.reason
      ? `${input.days} days in the featured shops row — ${input.reason}`
      : `${input.days} days in the featured shops row, granted by the store team`,
    promotionId: String(created._id),
  });

  return created;
}

/**
 * Pulls a placement back before its date.
 *
 * The row survives with the reason written on it, so the seller can read why the
 * shelf went quiet instead of guessing.
 */
export async function revokeByAdmin(id: string, reason: string) {
  const row = await readPromotion(id);
  const closed = await endPromotion(id, reason);

  if (row.vendorId) {
    await notifyVendorPromotion({
      userId: String(row.vendorId),
      title: "A featured placement has ended",
      detail: `${reason} — ${closed.kind === "store" ? "the store" : `"${closed.product?.title || "the product"}"`} is no longer featured.`,
      promotionId: id,
    });
  }

  return closed;
}

/** The plan and period behind an admin grant: the live one, or free when there is none. */
async function planFor(
  vendorId: string
): Promise<{ plan: VendorPlanId; billingCycle: BillingCycle | null }> {
  const live = await VendorSubscription.findOne({
    vendorId: new Types.ObjectId(vendorId),
    status: { $in: ["active", "grace"] },
  })
    .sort({ endDate: -1 })
    .select("plan billingCycle")
    .lean();

  return {
    plan: ((live as any)?.plan as VendorPlanId) || "free",
    billingCycle: ((live as any)?.billingCycle as BillingCycle) ?? null,
  };
}
