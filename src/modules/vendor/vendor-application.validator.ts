import { z } from "zod";
import { BILLING_CYCLES, VENDOR_APPLICATION_STATUSES, VENDOR_PLAN_IDS } from "./vendor.types";

/**
 * What a submission may contain.
 *
 * The personal step is filled from the signed-in account, so it is validated
 * like any other input: the browser may prefill it, but it still has to be a
 * sensible name and a real email by the time it reaches the service.
 */

const personalInfoSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  /**
   * Required on submission, exactly as in the rider application: a store the
   * review team cannot call cannot be onboarded, and buyers need a contact
   * that reaches a person.
   */
  phone: z
    .string()
    .trim()
    .min(6, "Enter a contact phone number")
    .max(30, "Phone number is too long"),
  contactInfo: z.string().trim().max(200).optional().default(""),
});

const socialLinksSchema = z
  .object({
    facebook: z.string().trim().max(300).optional().default(""),
    instagram: z.string().trim().max(300).optional().default(""),
    x: z.string().trim().max(300).optional().default(""),
    linkedin: z.string().trim().max(300).optional().default(""),
  })
  .optional()
  .default({ facebook: "", instagram: "", x: "", linkedin: "" });

const storeInfoSchema = z.object({
  name: z.string().trim().min(2, "Store name is required").max(120),
  /** Optional: the service derives one from the name when it is missing. */
  slug: z
    .string()
    .trim()
    .max(60)
    .optional()
    .default(""),
  description: z.string().trim().max(2000).optional().default(""),
  logo: z.string().trim().max(500).optional().default(""),
  coverImage: z.string().trim().max(500).optional().default(""),
  email: z.string().trim().max(200).optional().default(""),
  phone: z.string().trim().max(30).optional().default(""),
  category: z.string().trim().max(80).optional().default(""),
  website: z.string().trim().max(300).optional().default(""),
  socialLinks: socialLinksSchema,
});

const businessAddressSchema = z.object({
  country: z.string().trim().min(2).default("Bangladesh"),
  division: z.string().trim().max(80).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  area: z.string().trim().max(120).optional().default(""),
  address: z.string().trim().max(400).optional().default(""),
  postalCode: z.string().trim().max(20).optional().default(""),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

/**
 * Business verification. Everything here is optional on purpose: a home seller
 * has no licence, and the marketplace must not turn it away for that.
 */
const verificationSchema = z
  .object({
    businessType: z.string().trim().max(80).optional().default(""),
    registrationNumber: z.string().trim().max(120).optional().default(""),
    documentUrl: z.string().trim().max(500).optional().default(""),
    notes: z.string().trim().max(2000).optional().default(""),
  })
  .optional()
  .default({
    businessType: "",
    registrationNumber: "",
    documentUrl: "",
    notes: "",
  });

export const createApplicationSchema = z.object({
  personalInfo: personalInfoSchema,
  storeInfo: storeInfoSchema,
  businessAddress: businessAddressSchema,
  verification: verificationSchema,
  selectedPlan: z.enum(VENDOR_PLAN_IDS).default("free"),
  billingCycle: z.enum(BILLING_CYCLES).default("monthly"),
});

/**
 * The vendor's own edit of their file.
 *
 * The submission must be complete to be reviewed; the profile page is the
 * opposite case — the seller corrects one thing at a time and saves, so every
 * field here is optional while keeping the ceilings and the enums of the
 * submission schema.
 *
 * Two deliberate absences. `storeInfo.slug` is not editable, because every
 * published link to the shop is built from it. And `selectedPlan` /
 * `billingCycle` are not editable here either: a plan is a paid change, and the
 * subscription desk is the only place that may take money for one.
 *
 * `isVisible` is a storefront switch rather than an application answer, but the
 * profile page is the one form a seller fills, so it rides along and is written
 * straight to the store row.
 */
const editPersonalInfoSchema = z.object({
  fullName: z.string().trim().max(120).optional(),
  /** The login email is not written from here, but a typed one is still checked. */
  email: z.string().trim().toLowerCase().email("A valid email is required").optional(),
  phone: z.string().trim().max(30).optional(),
  contactInfo: z.string().trim().max(200).optional(),
});

const editStoreInfoSchema = z.object({
  name: z.string().trim().max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  logo: z.string().trim().max(500).optional(),
  coverImage: z.string().trim().max(500).optional(),
  email: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(30).optional(),
  category: z.string().trim().max(80).optional(),
  website: z.string().trim().max(300).optional(),
  socialLinks: socialLinksSchema.optional(),
});

const editBusinessAddressSchema = z.object({
  country: z.string().trim().max(80).optional(),
  division: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  area: z.string().trim().max(120).optional(),
  address: z.string().trim().max(400).optional(),
  postalCode: z.string().trim().max(20).optional(),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

const editVerificationSchema = z.object({
  businessType: z.string().trim().max(80).optional(),
  registrationNumber: z.string().trim().max(120).optional(),
  documentUrl: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const APPLICATION_SECTIONS = [
  "personalInfo",
  "storeInfo",
  "businessAddress",
  "verification",
] as const;

export const updateMyApplicationSchema = z
  .object({
    personalInfo: editPersonalInfoSchema.optional(),
    storeInfo: editStoreInfoSchema.optional(),
    businessAddress: editBusinessAddressSchema.optional(),
    verification: editVerificationSchema.optional(),
    isVisible: z.boolean().optional(),
  })
  .refine(
    (value) =>
      APPLICATION_SECTIONS.some((section) => value[section] !== undefined) ||
      value.isVisible !== undefined,
    { message: "Nothing to update" }
  );

export const reviewApplicationSchema = z
  .object({
    action: z.enum(["under_review", "approve", "reject"]),
    reason: z.string().trim().max(1000).optional().default(""),
    notes: z.string().trim().max(2000).optional().default(""),
  })
  .refine((value) => value.action !== "reject" || value.reason.trim().length >= 3, {
    message: "A rejection reason is required",
    path: ["reason"],
  });

export const applicationQuerySchema = z.object({
  status: z.enum([...VENDOR_APPLICATION_STATUSES, "all"]).optional().default("all"),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

/** The internal status lookup: the caller has already checked the password. */
export const applicationStatusLookupSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
});

export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;
export type UpdateMyApplicationInput = z.infer<typeof updateMyApplicationSchema>;
export type ReviewApplicationInput = z.infer<typeof reviewApplicationSchema>;
export type VendorApplicationQuery = z.infer<typeof applicationQuerySchema>;
