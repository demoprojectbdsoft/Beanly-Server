import { Product } from "./product.model";
import { ProductReview } from "../review/review.model";
import { Category } from "../category/category.model";
import { SubCategory } from "../subcategory/subcategory.model";
import { VendorStore } from "../vendor/vendor-store.model";
import { ApiError } from "../../utils/apiError";
import { idVariants } from "../../utils/ids";
import { CreateProductInput, UpdateProductInput, GetProductsQuery } from "./product.validator";
import type { WarrantyType } from "../warranty/warranty.types";
import { VENDOR_LIVE_PRODUCT_STATUSES } from "../vendor/vendor.types";

/** Sort keys the shop and dashboards can ask for. */
const SORT_OPTIONS: Record<string, Record<string, 1 | -1>> = {
  price_asc: { price: 1 },
  price_desc: { price: -1 },
  rating: { rating: -1 },
  featured: { isFeatured: -1, createdAt: -1 },
  newest: { createdAt: -1 },
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
 * cost the store paid. "admin" is the store team's own desks, which need the
 * cost and the margin and are allowed to see rows a shopper cannot reach.
 */
export type ProductView = "public" | "admin";

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
  // the spread below drops it before the fields are added back for the admin.
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

  if (view !== "admin") return response;

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
 *   - "No warranty" drops the period, so a leftover number can never create a
 *     record when the order is delivered.
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

function buildPriceCondition(minPrice?: number, maxPrice?: number) {
  const priceFilter: Record<string, number> = {};
  if (minPrice !== undefined) priceFilter.$gte = minPrice;
  if (maxPrice !== undefined) priceFilter.$lte = maxPrice;
  return { price: priceFilter };
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

  const discountExpr = {
    $cond: [
      { $and: [{ $gt: ["$originalPrice", "$price"] }, { $gt: ["$originalPrice", 0] }] },
      { $round: [{ $multiply: [{ $divide: [{ $subtract: ["$originalPrice", "$price"] }, "$originalPrice"] }, 100] }, 0] },
      { $ifNull: ["$discountPercentage", 0] },
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
      storeId = store ? String(store._id) : "none";
    }
    conditions.push({ storeId });
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

  if (isFeatured !== undefined) conditions.push({ isFeatured });
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

export async function getProducts(query: GetProductsQuery, view: ProductView = "public") {
  const { page, limit, sort } = query;

  const conditions = await buildFilterConditions(query, { includeHidden: view === "admin" });
  const filter = conditions.length > 0 ? { $and: conditions } : {};
  const sortCriteria = SORT_OPTIONS[sort ?? ""] ?? { createdAt: -1 };
  const skip = (page - 1) * limit;

  const find = Product.find(filter)
    .populate("categoryId", "name slug")
    .populate("subCategoryIds", "name slug");

  // The seller's name rides along for the cards, but a page that was asked
  // for one shop already knows the shop — the join is only worth its cost
  // when the rows may come from many sellers.
  if (!query.storeSlug && !query.storeId) find.populate("storeId", "name slug");

  const [products, total] = await Promise.all([
    find.sort(sortCriteria).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

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

  // A seller's product is lifted by a dated placement, never by a switch on
  // this desk: two writers of one flag would leave a shelf shining after the
  // placement that paid for it had ended. An unchanged round-trip of the edit
  // form is not a write, so only an actual flip is refused. The store's own
  // stock has no seller behind it and keeps the plain editorial switch.
  const sellerOwned = Boolean((current as any).vendorId || (current as any).storeId);
  if (data.isFeatured !== undefined && sellerOwned && data.isFeatured !== Boolean(current.isFeatured)) {
    throw new ApiError(
      400,
      "A seller's product is featured from the promotions desk, where the placement carries an end date."
    );
  }

  const product = await Product.findByIdAndUpdate(id, applyStockAvailability(data), { new: true });
  if (!product) throw new ApiError(404, "Product not found");
  return formatProduct(product, { view: "admin" });
}

export async function deleteProduct(id: string) {
  const product = await Product.findByIdAndDelete(id);
  if (!product) throw new ApiError(404, "Product not found");
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
  return formatProduct(product, { ratingsMap, view });
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