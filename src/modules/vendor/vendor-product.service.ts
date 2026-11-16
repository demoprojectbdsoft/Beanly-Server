import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { Product } from "../product/product.model";
import { formatProduct } from "../product/product.service";
import { Category } from "../category/category.model";
import { SubCategory } from "../subcategory/subcategory.model";
import { VendorStore } from "./vendor-store.model";
import { requireStore, requireTradingStore } from "./vendor-store.service";
import { endPlacementForProduct } from "./featured-promotion.service";
import { slugify } from "./vendor-application.service";
import { getVendorPlanState, assertWithinLimit } from "./vendor-subscription.service";
import {
  VENDOR_LIVE_PRODUCT_STATUSES,
  VENDOR_PRODUCT_STATUSES,
  isLiveVendorProductStatus,
} from "./vendor.types";
import type {
  CreateVendorProductInput,
  UpdateVendorProductInput,
  VendorProductQuery,
} from "./vendor-product.validator";

/**
 * The vendor's catalogue.
 *
 * Every query starts from the signed-in account and adds `vendorId` to it, so
 * no request can read or write another seller's row even when it guesses an id.
 * The plan limit is enforced here, on the transition into a live status — not
 * when a draft is saved — because a vendor with a full shelf can still prepare
 * the next product and publish it after making room.
 */

/** A slug no other product uses, derived from the title. */
async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || "product";
  let candidate = root;
  let suffix = 2;

  // A handful of rounds is enough; the loop stops at the first free value.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const clash = await Product.exists({ slug: candidate });
    if (!clash) return candidate;
    candidate = `${root}-${suffix}`;
    suffix += 1;
  }

  return `${root}-${Date.now()}`;
}

/** Recomputes the store's cached product count from the live rows. */
async function syncStoreProductCount(storeId: string): Promise<void> {
  const count = await Product.countDocuments({
    storeId,
    vendorProductStatus: { $in: [...VENDOR_LIVE_PRODUCT_STATUSES] },
  });
  await VendorStore.updateOne({ _id: storeId }, { $set: { productCount: count } });
}

async function assertCategory(categoryId: string, subCategoryIds?: string[]): Promise<void> {
  const category = await Category.findById(categoryId);
  if (!category) throw new ApiError(404, "Category not found");

  if (subCategoryIds?.length) {
    const count = await SubCategory.countDocuments({ _id: { $in: subCategoryIds } });
    if (count !== subCategoryIds.length) {
      throw new ApiError(404, "One or more subcategories not found");
    }
  }
}

/** The signed-in vendor's product, or a 404 — never a 403 that confirms the id. */
async function requireOwnedProduct(userId: string, productId: string) {
  const product = await Product.findOne({ _id: productId, vendorId: userId });
  if (!product) throw new ApiError(404, "Product not found");
  return product;
}

/** The status a save should end in, from what the vendor asked for. */
function resolveStatus(input: {
  requested?: string;
  current?: string;
  publish?: boolean;
  stockQuantity?: number | null;
}): (typeof VENDOR_PRODUCT_STATUSES)[number] {
  const requested = input.requested ?? (input.publish ? "published" : "draft");
  if (requested === "published" && typeof input.stockQuantity === "number" && input.stockQuantity <= 0) {
    return "out_of_stock";
  }
  // The validators only ever pass a known status; this keeps the return type
  // honest without a second list of the same strings.
  return VENDOR_PRODUCT_STATUSES.includes(requested as (typeof VENDOR_PRODUCT_STATUSES)[number])
    ? (requested as (typeof VENDOR_PRODUCT_STATUSES)[number])
    : "draft";
}

/** The list screen: rows, per-status counts, paging and the plan's usage. */
export async function listMyProducts(userId: string, query: VendorProductQuery) {
  const { status, search, page, limit } = query;
  const filter: Record<string, unknown> = { vendorId: userId };

  if (status && status !== "all") filter.vendorProductStatus = status;

  if (search?.trim()) {
    const match = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ title: match }, { sku: match }, { brand: match }];
  }

  const [rows, total, counts, planState] = await Promise.all([
    Product.find(filter)
      .populate("categoryId", "name slug")
      .populate("subCategoryIds", "name slug")
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Product.countDocuments(filter),
    Product.aggregate([
      { $match: { vendorId: new Types.ObjectId(userId) } },
      { $group: { _id: "$vendorProductStatus", count: { $sum: 1 } } },
    ]),
    getVendorPlanState(userId),
  ]);

  const typeCounts = (counts as Array<{ _id: string | null; count: number }>).reduce<
    Record<string, number>
  >((all, row) => {
    all[String(row._id ?? "draft")] = Number(row.count) || 0;
    return all;
  }, {});

  return {
    products: rows.map((row) => formatProduct(row, { view: "vendor" })),
    total,
    typeCounts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    plan: {
      id: planState.plan.id,
      name: planState.plan.name,
      maxProducts: planState.plan.maxProducts,
      used: planState.usage.products,
      isLive: planState.isLive,
      effectiveUntil: planState.effectiveUntil,
    },
  };
}

/** One of the vendor's products, with the category names the form shows. */
export async function getMyProduct(userId: string, productId: string) {
  const product = await Product.findOne({ _id: productId, vendorId: userId })
    .populate("categoryId", "name slug")
    .populate("subCategoryIds", "name slug");

  if (!product) throw new ApiError(404, "Product not found");
  // The seller's own listing, so their cost and margin come back with it — the
  // same fields the store's edit form reads, and the values the P&L needs.
  return formatProduct(product, { view: "vendor" });
}

/**
 * Saves a new product as a draft, or publishes it straight away.
 *
 * Publishing is the only branch that touches the plan limit, and the store's
 * cached count is refreshed afterwards so the dashboard and the catalogue agree
 * without a recount on read.
 */
