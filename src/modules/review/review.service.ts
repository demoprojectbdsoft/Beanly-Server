import { Types } from "mongoose";
import { ProductReview } from "./review.model";
import { User } from "../user/user.model";
import { Product } from "../product/product.model";
import { CreateReviewInput, UpdateReviewInput, GetReviewsQuery } from "./review.validator";

// Converts a string ID into a filter that matches both string and ObjectId forms in MongoDB
function toIdQuery(id: string) {
  return Types.ObjectId.isValid(id) ? { $in: [id, new Types.ObjectId(id)] } : id;
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
    date: r.createdAt,
  };
}

export async function getReviews(query: GetReviewsQuery) {
  const { productId, userId, rating, search, sort, page, limit } = query;

  // Build base filter — only add fields if provided
  const filter: any = {};
  if (productId) filter.productId = toIdQuery(productId);
  if (userId) filter.userId = toIdQuery(userId);
  if (rating) filter.rating = rating;

  // Determine sort order
  let sortStage: any = { createdAt: -1 }; // default: newest
  if (sort === "oldest") sortStage = { createdAt: 1 };
  else if (sort === "rating_high") sortStage = { rating: -1, createdAt: -1 };
  else if (sort === "rating_low") sortStage = { rating: 1, createdAt: -1 };

  const skip = (page - 1) * limit;

  // If search is provided we need to join users/products to search across names/titles
  if (search && search.trim()) {
    const searchRegex = new RegExp(search.trim(), "i");

    // Use aggregation to join user and product, then filter by search term
    const pipeline: any[] = [
      { $match: filter },
      {
        $lookup: {
          from: "users",
          let: { uid: { $toObjectId: "$userId" } },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$uid"] } } }, { $project: { name: 1, email: 1, image: 1 } }],
          as: "userDoc",
        },
      },
      { $unwind: { path: "$userDoc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "products",
          let: { pid: { $toObjectId: "$productId" } },
          pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$pid"] } } }, { $project: { title: 1, slug: 1, image: 1, price: 1 } }],
          as: "productDoc",
        },
      },
      { $unwind: { path: "$productDoc", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          $or: [
            { comment: searchRegex },
            { "userDoc.name": searchRegex },
            { "productDoc.title": searchRegex },
          ],
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

  // Fetch all reviewer user docs in one query, then map by ID for O(1) lookup
  const userIds = reviews
    .map((r: any) => {
      const uid = r.userId?.toString();
      return Types.ObjectId.isValid(uid) ? new Types.ObjectId(uid) : null;
    })
    .filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }).lean();
  const userMap = new Map(users.map((u: any) => [u._id.toString(), u]));

  // Fetch all product docs in one query, then map by ID for O(1) lookup
  const productIds = reviews
    .map((r: any) => {
      const pid = r.productId?.toString();
      return Types.ObjectId.isValid(pid) ? new Types.ObjectId(pid) : null;
    })
    .filter(Boolean);
  const products = await Product.find({ _id: { $in: productIds } }).lean();
  const productMap = new Map(products.map((p: any) => [p._id.toString(), p]));

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

export async function createReview(data: CreateReviewInput) {
  const [review, user, product] = await Promise.all([
    ProductReview.create(data),
    User.findById(data.userId).lean(),
    Product.findById(data.productId).lean(),
  ]);
  return formatReview(
    { ...review.toObject(), createdAt: (review as any).createdAt },
    user,
    product
  );
}

export async function updateReview(id: string, data: UpdateReviewInput) {
  return ProductReview.findByIdAndUpdate(id, data, { new: true }).lean();
}

export async function deleteReview(id: string) {
  await ProductReview.findByIdAndDelete(id);
}