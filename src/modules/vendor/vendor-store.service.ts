import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { VendorStore } from "./vendor-store.model";
import { VendorOrder } from "./vendor-order.model";
import type { StoreQuery, UpdateStoreInput, PublicStoreQuery } from "./vendor-store.validator";

/**
 * The vendor's own storefront.
 *
 * A vendor reads and edits exactly one row: the one whose `userId` is the
 * signed-in account. The id is never taken from the request, so there is no
 * path through this module that can reach another seller's shop. The store
 * team reads the whole list, and the promotions service is the only writer of
 * the featured flags this row carries.
 */

/** Turns the stored row into the shape the dashboard edits. */
export function toStoreDto(store: any) {
  return {
    _id: String(store._id),
    name: store.name || "",
    slug: store.slug || "",
    description: store.description || "",
    logo: store.logo || "",
    coverImage: store.coverImage || "",
    email: store.email || "",
    phone: store.phone || "",
    category: store.category || "",
    website: store.website || "",
    address: {
      country: store.address?.country || "",
      division: store.address?.division || "",
      city: store.address?.city || "",
      area: store.address?.area || "",
      address: store.address?.address || "",
      postalCode: store.address?.postalCode || "",
      latitude: store.address?.latitude ?? null,
      longitude: store.address?.longitude ?? null,
    },
    socialLinks: {
      facebook: store.socialLinks?.facebook || "",
      instagram: store.socialLinks?.instagram || "",
      x: store.socialLinks?.x || "",
      linkedin: store.socialLinks?.linkedin || "",
    },
    warehouse: {
      label: store.warehouse?.label || "",
      address: store.warehouse?.address || "",
      city: store.warehouse?.city || "",
      area: store.warehouse?.area || "",
      postalCode: store.warehouse?.postalCode || "",
      phone: store.warehouse?.phone || "",
    },
    status: store.status,
    isVisible: store.isVisible !== false,
    isFeatured: Boolean(store.isFeatured),
    featuredUntil: store.featuredUntil ?? null,
    productCount: Number(store.productCount) || 0,
    reviewCount: Number(store.reviewCount) || 0,
    rating: Number(store.rating) || 0,
    completedOrders: Number(store.completedOrders) || 0,
    suspendedReason: store.suspendedReason || "",
    createdAt: store.createdAt,
    updatedAt: store.updatedAt,
  };
}

/** The signed-in vendor's store, or a 404 that names the missing link. */
export async function requireStore(userId: string) {
  const store = await VendorStore.findOne({ userId });
  if (!store) {
    throw new ApiError(404, "No store is linked to this account yet");
  }
  return store;
}

const BLOCKED_STORE_STATUSES = ["suspended", "closed"] as const;

/**
 * A shop that cannot trade cannot use the benefits it paid for either.
 *
 * Each desk says what it was about to do, because a seller told only to
 * "contact the store team" has no way of saying what to contact them about.
 */
export async function requireTradingStore(userId: string, action: string) {
  const store = await requireStore(userId);
  if (BLOCKED_STORE_STATUSES.includes(store.status as (typeof BLOCKED_STORE_STATUSES)[number])) {
    throw new ApiError(
      403,
      `This store is ${store.status}. Contact the store team before ${action}.`
    );
  }
  return store;
}

export async function getMyStore(userId: string) {
  return toStoreDto(await requireStore(userId));
}

/** Only the fields the storefront renders are editable; the slug and the
 * counters belong to the platform. */
const EDITABLE_FIELDS = [
  "name",
  "description",
  "logo",
  "coverImage",
  "email",
  "phone",
  "category",
  "website",
  "address",
  "warehouse",
  "socialLinks",
] as const;

/**
 * An edit of the signed-in vendor's store.
 *
 * Two rules are enforced here rather than in the browser: a closed shop cannot
 * be reopened by its owner, and a suspended shop is forced hidden no matter
 * what the form sent. The slug never changes, because every published link to
 * the store is built from it.
 */
export async function updateMyStore(userId: string, patch: UpdateStoreInput) {
  const store = await requireStore(userId);

  if (store.status === "closed") {
    throw new ApiError(403, "This store is closed. Contact the store team to reopen it.");
  }

  const update: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (patch[field] !== undefined) update[field] = patch[field];
  }

  if (patch.isVisible !== undefined) {
    update.isVisible = store.status === "active" ? patch.isVisible : false;
  }

  if (Object.keys(update).length === 0) {
    throw new ApiError(400, "Nothing to update");
  }

  const updated = await VendorStore.findOneAndUpdate(
    { _id: store._id, userId },
    { $set: update },
    { new: true, runValidators: true }
  );

  if (!updated) throw new ApiError(404, "No store is linked to this account yet");
  return toStoreDto(updated);
}

/**
 * The shop as a stranger sees it.
 *
 * The seller's phone, email, exact address and suspension note are the
 * platform's private record; a public page gets what a shopper can act on —
 * the signboard, the contact buttons the seller chose to publish, and the
 * numbers the platform keeps honest. `socialLinks` and `website` stay, because
 * a seller fills them to be reached. The warehouse address never leaves: it is
 * where a rider collects, not where a shopper visits.
 */