export async function createMyProduct(userId: string, input: CreateVendorProductInput) {
  const store = await requireTradingStore(userId, "listing products");
  await assertCategory(input.categoryId, input.subCategoryIds);

  const publish = Boolean(input.publish);
  if (publish) {
    await assertWithinLimit(userId, "product");
  }

  const status = resolveStatus({
    publish,
    stockQuantity: input.stockQuantity ?? null,
  });

  const slug = input.slug?.trim()
    ? await uniqueSlug(input.slug)
    : await uniqueSlug(input.title);

  const product = await Product.create({
    ownerId: userId,
    vendorId: userId,
    storeId: store._id,
    vendorProductStatus: status,
    isVisible: true,
    publishedAt: publish ? new Date() : null,
    submittedAt: publish ? new Date() : null,
    title: input.title,
    slug,
    categoryId: input.categoryId,
    subCategoryIds: input.subCategoryIds ?? [],
    price: input.price,
    originalPrice: input.originalPrice ?? undefined,
    investPrice: input.investPrice ?? undefined,
    image: input.image,
    additionalImages: input.additionalImages ?? [],
    stockQuantity: input.stockQuantity ?? null,
    inStock: (input.stockQuantity ?? 1) > 0,
    sku: input.sku ?? "",
    brand: input.brand ?? "",
    description: input.description ?? "",
    specifications: input.specifications ?? {},
    // The same display and after-sale fields the admin form writes, so a
    // listing reads the same no matter which dashboard saved it.
    badges: input.badges ?? [],
    offerEndDate: input.offerEndDate ?? undefined,
    warrantyPeriodMonths: input.warrantyPeriodMonths ?? 0,
    warrantyType: input.warrantyType ?? "manufacturer-warranty",
    warrantyTerms: input.warrantyTerms ?? undefined,
    variantOptions: input.variantOptions ?? [],
    shippingInfo: input.shippingInfo ?? {},
  });

  if (isLiveVendorProductStatus(status)) {
    await syncStoreProductCount(String(store._id));
  }

  return formatProduct(product);
}

/**
 * Edits one of the vendor's products.
 *
 * A transition into a live status checks the plan limit; an edit that keeps the
 * product live does not, because it is already counted. Archiving hides the row
 * from the catalogue without deleting orders that reference it.
 */
export async function updateMyProduct(
  userId: string,
  productId: string,
  input: UpdateVendorProductInput
) {
  const product = await requireOwnedProduct(userId, productId);
  const store = await requireTradingStore(userId, "editing a listing");

  if (input.categoryId || input.subCategoryIds) {
    await assertCategory(
      input.categoryId ?? String(product.categoryId),
      input.subCategoryIds
    );
  }

  const currentStatus = String(product.vendorProductStatus ?? "draft");
  const requested = input.status ?? currentStatus;
  const stock = input.stockQuantity !== undefined ? input.stockQuantity : product.stockQuantity;
  const nextStatus = resolveStatus({
    requested,
    current: currentStatus,
    stockQuantity: stock,
  });

  const wasLive = isLiveVendorProductStatus(currentStatus);
  const willBeLive = isLiveVendorProductStatus(nextStatus);

  if (!wasLive && willBeLive) {
    await assertWithinLimit(userId, "product");
  }

  const update: Record<string, unknown> = { vendorProductStatus: nextStatus };

  const fields = [
    "title",
    "categoryId",
    "subCategoryIds",
    "price",
    "originalPrice",
    "investPrice",
    "image",
    "additionalImages",
    "stockQuantity",
    "sku",
    "brand",
    "description",
    "specifications",
    "badges",
    "offerEndDate",
    "warrantyPeriodMonths",
    "warrantyType",
    "warrantyTerms",
    "variantOptions",
    "shippingInfo",
  ] as const;

  for (const field of fields) {
    if (input[field] !== undefined) update[field] = input[field];
  }

  // A new title is a new address only while the product has never been live;
  // a published product keeps its slug so existing links and orders survive.
  if (input.title && !product.publishedAt && input.title !== product.title) {
    update.slug = await uniqueSlug(input.slug?.trim() || input.title);
  } else if (input.slug && !product.publishedAt) {
    update.slug = await uniqueSlug(input.slug);
  }

  if (input.stockQuantity !== undefined) {
    update.inStock = input.stockQuantity === null || input.stockQuantity > 0;
  }

  if (input.isVisible !== undefined) {
    update.isVisible = nextStatus === "published" ? input.isVisible : false;
  }

  if (nextStatus === "archived") {
    update.isVisible = false;
  }

  if (!wasLive && willBeLive) {
    update.publishedAt = product.publishedAt ?? new Date();
    update.submittedAt = new Date();
    update.isVisible = input.isVisible ?? true;
  }

  if (willBeLive && input.isVisible === undefined && !wasLive) {
    update.isVisible = true;
  }

  Object.assign(product, update);
  await product.save();

  // A listing nobody can reach has no business holding a featured shelf, so the
  // placement is closed and the slot given back rather than left glowing.
  if (!willBeLive || product.isVisible === false) {
    await endPlacementForProduct(String(product._id), "The listing is no longer on sale");
  }

  await syncStoreProductCount(String(store._id));
  return formatProduct(product);
}

/** Archives a product. Nothing is deleted while orders can still reference it. */
export async function archiveMyProduct(userId: string, productId: string) {
  const product = await requireOwnedProduct(userId, productId);
  const store = await requireStore(userId);

  product.vendorProductStatus = "archived";
  product.isVisible = false;
  await product.save();

  // The shelf goes with the listing, and the row says why it went quiet.
  await endPlacementForProduct(String(product._id), "The listing was archived");

  await syncStoreProductCount(String(store._id));
  return formatProduct(product);
}
