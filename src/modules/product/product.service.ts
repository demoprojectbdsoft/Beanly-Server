import { Product } from "./product.model";
import { ProductReview } from "../review/review.model";
import { Category } from "../category/category.model";
import { SubCategory } from "../subcategory/subcategory.model";
import { VendorStore } from "../vendor/vendor-store.model";
import { endPlacementForProduct } from "../vendor/featured-promotion.service";
import { Order } from "../order/order.model";
import { ApiError } from "../../utils/apiError";
import { idQuery, idVariants } from "../../utils/ids";
import { Types } from "mongoose";
import { CreateProductInput, UpdateProductInput, GetProductsQuery } from "./product.validator";
import type { WarrantyType } from "../warranty/warranty.types";
import { VENDOR_LIVE_PRODUCT_STATUSES } from "../vendor/vendor.types";

/**
 * Sort keys the shop and dashboards can ask for. Every one of them ends on
 * `_id`: a bulk import saves many rows in the same millisecond, and without the
 * tie-break those rows swap places between pages while a reader walks them.
 */
const SORT_OPTIONS: Record<string, Record<string, 1 | -1>> = {
  rating: { rating: -1, _id: 1 },
  // A featured shelf reads in paid order: the store's own stock first, then each
  // seller by the plan that lifted it, its billing period and its length. The
  // key is written by the placement, so this list sorts one stored number.
  featured: { isFeatured: -1, featuredRank: -1, createdAt: -1, _id: 1 },
  newest: { createdAt: -1, _id: 1 },
  oldest: { createdAt: 1, _id: 1 },
};

/**
 * Money sorts, and which way they run. These are not served by a stored field:
 * they rank the price a buyer is charged (see `rankPricePage`).
 */
const PRICE_SORTS: Record<string, 1 | -1> = {
  price_asc: 1,
  price_desc: -1,
};

