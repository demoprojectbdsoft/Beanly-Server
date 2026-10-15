import { Schema, model } from "mongoose";

const productSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    subCategoryIds: [{ type: Schema.Types.ObjectId, ref: "SubCategory" }],

    price: { type: Number, required: true },
    originalPrice: { type: Number },
    investPrice: { type: Number },   // admin-only: purchase / cost price for profit tracking
    // discountPercentage intentionally NOT stored — computed on read

    image: { type: String, required: true },           // main image
    additionalImages: [{ type: String }],               // gallery

    inStock: { type: Boolean, default: true },
    stockQuantity: { type: Number },
    sellCount: { type: Number, default: 0 },

    rating: { type: Number },
    reviewCount: { type: Number },

    badges: [{ type: String }],

    sku: { type: String },
    description: { type: String },
    specifications: { type: Map, of: String },
    isFeatured: { type: Boolean, default: false },
    offerEndDate: { type: Date },
    offerExpired: { type: Boolean, default: false }, // set true by cron once offer lapses
  },
  { timestamps: true }
);

export const Product = model("Product", productSchema);