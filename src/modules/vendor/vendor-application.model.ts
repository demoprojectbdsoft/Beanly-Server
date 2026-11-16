import { Schema, model } from "mongoose";
import { BILLING_CYCLES, VENDOR_APPLICATION_STATUSES } from "./vendor.types";

/**
 * One person's request to sell on the platform.
 *
 * The application is the record of what was submitted, so every field is a
 * snapshot: editing a store later never rewrites what an admin reviewed. A
 * resubmission after a rejection is a new entry in `history` on the same row,
 * which keeps the review trail in one place.
 */

const personalInfoSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: "" },
    contactInfo: { type: String, default: "" },
  },
  { _id: false }
);

const storeInfoSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    description: { type: String, default: "" },
    logo: { type: String, default: "" },
    coverImage: { type: String, default: "" },
    email: { type: String, default: "" },
    phone: { type: String, default: "" },
    category: { type: String, default: "" },
    website: { type: String, default: "" },
    socialLinks: {
      facebook: { type: String, default: "" },
      instagram: { type: String, default: "" },
      x: { type: String, default: "" },
      linkedin: { type: String, default: "" },
    },
  },
  { _id: false }
);

const businessAddressSchema = new Schema(
  {
    country: { type: String, required: true, default: "Bangladesh" },
    division: { type: String, default: "" },
    city: { type: String, default: "" },
    area: { type: String, default: "" },
    address: { type: String, default: "" },
    postalCode: { type: String, default: "" },
    /** Optional pin the applicant dropped on the map. */
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
  },
  { _id: false }
);

const verificationSchema = new Schema(
  {
    businessType: { type: String, default: "" },
    /** Optional on purpose: a home seller has no licence number. */
    registrationNumber: { type: String, default: "" },
    documentUrl: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

/** One line of the review trail. */
const applicationEventSchema = new Schema(
  {
    status: { type: String, enum: VENDOR_APPLICATION_STATUSES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: "" },
  },
  { _id: false }
);

const vendorApplicationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    /** "APP-XXXXXX" — the reference the applicant quotes to support. */
    reference: { type: String, required: true, unique: true },

    status: {
      type: String,
      enum: VENDOR_APPLICATION_STATUSES,
      default: "pending",
      index: true,
    },

    personalInfo: { type: personalInfoSchema, required: true },
    storeInfo: { type: storeInfoSchema, required: true },
    businessAddress: { type: businessAddressSchema, required: true },
    verification: { type: verificationSchema, default: () => ({}) },

    /** The plan the applicant picked; the subscription is created on approval. */
    selectedPlan: { type: String, default: "free" },
    billingCycle: { type: String, enum: BILLING_CYCLES, default: "monthly" },

    /** Filled by the reviewer. */
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: "" },
    reviewNotes: { type: String, default: "" },

    /** The store created on approval, so a retry never makes a second one. */
    storeId: { type: Schema.Types.ObjectId, ref: "VendorStore", default: null },

    submittedAt: { type: Date, default: Date.now },
    /** How many times the applicant submitted after a rejection. */
    resubmissionCount: { type: Number, default: 0 },

    history: { type: [applicationEventSchema], default: [] },
  },
  { timestamps: true }
);

/**
 * One account may hold one application at a time. The partial index only
 * covers rows that are still in play, so a rejected applicant can apply again
 * (the old rejected row stays for the audit trail) while a duplicate open
 * application is impossible.
 */
vendorApplicationSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["pending", "under_review", "approved"] } },
    name: "one_open_application_per_user",
  }
);

// The admin list sorts by newest first and filters by status.
vendorApplicationSchema.index({ status: 1, submittedAt: -1 });

export const VendorApplication = model("VendorApplication", vendorApplicationSchema);
