import { Schema, model } from "mongoose";

const productReviewSchema = new Schema(
  {
    productId: { type: Schema.Types.Mixed, ref: "Product", required: true },
    userId: { type: Schema.Types.Mixed, ref: "User", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, required: true },
    images: { type: [String], default: [] }, // up to 5 review photo URLs
  },
  { timestamps: true }
);

export const ProductReview = model("ProductReview", productReviewSchema);