export function toPublicStoreDto(store: any) {
  const dto = toStoreDto(store);
  return {
    _id: dto._id,
    name: dto.name,
    slug: dto.slug,
    description: dto.description,
    logo: dto.logo,
    coverImage: dto.coverImage,
    category: dto.category,
    website: dto.website,
    socialLinks: dto.socialLinks,
    address: {
      country: dto.address.country,
      division: dto.address.division,
      city: dto.address.city,
      area: dto.address.area,
    },
    isFeatured: Boolean(dto.isFeatured && (!dto.featuredUntil || new Date(dto.featuredUntil) > new Date())),
    productCount: dto.productCount,
    reviewCount: dto.reviewCount,
    rating: dto.rating,
    completedOrders: dto.completedOrders,
    // Filled by `withSuccessRates` on the two public reads; a store that has
    // never closed a parcel reads 0 rather than a misleading 100.
    successRate: 0,
    createdAt: dto.createdAt,
  };
}

/**
 * How often a shop's parcels actually arrived.
 *
 * Only parcels that reached an end are counted: a group still moving is
 * neither a success nor a failure, so the figure is delivered against
 * delivered-plus-stopped. A shop with nothing closed yet reads 0 — a brand-new
 * seller has no record to boast about, and 100% off zero parcels would be a
 * number the shop never earned.
 */
async function successRatesOf(storeIds: string[]): Promise<Map<string, number>> {
  const ids = storeIds
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
  if (ids.length === 0) return new Map();

  const rows = await VendorOrder.aggregate([
    { $match: { storeId: { $in: ids } } },
    {
      $group: {
        _id: "$storeId",
        delivered: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } },
        stopped: {
          $sum: { $cond: [{ $in: ["$status", ["cancelled", "rejected"]] }, 1, 0] },
        },
      },
    },
  ]);

  const rates = new Map<string, number>();
  for (const row of rows) {
    const closed = (Number(row.delivered) || 0) + (Number(row.stopped) || 0);
    rates.set(
      String(row._id),
      closed > 0 ? Math.round(((Number(row.delivered) || 0) / closed) * 100) : 0
    );
  }
  return rates;
}

/** Folds the closed-parcel record into the public rows that were already mapped. */
async function withSuccessRates<T extends { _id: string }>(stores: T[]): Promise<(T & { successRate: number })[]> {
  const rates = await successRatesOf(stores.map((store) => store._id));
  return stores.map((store) => ({ ...store, successRate: rates.get(store._id) ?? 0 }));
}

/** The store a public page reads: visible, active and not suspended. */
export async function getVisibleStoreBySlug(slug: string) {
  const store = await VendorStore.findOne({
    slug: slug.trim().toLowerCase(),
    isVisible: true,
    status: "active",
  }).lean();

  if (!store) throw new ApiError(404, "Store not found");
  return toStoreDto(store);
}

/** The same shop for a public page, with the private fields off. */
export async function getPublicStoreBySlug(slug: string) {
  const store = toPublicStoreDto(await getVisibleStoreBySlug(slug));
  const [withRate] = await withSuccessRates([store]);
  return withRate;
}

const PUBLIC_STORE_SORTS: Record<string, Record<string, 1 | -1>> = {
  featured: { isFeatured: -1, rating: -1, productCount: -1 },
  rating: { rating: -1, reviewCount: -1 },
  newest: { createdAt: -1 },
  popular: { completedOrders: -1, lifetimeSales: -1 },
  // The placement granted most recently runs the longest, so it leads: the
  // featured rail reads as "what was just lit up" rather than an old favourite.
  latest: { featuredUntil: -1, createdAt: -1 },
};

/**
 * One page of trading shops, for the storefront and the discovery page.
 *
 * A hidden or suspended shop is not here at all — the model comment says a
 * hidden shop stays reachable by link, which is what the single read allows —
 * and a featured flag whose placement has expired is filtered defensively, so
 * a sweep that has not run yet cannot leave a dead shop on the rail.
 */
export async function listPublicStores(query: PublicStoreQuery) {
  const { search, category, featured, sort, page, limit } = query;
  const filter: Record<string, unknown> = { isVisible: true, status: "active" };

  if (search?.trim()) {
    const match = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ name: match }, { description: match }, { category: match }];
  }
  if (category?.trim()) filter.category = category.trim();
  if (featured === true) {
    filter.isFeatured = true;
    filter.$and = [
      { $or: [{ featuredUntil: null }, { featuredUntil: { $exists: false } }, { featuredUntil: { $gt: new Date() } }] },
    ];
  }

  const [rows, total] = await Promise.all([
    VendorStore.find(filter)
      .sort(PUBLIC_STORE_SORTS[sort] ?? PUBLIC_STORE_SORTS.featured)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    VendorStore.countDocuments(filter),
  ]);

  return {
    stores: await withSuccessRates(rows.map(toPublicStoreDto)),
    total,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One page of shops, for the desks that must pick one among everyone's.
 *
 * The row keeps the seller's account id, because that is what a placement is
 * granted to — a featured shop belongs to the vendor, and the store is read
 * back from them rather than sent along.
 */
export async function listStores(query: StoreQuery) {
  const { search, status, featured, page, limit } = query;
  const filter: Record<string, unknown> = {};

  if (status !== "all") filter.status = status;
  if (featured === true) filter.isFeatured = true;

  if (search?.trim()) {
    const match = new RegExp(escapeRegex(search.trim()), "i");
    filter.$or = [{ name: match }, { slug: match }, { category: match }, { email: match }];
  }

  const [rows, total] = await Promise.all([
    VendorStore.find(filter)
      .populate("userId", "name email image")
      .sort({ isFeatured: -1, productCount: -1, name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    VendorStore.countDocuments(filter),
  ]);

  return {
    stores: rows.map((store: any) => ({
      ...toStoreDto(store),
      userId: String(store.userId?._id ?? store.userId ?? ""),
      ownerName: store.userId?.name || "",
      ownerEmail: store.userId?.email || "",
    })),
    total,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
  };
}
