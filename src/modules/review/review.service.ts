import { Types } from "mongoose";
import { ProductReview } from "./review.model";
import { User } from "../user/user.model";
import { Product } from "../product/product.model";
import { Order } from "../order/order.model";
import { CreateReviewInput, UpdateReviewInput, GetReviewsQuery } from "./review.validator";
import { ApiError } from "../../utils/apiError";
import { idQuery } from "../../utils/ids";
import { isAdminRole } from "../../utils/roles";
import { recordActivity } from "../activity/activity.service";

/** "4/5 · Wireless Headphones" — the second line of a review notification. */
function reviewSummary(rating: number | undefined, productTitle?: string): string {
  return [rating ? `${rating}/5` : "", productTitle || ""].filter(Boolean).join(" · ");
}

/** Sort options exposed by the reviews list. */
function sortStageFor(sort?: string) {
  switch (sort) {
    case "oldest":
      return { createdAt: 1 };
    case "rating_high":
      return { rating: -1, createdAt: -1 };
    case "rating_low":
      return { rating: 1, createdAt: -1 };
    default:
      return { createdAt: -1 }; // newest
  }
}

/**
 * Loads every reviewer and product referenced by one page of reviews in two
 * queries, so rendering a review never triggers its own lookups.
 */
async function loadReviewContext(reviews: any[]) {
  const userIds = reviews
    .map((r) => {
      const uid = r.userId?.toString();
      return Types.ObjectId.isValid(uid) ? new Types.ObjectId(uid) : null;
    })
    .filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  const productIds = reviews
    .map((r) => {
      const pid = r.productId?.toString();
      return Types.ObjectId.isValid(pid) ? new Types.ObjectId(pid) : null;
    })
    .filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(products.map((p: any) => [p._id.toString(), p]));

  return { userMap, productMap };
}

// Shapes a raw review doc + user + product into the API response format
function formatReview(r: any, user?: any, product?: any) {
  return {
    id: r._id.toString(),
    productId: r.productId?.toString(),
    productTitle: product?.title || "Product",
    productSlug: product?.slug || product?._id?.toString() || r.productId?.toString(),
    productImage: product?.image || "",
    productPrice: product?.price || 0,
    userId: r.userId?.toString(),
    userName: user?.name || "Anonymous",
    userAvatar: user?.image,
    userEmail: user?.email || "",
    rating: r.rating,
    comment: r.comment,
    images: Array.isArray(r.images) ? r.images : [],
    date: r.createdAt,
  };
}

