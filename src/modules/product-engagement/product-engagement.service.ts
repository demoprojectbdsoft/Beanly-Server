import { Types } from "mongoose";
import { ApiError } from "../../utils/apiError";
import { Product } from "../product/product.model";
import { Wishlist } from "../wishlist/wishlist.model";
import { ProductEngagement } from "./product-engagement.model";

/**
 * How the shop is being shopped.
 *
 * Views and clicks are counted while a listing is on screen, so the report can
 * answer "which products get looked at, which get pressed, and which get saved"
 * — three different questions that the sales report cannot see, because it only
 * knows about orders that were actually delivered.
 *
 * Every figure is a window over the daily counters except the wishlist one,
 * which is the live list: a product on forty wishlists is on forty wishlists
 * today, and a window would only ever undercount it.
 */

export const ENGAGEMENT_TYPES = ["view", "click"] as const;
export type EngagementType = (typeof ENGAGEMENT_TYPES)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight-to-midnight key, matching the counter rows. */
function dayKey(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function asObjectId(value: string): Types.ObjectId | null {
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

/**
 * Counts one view or one click.
 *
 * A seller opening their own listing is not interest in it, so those are
 * dropped. Anything else — a visitor, a signed-in shopper, the store team
 * checking a page — is a real look at a listing and counts.
 */
export async function recordEngagement(
  productId: string,
  type: EngagementType,
  viewerId?: string
): Promise<{ counted: boolean }> {
  const id = asObjectId(productId);
  if (!id) throw new ApiError(404, "Product not found");

  const product = await Product.findById(id).select("vendorId").lean();
  if (!product) throw new ApiError(404, "Product not found");

  const vendorId = (product as any).vendorId ? asObjectId(String((product as any).vendorId)) : null;
  if (vendorId && viewerId && String(vendorId) === String(viewerId)) {
    return { counted: false };
  }

  const field = type === "click" ? "clicks" : "views";
  const day = dayKey(new Date());

  try {
    await ProductEngagement.updateOne(
      { productId: id, day },
      { $inc: { [field]: 1 }, $setOnInsert: { vendorId } },
      { upsert: true }
    );
  } catch (error: any) {
    // Two people opening the same listing in the same instant can race the
    // upsert; the unique index refuses the loser, and one retry lands on the
    // row it should have incremented.
    if (error?.code !== 11000) throw error;
    await ProductEngagement.updateOne({ productId: id, day }, { $inc: { [field]: 1 } });
  }

  return { counted: true };
}

export interface EngagementQuery {
  /** Window in days, already clamped by the controller. */
  range: number;
  /** How many rows each ranking returns. */
  limit: number;
  /** Scopes the report to one seller's listings. */
  vendorId?: string;
}

export interface EngagementRow {
  id: string;
  title: string;
  slug: string;
  image: string;
  price: number;
  views: number;
  clicks: number;
  wishlists: number;
  /** Clicks as a share of views, whole percent. */
  clickRate: number;
}

/**
 * Views, clicks and wishlist placement over one window.
 *
 * `top` is ranked by attention and `topWishlisted` by saves, because the two
 * questions have different answers: a product can be looked at constantly and
 * never saved, and the one nobody opens can be the one everyone keeps for later.
 */
export async function getEngagementReport({
  range,
  limit,
  vendorId,
}: EngagementQuery): Promise<{
  range: number;
  totals: { views: number; clicks: number; wishlists: number; products: number };
  top: EngagementRow[];
  topWishlisted: EngagementRow[];
}> {
  const now = new Date();
  const fromDay = dayKey(new Date(now.getTime() - range * DAY_MS));
  const toDay = dayKey(now);

  const scope = vendorId ? { vendorId: asObjectId(vendorId) } : {};
  const scopeId = vendorId ? asObjectId(vendorId) : null;

  const [counted, saved] = await Promise.all([
    ProductEngagement.aggregate([
      { $match: { day: { $gte: fromDay, $lte: toDay }, ...scope } },
      { $group: { _id: "$productId", views: { $sum: "$views" }, clicks: { $sum: "$clicks" } } },
    ]),
    Wishlist.aggregate([{ $group: { _id: "$productId", wishlists: { $sum: 1 } } }]),
  ]);

  const viewsById = new Map<string, { views: number; clicks: number }>();
  for (const row of counted) {
    viewsById.set(String(row._id), {
      views: Number(row.views) || 0,
      clicks: Number(row.clicks) || 0,
    });
  }

  const wishlistsById = new Map<string, number>();
  for (const row of saved) {
    wishlistsById.set(String(row._id), Number(row.wishlists) || 0);
  }

  const ids = new Set<string>([...viewsById.keys(), ...wishlistsById.keys()]);
  const objectIds = [...ids]
    .map(asObjectId)
    .filter((id): id is Types.ObjectId => id !== null);

  if (objectIds.length === 0) {
    return {
      range,
      totals: { views: 0, clicks: 0, wishlists: 0, products: 0 },
      top: [],
      topWishlisted: [],
    };
  }

  const productFilter: Record<string, unknown> = { _id: { $in: objectIds } };
  if (scopeId) productFilter.vendorId = scopeId;

  const products = await Product.find(productFilter)
    .select("title slug image price")
    .lean();

  const rows: EngagementRow[] = products.map((product: any) => {
    const id = String(product._id);
    const activity = viewsById.get(id) || { views: 0, clicks: 0 };
    const wishlists = wishlistsById.get(id) || 0;

    return {
      id,
      title: product.title || "Product",
      slug: product.slug || "",
      image: product.image || "",
      price: Number(product.price) || 0,
      views: activity.views,
      clicks: activity.clicks,
      wishlists,
      clickRate: activity.views > 0 ? Math.round((activity.clicks / activity.views) * 100) : 0,
    };
  });

  const totals = rows.reduce(
    (sum, row) => ({
      views: sum.views + row.views,
      clicks: sum.clicks + row.clicks,
      wishlists: sum.wishlists + row.wishlists,
      products: sum.products + (row.views > 0 || row.clicks > 0 || row.wishlists > 0 ? 1 : 0),
    }),
    { views: 0, clicks: 0, wishlists: 0, products: 0 }
  );

  const top = [...rows]
    .sort((a, b) => b.views - a.views || b.clicks - a.clicks || b.wishlists - a.wishlists)
    .slice(0, limit);

  const topWishlisted = rows
    .filter((row) => row.wishlists > 0)
    .sort((a, b) => b.wishlists - a.wishlists || b.views - a.views)
    .slice(0, limit);

  return { range, totals, top, topWishlisted };
}
