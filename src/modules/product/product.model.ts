import { Schema, model } from "mongoose";

const productSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    /**
     * Set when a vendor created the product. Admin-created products leave both
     * empty, which is how the catalogue tells "platform stock" from "a seller's
     * stock" without a second collection.
     */
    vendorId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    storeId: { type: Schema.Types.ObjectId, ref: "VendorStore", default: null, index: true },
    title: { type: String, required: true },
    slug: { type: String, required: true, unique: true },

    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true },
    subCategoryIds: [{ type: Schema.Types.ObjectId, ref: "SubCategory" }],

    price: { type: Number, required: true },
    originalPrice: { type: Number },
    investPrice: { type: Number },   // the owner's purchase / cost price, for profit tracking
    // discountPercentage intentionally NOT stored — computed on read

    image: { type: String, required: true },           // main image
    additionalImages: [{ type: String }],               // gallery

    inStock: { type: Boolean, default: true },
    // Left empty when the product is not stock-tracked: no count, no limit and
    // no decrement is applied to it anywhere in the app.
    stockQuantity: { type: Number },
    sellCount: { type: Number, default: 0 },

    rating: { type: Number },
    reviewCount: { type: Number },

    badges: [{ type: String }],

    sku: { type: String },
    brand: { type: String, default: "" },
    description: { type: String },
    specifications: { type: Schema.Types.Mixed, default: {} },

    /**
     * The vendor's own lifecycle for a product. Unset on admin-created products,
     * which are treated as live. The public catalogue only serves "published"
     * and "out_of_stock" rows.
     */
    vendorProductStatus: {
      type: String,
      enum: ["draft", "pending_review", "published", "rejected", "archived", "out_of_stock"],
      default: undefined,
      index: true,
    },
    vendorRejectionReason: { type: String, default: "" },
    submittedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },

    /** A vendor can hide a published product without archiving it. */
    isVisible: { type: Boolean, default: true, index: true },

    /** Lightweight variant labels (colour, size…); pricing stays on the row. */
    variantOptions: [
      {
        name: { type: String, required: true },
        values: [{ type: String }],
        _id: false,
      },
    ],

    shippingInfo: {
      weightKg: { type: Number, default: null },
      deliveryDays: { type: Number, default: null },
      freeShipping: { type: Boolean, default: false },
      note: { type: String, default: "" },
    },

    isFeatured: { type: Boolean, default: false },
    offerEndDate: { type: Date },
    offerExpired: { type: Boolean, default: false }, // set true by cron once offer lapses

    /**
     * Warranty period for this product, in months.
     * This is the cover promised on the product page, counted from delivery.
     * 0 or undefined means the product is not covered by warranty.
     */
    warrantyPeriodMonths: { type: Number, default: 0, min: 0 },
    warrantyType: {
      type: String,
      enum: ["manufacturer-warranty", "seller-warranty", "extended-warranty", "other", "none"],
      default: "manufacturer-warranty",
    },
    warrantyTerms: { type: String },
  },
  {
    timestamps: true,
    toJSON: { flattenMaps: true },
    toObject: { flattenMaps: true },
  }
);

export const Product = model("Product", productSchema);