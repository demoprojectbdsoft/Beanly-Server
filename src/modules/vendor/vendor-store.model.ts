import { Schema, model } from "mongoose";
import { warehouseSchema } from "../../utils/warehouse";
import { VENDOR_STORE_STATUSES } from "./vendor.types";

/**
 * The shop behind a vendor account.
 *
 * A store belongs to exactly one user and a user owns at most one store, so
 * the `userId` index is unique. Everything the public storefront shows lives
 * here; everything private (licence numbers, uploaded documents) stays on the
 * application, which is only ever read by the owner and an admin.
 */

const storeAddressSchema = new Schema(
  {
    country: { type: String, default: "Bangladesh" },
    division: { type: String, default: "" },
    city: { type: String, default: "" },
    area: { type: String, default: "" },
    address: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
  },
  { _id: false }
);

const socialLinksSchema = new Schema(
  {
    facebook: { type: String, default: "" },
    instagram: { type: String, default: "" },
    x: { type: String, default: "" },
    linkedin: { type: String, default: "" },
  },
  { _id: false }
);

const vendorStoreSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    /** The application that created this store. */
    applicationId: { type: Schema.Types.ObjectId, ref: "VendorApplication", default: null },

    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    description: { type: String, default: "" },

    logo: { type: String, default: "" },
    coverImage: { type: String, default: "" },

    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    address: { type: storeAddressSchema, default: () => ({}) },
    /**
     * Where the stock actually waits for the rider, when that is not the shop
     * itself. The rider's pickup panel reads this before the storefront address.
     */
    warehouse: { type: warehouseSchema, default: () => ({}) },
    socialLinks: { type: socialLinksSchema, default: () => ({}) },

    /** Which business category the storefront groups the shop under. */
    category: { type: String, default: "", index: true },
    website: { type: String, default: "" },

    status: {
      type: String,
      enum: VENDOR_STORE_STATUSES,
      default: "active",
      index: true,
    },
    /** Hidden shops stay reachable by link but leave the public listings. */
    isVisible: { type: Boolean, default: true },

    /**
     * Subscription-based promotion. Kept denormalised on the store so the
     * public listing can filter and sort without joining the subscription on
     * every request; the promotion service is the only writer.
     */
    isFeatured: { type: Boolean, default: false, index: true },
    featuredUntil: { type: Date, default: null },

    /** Cached public counters, recomputed by the product and review services. */
    productCount: { type: Number, default: 0 },
    reviewCount: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    /** Completed orders, used by the "top vendors" ranking. */
    completedOrders: { type: Number, default: 0 },
    lifetimeSales: { type: Number, default: 0 },

    suspendedReason: { type: String, default: "" },
    suspendedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// The public listing: visible, active shops, featured first.
vendorStoreSchema.index({ isVisible: 1, status: 1, isFeatured: -1, rating: -1 });

export const VendorStore = model("VendorStore", vendorStoreSchema);