// Escapes regex special chars so user search input matches literally
function escapeRegex(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Fetches avg rating + review count for a batch of products in ONE query.
// Returns a Map<productIdString, { avgRating, count }> for fast O(1) lookup.
async function getRatingsMap(productIds: string[]) {
  const stats = await ProductReview.aggregate([
    { $match: { productId: { $in: productIds.flatMap((id) => idVariants(id)) } } },
    { $group: { _id: { $toString: "$productId" }, avgRating: { $avg: "$rating" }, count: { $sum: 1 } } },
  ]);
  return new Map(stats.map((s) => [s._id, s]));
}

// ─── Shape of the response ─────────────────────────────────────────────────────

/**
 * Who is reading a row.
 *
 * "public" is every shop page and every anonymous caller: it never carries the
 * cost the store paid. "admin" is the store team's own desks, and "vendor" is
 * a seller reading one of their own listings — both need the cost and the
 * margin, and both are allowed to see rows a shopper cannot reach.
 */
export type ProductView = "public" | "admin" | "vendor";

export interface FormatProductOptions {
  ratingsMap?: Map<string, any>;
  view?: ProductView;
}

/** True when the offer's end date has already gone by. */
export function offerHasLapsed(product: { offerEndDate?: Date | string | null }): boolean {
  if (!product.offerEndDate) return false;
  const end = new Date(product.offerEndDate).getTime();
  return Number.isFinite(end) && end <= Date.now();
}

/**
 * The price a buyer is charged for one unit, right now.
 *
 * A lapsed offer is not a display detail: the sale is over, so the original
 * price is the price. The cart, the checkout and every product screen read this
 * one rule, so what is shown and what is charged can never disagree.
 */
export function sellingPriceOf(product: {
  price?: number | null;
  originalPrice?: number | null;
  offerEndDate?: Date | string | null;
}): number {
  const price = Number(product.price) || 0;
  const original = product.originalPrice != null ? Number(product.originalPrice) : 0;
  return offerHasLapsed(product) && original > 0 ? original : price;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Whether one unit can be bought right now.
 *
 * A tracked product is sold out the moment its count reaches zero, whatever the
 * stored flag still says: orders lower the count and do not rewrite the flag. A
 * product saved without a count is not tracked and is always offered.
 */
export function isSellableStock(stockQuantity: unknown, inStock: unknown): boolean {
  if (stockQuantity == null) return true;
  const quantity = Number(stockQuantity);
  if (!Number.isFinite(quantity)) return true;
  return quantity > 0 && inStock !== false;
}

/**
 * Settles the stock flag on the way in, so the stored row agrees with its count.
 *
 * Clearing the count means "not tracked" and the product is always available;
 * zero units means it is out of stock. A positive count leaves a deliberate
 * "off" switch alone, because an admin may pause a product that still has stock.
 */
function applyStockAvailability<
  T extends { stockQuantity?: number | null; inStock?: boolean }
>(data: T): T {
  if (data.stockQuantity === undefined) return data;
  if (data.stockQuantity === null) return { ...data, inStock: true };
  if (data.stockQuantity <= 0) return { ...data, inStock: false };
  return data.inStock === undefined ? { ...data, inStock: true } : data;
}

/**
 * Shapes a raw Mongoose product document into the API response format.
 *
 * The public shape deliberately drops the cost price and everything derived
 * from it: those fields are the store's own numbers, and this endpoint answers
 * anonymous callers. Only the admin view adds them back, together with the
 * values as they are stored, so an edit form can round-trip them unchanged.
 */
export function formatProduct(product: any, options: FormatProductOptions = {}) {
  const { ratingsMap, view = "public" } = options;
  const obj = product.toObject ? product.toObject({ flattenMaps: true }) : product;
  const id = obj._id?.toString() ?? obj.id;
  const stat = ratingsMap?.get(id);

  let specifications = obj.specifications;
  if (specifications instanceof Map) {
    specifications = Object.fromEntries(specifications);
  } else if (!specifications || typeof specifications !== "object") {
    specifications = {};
  }

  const isOfferExpired = offerHasLapsed(obj);

  // The stored price is what the admin desk edits; the effective price is what a
  // buyer is charged. A lapsed offer reverts to the original price.
  const storedPrice = Number(obj.price) || 0;
  const storedOriginalPrice = obj.originalPrice != null ? Number(obj.originalPrice) : undefined;
  const effectivePrice = sellingPriceOf(obj);
  const effectiveOriginalPrice = isOfferExpired ? undefined : storedOriginalPrice;

  // Calculate discount% only when offer is still active
  const discountPercentage =
    !isOfferExpired && storedOriginalPrice && storedOriginalPrice > storedPrice
      ? Math.round(((storedOriginalPrice - storedPrice) / storedOriginalPrice) * 100)
      : undefined;

  // Resolve category label from populated ref or specifications fallback
  const categoryName =
    obj.categoryId?.name ||
    specifications?.Category ||
    specifications?.category ||
    "";

  const sellCount = typeof obj.sellCount === "number" ? obj.sellCount : 0;

  // Who sells this, for the "Sold by" link a shopper follows to the storefront.
  // Only a populated store gives words: a row read without the join carries
  // none, so the card simply shows no seller rather than half a name.
  const seller =
    obj.storeId && typeof obj.storeId === "object" && obj.storeId.name
      ? { id: String(obj.storeId._id), name: obj.storeId.name, slug: obj.storeId.slug || "" }
      : undefined;

  // The cost price and everything derived from it stay off the public shape, so
  // the spread below drops it before the fields are added back for the owner's
  // own desks.
  const { investPrice: storedInvestPrice, ...productFields } = obj;

  const response: Record<string, any> = {
    ...productFields,
    id,
    seller,
    badges: Array.isArray(obj.badges) ? obj.badges : [],
    specifications,
    // A product saved with no stock quantity is not stock-tracked: nothing can
    // run it dry, so it is always offered. A tracked product with nothing left
    // reads as out of stock even when its stored flag was never updated.
    inStock: isSellableStock(obj.stockQuantity, obj.inStock),
    price: effectivePrice,
    originalPrice: effectiveOriginalPrice,
    categories: categoryName ? [categoryName] : [],
    discountPercentage,
    isOfferExpired: isOfferExpired,
    sellCount,
    rating: stat ? Math.round(stat.avgRating * 10) / 10 : (obj.rating ?? 0),
    reviewCount: stat ? stat.count : (obj.reviewCount ?? 0),
  };

  if (view === "public") {
    // The shelf order is the store's own ranking key: the public shape carries
    // the shelves themselves, never the score that sorted them.
    delete response.featuredRank;
    return response;
  }

  // Profit margin % — only meaningful when a cost and a price exist
  const investPrice =
    storedInvestPrice != null && Number.isFinite(Number(storedInvestPrice))
      ? Number(storedInvestPrice)
      : undefined;
  const unitProfit = investPrice != null ? round2(effectivePrice - investPrice) : undefined;
  const profitMargin =
    investPrice != null && effectivePrice > 0
      ? round1(((effectivePrice - investPrice) / effectivePrice) * 100)
      : undefined;

  return {
    ...response,
    /** The values as stored, so the edit form never saves a display price back. */
    storedPrice,
    storedOriginalPrice,
    /** The offer deadline as stored, lapsed or not: the desk needs to see it. */
    offerEndsAt: obj.offerEndDate ?? null,
    investPrice,
    profitMargin,
    unitProfit,
    totalProfit: unitProfit != null ? round2(unitProfit * sellCount) : undefined,
  };
}

/**
 * The two warranty fields describe one promise, so they are settled together:
 *
 *   - "No warranty" drops the period, so a leftover number can never promise
 *     cover on the product page.
 *   - A period of 0 with a covering type is stored as "No warranty" too,
 *     because cover with no end date is not something anyone can honour.
 *   - "Other" is whatever the terms text says, so it needs that text.
 */
function warrantyFieldsFor(
  data: { warrantyTerms?: string },
  months: number | undefined,
  type: string | undefined
): { warrantyType: WarrantyType; warrantyPeriodMonths: number } {
  const period = Number(months ?? 0);

  if (type === "none" || period <= 0) {
    return { warrantyType: "none", warrantyPeriodMonths: 0 };
  }

  if (type === "other" && !String(data.warrantyTerms ?? "").trim()) {
    throw new ApiError(
      400,
      "Describe the coverage in the warranty terms, or choose a different warranty type"
    );
  }

  return {
    warrantyType: (type ?? "manufacturer-warranty") as WarrantyType,
    warrantyPeriodMonths: period,
  };
}

/** Reads one specification by name, whatever the admin capitalised it as. */
function specificationValue(specifications: any, name: string): string {
  const source =
    specifications instanceof Map ? Object.fromEntries(specifications) : specifications;
  if (!source || typeof source !== "object") return "";

  const key = Object.keys(source).find(
    (candidate) => candidate.trim().toLowerCase() === name.toLowerCase()
  );
  return key ? String(source[key] ?? "").trim() : "";
}

/**
 * A manufacturer warranty is honoured by the brand's own service centres, so
 * the brand has to be named in the specs for a claim to be actionable.
 */
function assertBrandForManufacturerWarranty(type: string, specifications: any) {
  if (type !== "manufacturer-warranty") return;
  if (specificationValue(specifications, "brand")) return;
  throw new ApiError(
    400,
    "Add the brand to the specifications — a manufacturer warranty is claimed from the brand"
  );
}

export async function createProduct(data: CreateProductInput) {
  const category = await Category.findById(data.categoryId);
  if (!category) throw new ApiError(404, "Category not found");

  if (data.subCategoryIds?.length) {
    const count = await SubCategory.countDocuments({ _id: { $in: data.subCategoryIds } });
    if (count !== data.subCategoryIds.length) {
      throw new ApiError(404, "One or more subcategories not found");
    }
  }

  const existing = await Product.findOne({ slug: data.slug });
  if (existing) throw new ApiError(409, "Slug already in use");

  // The warranty fields only make sense together: see applyWarrantyRules.
  const warranty = warrantyFieldsFor(data, data.warrantyPeriodMonths, data.warrantyType);
  data.warrantyType = warranty.warrantyType;
  data.warrantyPeriodMonths = warranty.warrantyPeriodMonths;

  assertBrandForManufacturerWarranty(data.warrantyType, data.specifications);

  const product = await Product.create(applyStockAvailability(data));
  return formatProduct(product, { view: "admin" });
}

// ─── Filter builders ──────────────────────────────────────────────────────────

/** Matches the linked category, or the legacy specifications.Category label. */
async function buildCategoryCondition(category: string) {
  const cat = await Category.findOne({ $or: [{ slug: category }, { name: category }] });
  const catName = cat?.name || category.replace(/-/g, " ");
  const catRegex = new RegExp(`^${escapeRegex(catName)}$`, "i");

  const matches: any[] = [
    { "specifications.Category": catRegex },
    { "specifications.category": catRegex },
  ];
  if (cat) matches.push({ categoryId: cat._id });

  return { $or: matches };
}

/** Matches the linked subcategory, or the legacy specifications.Subcategory label. */
async function buildSubCategoryCondition(subCategory: string) {
  const sub = await SubCategory.findOne({ $or: [{ slug: subCategory }, { name: subCategory }] });
  const subName = sub?.name || subCategory.replace(/-/g, " ");
  const subRegex = new RegExp(`^${escapeRegex(subName)}$`, "i");

  const matches: any[] = [
    { "specifications.Subcategory": subRegex },
    { "specifications.subcategory": subRegex },
  ];
  if (sub) matches.push({ subCategoryIds: sub._id });

  return { $or: matches };
}

/** Free-text search across title, description, badges and specifications. */
function buildSearchCondition(search: string) {
  const searchRegex = new RegExp(escapeRegex(search.trim()), "i");
  return {
    $or: [
      { title: searchRegex },
      { description: searchRegex },
      { badges: searchRegex },
      { "specifications.$**": searchRegex },
    ],
  };
}

/**
 * True when the document's offer deadline has gone by.
 *
 * Until the sweep rewrites it, a stored price still holds the sale price of an
 * offer that is over. The deadline, not the price, is the honest reading of
 * whether a sale is still on — the same reading `offerHasLapsed` makes.
 */
function offerLapsedExpr(now: Date) {
  return {
    $and: [
      { $ne: [{ $ifNull: ["$offerEndDate", null] }, null] },
      { $lte: ["$offerEndDate", now] },
    ],
  };
}

/** `sellingPriceOf` as a Mongo expression, for sorting and filtering on it. */
function effectivePriceExpr(now: Date = new Date()) {
  return {
    $cond: [
      {
        $and: [
          offerLapsedExpr(now),
          { $gt: [{ $ifNull: ["$originalPrice", 0] }, 0] },
        ],
      },
      "$originalPrice",
      { $ifNull: ["$price", 0] },
    ],
  };
}

/** Matches a price range against the price a buyer is charged, not the stored one. */
function buildPriceCondition(minPrice?: number, maxPrice?: number) {
  const bounds: any[] = [];
  const price = effectivePriceExpr();
  if (minPrice !== undefined) bounds.push({ $gte: [price, minPrice] });
  if (maxPrice !== undefined) bounds.push({ $lte: [price, maxPrice] });
  return { $expr: { $and: bounds } };
}

/**
 * Discount range filter (e.g. "0-20", "20-40").
 * Discount% is computed on the fly from originalPrice, falling back to the
 * stored discountPercentage field when originalPrice is not set.
 */
function buildDiscountCondition(query: GetProductsQuery) {
  const [minStr, maxStr] = (query.discount || "").split("-");
  const min = query.minDiscount ?? (minStr ? Number(minStr) : 0);
  const max = query.maxDiscount ?? (maxStr ? Number(maxStr) : 100);

  // A lapsed offer shows no discount at all, whatever the stored prices still
  // say, so that band filter agrees with the badge on the card.
  const discountExpr = {
    $cond: [
      offerLapsedExpr(new Date()),
      0,
      {
        $cond: [
          { $and: [{ $gt: ["$originalPrice", "$price"] }, { $gt: ["$originalPrice", 0] }] },
          { $round: [{ $multiply: [{ $divide: [{ $subtract: ["$originalPrice", "$price"] }, "$originalPrice"] }, 100] }, 0] },
          { $ifNull: ["$discountPercentage", 0] },
        ],
      },
    ],
  };
  return { $expr: { $and: [{ $gte: [discountExpr, min] }, { $lte: [discountExpr, max] }] } };
}

/** Badge filter, e.g. "trending" or "popular". */
function buildBadgeCondition(badge: string) {
  return { badges: new RegExp(`^${escapeRegex(badge.trim())}$`, "i") };
}

/** Only products whose offer price is still lower than the original price. */
function buildOfferCondition() {
  return {
    $and: [
      { originalPrice: { $exists: true, $ne: null } },
      { $expr: { $gt: ["$originalPrice", "$price"] } },
      { $or: [{ offerEndDate: { $exists: false } }, { offerEndDate: null }, { offerEndDate: { $gt: new Date() } }] },
    ],
  };
}

/**
 * Turns the shop query into the list of AND-ed Mongo conditions.
 *
 * `includeHidden` is the admin view: the store team's catalog has to show the
 * rows it governs, including a seller's drafts and archived stock.
 */
async function buildFilterConditions(
  query: GetProductsQuery,
  options: { includeHidden?: boolean } = {}
) {
  const { category, subCategory, search, minPrice, maxPrice, isFeatured, inStock } = query;
  const conditions: any[] = [];

  // One seller's shelf. A slug that names no shop narrows to nothing rather
  // than falling through to the whole catalogue, so a dead storefront link
  // shows an empty shelf instead of everyone's stock.
  if (query.storeSlug || query.storeId) {
    let storeId = query.storeId;
    if (query.storeSlug) {
      const store = await VendorStore.findOne({
        slug: query.storeSlug.trim().toLowerCase(),
      }).select("_id").lean();
      storeId = store ? String(store._id) : undefined;
    }
    // The reference may be stored as a plain string or as an ObjectId. An id
    // that is not one, or a slug that names no shop, narrows the query to
    // nothing — an empty shelf, never everyone's stock and never a bad cast.
    const target = String(storeId ?? "");
    conditions.push(
      Types.ObjectId.isValid(target) ? { storeId: idQuery(target) } : { storeId: { $in: [] } }
    );
  }

  if (category) conditions.push(await buildCategoryCondition(category));
  if (subCategory) conditions.push(await buildSubCategoryCondition(subCategory));
  if (search?.trim()) conditions.push(buildSearchCondition(search));

  if (minPrice !== undefined || maxPrice !== undefined) {
    conditions.push(buildPriceCondition(minPrice, maxPrice));
  }
  if (query.discount || query.minDiscount !== undefined || query.maxDiscount !== undefined) {
    conditions.push(buildDiscountCondition(query));
  }

  const activeBadge = query.badge || query.badges;
  if (activeBadge?.trim()) conditions.push(buildBadgeCondition(activeBadge));

  // The public catalogue never serves a vendor's draft, archived or hidden row.
  // Admin-created products carry no vendor status, so they stay visible exactly
  // as before this field existed. The admin view skips the rule: a desk cannot
  // review what it is not allowed to list.
  if (!options.includeHidden) {
    conditions.push({
      $and: [
        { isVisible: { $ne: false } },
        {
          $or: [
            { vendorProductStatus: { $exists: false } },
            { vendorProductStatus: { $in: [...VENDOR_LIVE_PRODUCT_STATUSES] } },
          ],
        },
      ],
    });
  }

  if (isFeatured !== undefined) {
    conditions.push({ isFeatured });
    // A placement's flag is cleared by the sweep, which may still be on its way,
    // so the deadline the placement wrote is what says the shelf is dark. The
    // admin view keeps the plain flag: a desk reviews what it governs.
    if (isFeatured === true && !options.includeHidden) {
      conditions.push({
        $or: [{ featuredUntil: null }, { featuredUntil: { $gt: new Date() } }],
      });
    }
  }
  if (inStock === true) {
    // An untracked product (no stock quantity) is always available, whatever an
    // old record's flag says. A tracked one needs units left and no manual stop.
    conditions.push({
      $or: [
        { stockQuantity: null },
        { stockQuantity: { $gt: 0 }, inStock: { $ne: false } },
      ],
    });
  } else if (inStock === false) {
    // Sold out is the same reading the status column shows: tracked, and either
    // the count is gone or an admin switched the product off.
    conditions.push({
      $and: [
        { stockQuantity: { $ne: null } },
        { $or: [{ stockQuantity: { $lte: 0 } }, { inStock: false }] },
      ],
    });
  }
  if (query.minRating !== undefined) conditions.push({ rating: { $gte: query.minRating } });
  if (query.hasOffer) conditions.push(buildOfferCondition());

  return conditions;
}

/**
 * The ids on one price-sorted page, ranked on the price a buyer is charged.
 *
 * A lapsed offer only rewrites its stored price when the daily sweep runs, so a
 * sort on `price` would order rows by a number the card no longer shows. The
 * page is picked here, on the effective price, and read back afterwards.
 */
async function rankPricePage(filter: any, direction: 1 | -1, skip: number, limit: number) {
  const rows = await Product.aggregate([
    { $match: filter },
    { $addFields: { effectivePrice: effectivePriceExpr() } },
    { $sort: { effectivePrice: direction, _id: 1 } },
    { $skip: skip },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);
  return rows.map((row: any) => row._id);
}

export async function getProducts(query: GetProductsQuery, view: ProductView = "public") {
  const { page, limit, sort } = query;

  const conditions = await buildFilterConditions(query, { includeHidden: view === "admin" });
  const filter = conditions.length > 0 ? { $and: conditions } : {};
  // An unknown key falls back to the newest rows rather than to Mongo's natural
  // order, which is not an order anyone asked for. A featured shelf with no sort
  // asked for reads in its own paid order, not in arrival order.
  const sortKey =
    sort && (SORT_OPTIONS[sort] || PRICE_SORTS[sort])
      ? sort
      : query.isFeatured === true
        ? "featured"
        : "newest";
  const skip = (page - 1) * limit;

  // The seller's name rides along for the cards, but a page that was asked
  // for one shop already knows the shop — the join is only worth its cost
  // when the rows may come from many sellers.
  const load = (where: any) => {
    const find = Product.find(where)
      .populate("categoryId", "name slug")
      .populate("subCategoryIds", "name slug");
    if (!query.storeSlug && !query.storeId) find.populate("storeId", "name slug");
    return find;
  };

  const pageOfProducts = async (): Promise<any[]> => {
    const direction = sortKey in PRICE_SORTS ? PRICE_SORTS[sortKey] : undefined;
    if (!direction) return await load(filter).sort(SORT_OPTIONS[sortKey]).skip(skip).limit(limit);

    const ids = await rankPricePage(filter, direction, skip, limit);
    if (ids.length === 0) return [];
    const docs = await load({ _id: { $in: ids } });
    const byId = new Map<string, any>(docs.map((doc: any) => [String(doc._id), doc]));
    return ids
      .map((id) => byId.get(String(id)))
      .filter((doc): doc is any => Boolean(doc));
  };

  const [products, total] = await Promise.all([pageOfProducts(), Product.countDocuments(filter)]);

  const ratingsMap = await getRatingsMap(products.map((p) => p._id.toString()));

  return {
    products: products.map((p) => formatProduct(p, { ratingsMap, view })),
    total,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function updateProduct(id: string, data: UpdateProductInput) {
  const current = await Product.findById(id);
  if (!current) throw new ApiError(404, "Product not found");

  // Only the fields that were sent are in `data`, so the two warranty fields are
  // judged on the combination the product will end up with.
  const nextType = data.warrantyType ?? current.warrantyType;
  const nextMonths = data.warrantyPeriodMonths ?? current.warrantyPeriodMonths;
  const nextTerms = String(data.warrantyTerms ?? current.warrantyTerms ?? "");

  // Adding a period to a product marked as uncovered is a contradiction the
  // admin has to resolve by choosing a type.
  if (
    current.warrantyType === "none" &&
    !data.warrantyType &&
    Number(data.warrantyPeriodMonths ?? 0) > 0
  ) {
    throw new ApiError(
      400,
      "This product is marked No warranty. Choose a warranty type before setting a period."
    );
  }

  const warranty = warrantyFieldsFor(
    { ...data, warrantyTerms: nextTerms },
    nextMonths,
    nextType
  );
  data.warrantyType = warranty.warrantyType;
  data.warrantyPeriodMonths = warranty.warrantyPeriodMonths;

  // The stored specs are checked when the update did not send new ones.
  assertBrandForManufacturerWarranty(
    warranty.warrantyType,
    data.specifications ?? current.specifications
  );

  // A seller's listing is lit and dimmed by a dated placement, which is the only
  // writer of the flag: two writers would leave a shelf shining after the
  // placement that paid for it had ended. `isFeatured` is not part of the edit
  // form any more, so a round-trip of the form cannot touch it either.

  const product = await Product.findByIdAndUpdate(id, applyStockAvailability(data), { new: true });
  if (!product) throw new ApiError(404, "Product not found");
  return formatProduct(product, { view: "admin" });
}

export async function deleteProduct(id: string) {
  const product = await Product.findByIdAndDelete(id);
  if (!product) throw new ApiError(404, "Product not found");

  // A placement on a deleted listing has nothing left to lift; closing it keeps
  // the promotions board from showing a shelf that points at a row nobody can
  // open, and frees the shelf for the next listing.
  await endPlacementForProduct(id, "The product was removed");
}

export async function getProductBySlug(slug: string, view: ProductView = "public") {
  const product = await Product.findOne({ slug })
    .populate("categoryId", "name slug")
    .populate("subCategoryIds", "name slug")
    .populate("storeId", "name slug");
  if (!product) throw new ApiError(404, "Product not found");

  // A vendor's hidden or unpublished row is not a storefront page, even to
  // someone who guessed the link. The admin view reads it so the desk can act
  // on a listing a shopper cannot reach.
  const blockedStatuses = ["draft", "pending_review", "rejected", "archived"];
  if (
    view !== "admin" &&
    (product.isVisible === false ||
      blockedStatuses.includes(String((product as any).vendorProductStatus)))
  ) {
    throw new ApiError(404, "Product not found");
  }

  const ratingsMap = await getRatingsMap([product._id.toString()]);
  const formatted = formatProduct(product, { ratingsMap, view });
  if (view !== "admin") return formatted;

  // The desk's money is what was really charged, not today's price times the
  // units sold: the delivered order lines are the only record of that.
  return { ...formatted, sales: await realizedSalesFor(product) };
}

/**
 * What one product actually earned on delivered orders.
 *
 * Every order line stores the price it was charged at, so revenue is summed
 * from the orders themselves: a unit sold during a sale keeps that sale's
 * price, and an order cancelled after delivery stops counting. Cost is the
 * product's current cost per unit, the same number the desk shows elsewhere.
 */
async function realizedSalesFor(product: any) {
  const productId = String(product._id ?? product.id ?? "");
  const costPrice =
    product.investPrice != null && Number.isFinite(Number(product.investPrice))
      ? Number(product.investPrice)
      : null;

  const [row] = productId
    ? await Order.aggregate([
        { $match: { orderStatus: "delivered" } },
        { $unwind: "$items" },
        { $match: { "items.productId": { $in: idVariants(productId) } } },
        {
          $group: {
            _id: null,
            units: { $sum: "$items.quantity" },
            revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
          },
        },
      ])
    : [];

  const units = Number(row?.units) || 0;
  const revenue = round2(Number(row?.revenue) || 0);
  const cost = costPrice != null ? round2(costPrice * units) : null;

  return { units, revenue, cost, profit: cost != null ? round2(revenue - cost) : null };
}

/**
 * The daily sweep: an offer that ran out becomes a plain price.
 *
 * The read rule already reverts a lapsed offer, so no shopper ever sees a dead
 * deal. This writes that same answer down: the stored price becomes the price
 * sorting and price filters read, and the deadline is cleared so the product is
 * an ordinary one again. Every update is guarded by the deadline, so a sweep
 * that races a fresh offer cannot overwrite the new one.
 */
export async function expireProductOffers() {
  const now = new Date();
  const lapsed = await Product.find({ offerEndDate: { $ne: null, $lte: now } })
    .select("price originalPrice")
    .lean();

  let reverted = 0;

  for (const row of lapsed as any[]) {
    const original = Number(row.originalPrice);
    // Without a usable original price there is nothing to revert to; the row
    // still loses its lapsed deadline.
    const nextPrice =
      Number.isFinite(original) && original > 0 ? original : Number(row.price) || 0;

    const result = await Product.updateOne(
      { _id: row._id, offerEndDate: { $ne: null, $lte: now } },
      { $set: { price: nextPrice, offerEndDate: null } }
    );

    if (result.modifiedCount) reverted += 1;
  }

  return { reverted };
}