export async function getReviews(query: GetReviewsQuery, productScope?: string[]) {
  const { productId, userId, rating, search, sort, page, limit } = query;

  // Build base filter — only add fields if provided
  const filter: any = {};
  if (productScope) {
    // A seller's board passes its own listings. Asking for one product as well
    // narrows the scope rather than escaping it, so a guessed id finds nothing.
    const ids = productScope
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    filter.productId = productId
      ? { $in: ids.filter((id) => String(id) === productId) }
      : { $in: ids };
  } else if (productId) {
    filter.productId = idQuery(productId);
  }
  if (userId) filter.userId = idQuery(userId);
  if (rating) filter.rating = rating;

  const sortStage: any = sortStageFor(sort);

  const skip = (page - 1) * limit;

  // If search is provided we need to join users/products to search across names/titles
  if (search && search.trim()) {
    const term = search.trim();
    const searchRegex = new RegExp(term, "i");

    // A notification links to one review by its id, so an id finds itself.
    const searchOr: any[] = [
      { comment: searchRegex },
      { "userDoc.name": searchRegex },
      { "productDoc.title": searchRegex },
    ];
    if (/^[0-9a-fA-F]{24}$/.test(term)) searchOr.push({ _id: new Types.ObjectId(term) });

    // Use aggregation to join user and product, then filter by search term
    const pipeline: any[] = [
      { $match: filter },
      {
        $lookup: {
          // Accounts live in the singular "user" collection that better-auth
          // and the User model share; joining "users" silently found nobody.
          from: "user",
          // $convert instead of $toObjectId: an old row that already stores an
          // ObjectId must not make every search throw.
          let: {
            uid: { $convert: { input: "$userId", to: "objectId", onError: null, onNull: null } },
          },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$uid"] } } }, { $project: { name: 1, email: 1, image: 1 } }],
          as: "userDoc",
        },
      },
      { $unwind: { path: "$userDoc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "products",
          let: {
            pid: { $convert: { input: "$productId", to: "objectId", onError: null, onNull: null } },
          },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$pid"] } } }, { $project: { title: 1, slug: 1, image: 1, price: 1 } }],
          as: "productDoc",
        },
      },
      { $unwind: { path: "$productDoc", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: searchOr,
        },
      },
    ];

    const countPipeline = [...pipeline, { $count: "total" }];
    const dataPipeline = [...pipeline, { $sort: sortStage }, { $skip: skip }, { $limit: limit }];

    const [countResult, reviews] = await Promise.all([
      ProductReview.aggregate(countPipeline),
      ProductReview.aggregate(dataPipeline),
    ]);
    const total = countResult[0]?.total ?? 0;

    return {
      reviews: reviews.map((r: any) =>
        formatReview(r, r.userDoc, r.productDoc)
      ),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  }

  // No search — simple find with sort
  const [reviews, total] = await Promise.all([
    ProductReview.find(filter).sort(sortStage).skip(skip).limit(limit).lean(),
    ProductReview.countDocuments(filter),
  ]);

  // Attach reviewer + product details with two batched lookups
  const { userMap, productMap } = await loadReviewContext(reviews);

  return {
    reviews: reviews.map((r: any) =>
      formatReview(
        r,
        userMap.get(r.userId?.toString()),
        productMap.get(r.productId?.toString())
      )
    ),
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

/**
 * A seller's own feedback: every review on a listing they own.
 *
 * The ids are resolved here, from the token's vendor account, so the review
 * reader never has to trust a scope that arrived in the request.
 */
export async function getVendorReviews(vendorId: string, query: GetReviewsQuery) {
  const productIds = await Product.find({ vendorId: idQuery(vendorId) }).distinct("_id");
  return getReviews(
    query,
    productIds.map((id: any) => String(id))
  );
}

/**
 * A review has to be earned: the product must have been delivered to the
 * customer, and each customer gets one review per product.
 *
 * Both rules are reported as 400/409 rather than 403 so the storefront can show
 * the reason instead of bouncing the user to the forbidden page.
 */
async function assertEligibleToReview(userId: string, productId: string) {
  const alreadyReviewed = await ProductReview.findOne({
    userId: idQuery(userId),
    productId: idQuery(productId),
  })
    .select("_id")
    .lean();
  if (alreadyReviewed) throw new ApiError(409, "You have already reviewed this product");

  const deliveredOrder = await Order.findOne({
    userId,
    orderStatus: "delivered",
    "items.productId": idQuery(productId),
  })
    .select("_id")
    .lean();
  if (!deliveredOrder) {
    throw new ApiError(400, "You can review this product once your order has been delivered");
  }
}

export async function createReview(data: CreateReviewInput, userId: string) {
  await assertEligibleToReview(userId, data.productId);

  const [review, user, product] = await Promise.all([
    ProductReview.create({ ...data, userId }),
    User.findById(userId).lean(),
    Product.findById(data.productId).lean(),
  ]);

  // The store team answers reviews, so a new one is their work queue growing.
  await recordActivity({
    type: "review",
    title: `New review from ${user?.name || "a customer"}`,
    detail: reviewSummary(review.rating, product?.title),
    ref: review._id.toString(),
  });

  return formatReview(
    { ...review.toObject(), createdAt: (review as any).createdAt },
    user,
    product
  );
}

export async function updateReview(
  id: string,
  data: UpdateReviewInput,
  requesterId?: string,
  requesterRole?: string
) {
  const review = await ProductReview.findById(id);
  if (!review) throw new ApiError(404, "Review not found");

  // Admins cannot submit (and therefore cannot edit) reviews
  if (isAdminRole(requesterRole)) {
    throw new ApiError(403, "Admins cannot edit reviews.");
  }

  // Only the reviewer themselves can edit their own review
  if (String(review.userId) !== String(requesterId)) {
    throw new ApiError(403, "You can only edit your own reviews.");
  }

  const updated = await ProductReview.findByIdAndUpdate(id, data, { new: true })
    .populate("userId", "name email image")
    .populate("productId", "title slug image price");
  if (!updated) throw new ApiError(404, "Review not found");

  // An edit changes what the store is being told, so the feed shows it too.
  await recordActivity({
    type: "review",
    title: `${(updated as any).userId?.name || "A customer"} updated a review`,
    detail: reviewSummary(updated.rating, (updated as any).productId?.title),
    ref: updated._id.toString(),
  });

  return formatReview(updated, (updated as any).userId, (updated as any).productId);
}

export async function deleteReview(id: string, requester?: { id?: string; role?: string }) {
  const review = await ProductReview.findById(id);
  if (!review) throw new ApiError(404, "Review not found");

  // The reviewer can remove their own review; an admin can moderate any review;
  // a seller moderates the feedback left on their own listing, and nothing else.
  const isReviewer = requester?.id && String(review.userId) === String(requester.id);
  const isAdmin = isAdminRole(requester?.role);
  const ownsProduct =
    !isReviewer && !isAdmin && requester?.id
      ? await Product.exists({ _id: review.productId, vendorId: requester.id })
      : false;

  if (!isReviewer && !isAdmin && !ownsProduct) {
    throw new ApiError(403, "You can only delete your own reviews.");
  }

  await ProductReview.findByIdAndDelete(id);
}