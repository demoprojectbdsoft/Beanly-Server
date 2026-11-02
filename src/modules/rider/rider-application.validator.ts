import { z } from "zod";
import {
  RIDER_APPLICATION_STATUSES,
  RIDER_TIME_SLOTS,
  RIDER_VEHICLE_TYPES,
  RIDER_WEEK_DAYS,
} from "./rider.types";

/**
 * What a rider submission may contain.
 *
 * The wizard collects six steps, but every step is optional on the wire except
 * the identity block, because the applicant may save a partial draft. The
 * service treats `submit === true` on the final call as the "must be complete"
 * signal and only refuses then, so the earlier auto-saves never fail.
 */

const personalInfoSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(120),
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  /**
   * Required on submission. The wizard prefills it from the account, but an
   * account can exist without a phone, and dispatch cannot reach a rider who
   * has given no number — so the identity step asks for one before the last
   * step is reachable. Drafts stay lenient (`saveRiderDraftSchema` partials it).
   */
  phone: z
    .string()
    .trim()
    .min(6, "Enter a contact phone number")
    .max(30, "Phone number is too long"),
  dateOfBirth: z.coerce.date().nullable().optional(),
  nationalId: z.string().trim().max(60).optional().default(""),
  photoUrl: z.string().trim().max(500).optional().default(""),
});

const contactInfoSchema = z
  .object({
    emergencyContactName: z.string().trim().max(120).optional().default(""),
    emergencyContactPhone: z.string().trim().max(30).optional().default(""),
    preferredContact: z.enum(["phone", "email", "whatsapp"]).default("phone"),
  })
  .optional()
  .default({ emergencyContactName: "", emergencyContactPhone: "", preferredContact: "phone" });

const serviceAddressSchema = z.object({
  country: z.string().trim().min(2).default("Bangladesh"),
  division: z.string().trim().max(80).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  area: z.string().trim().max(120).optional().default(""),
  address: z.string().trim().max(400).optional().default(""),
  postalCode: z.string().trim().max(20).optional().default(""),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

const vehicleSchema = z.object({
  type: z.enum(RIDER_VEHICLE_TYPES as unknown as [string, ...string[]]).default("motorcycle"),
  number: z.string().trim().max(40).optional().default(""),
  licenseNumber: z.string().trim().max(60).optional().default(""),
  licenseExpiry: z.coerce.date().nullable().optional(),
  hasOwnVehicle: z.boolean().default(true),
});

const documentsSchema = z
  .object({
    drivingLicenseUrl: z.string().trim().max(500).optional().default(""),
    nationalIdUrl: z.string().trim().max(500).optional().default(""),
    vehicleDocsUrl: z.string().trim().max(500).optional().default(""),
    otherUrl: z.string().trim().max(500).optional().default(""),
    notes: z.string().trim().max(2000).optional().default(""),
  })
  .optional()
  .default({
    drivingLicenseUrl: "",
    nationalIdUrl: "",
    vehicleDocsUrl: "",
    otherUrl: "",
    notes: "",
  });

const availabilitySchema = z
  .object({
    days: z.array(z.enum(RIDER_WEEK_DAYS as unknown as [string, ...string[]])).default([]),
    slots: z.array(z.enum(RIDER_TIME_SLOTS as unknown as [string, ...string[]])).default([]),
    maxDistanceKm: z.coerce.number().int().nonnegative().max(200).default(15),
    note: z.string().trim().max(500).optional().default(""),
  })
  .optional()
  .default({ days: [], slots: [], maxDistanceKm: 15, note: "" });

const experienceSchema = z
  .object({
    years: z.coerce.number().int().nonnegative().max(60).default(0),
    previousPlatforms: z.string().trim().max(300).optional().default(""),
    note: z.string().trim().max(1000).optional().default(""),
  })
  .optional()
  .default({ years: 0, previousPlatforms: "", note: "" });

/**
 * The submission body.
 *
 * `confirm` is the wizard's final checkbox — the applicant had to tick it
 * before the submit button became live. The service refuses to create a
 * pending row without it, so a stray POST from a stale tab cannot open an
 * application the person never meant to send.
 */
export const createRiderApplicationSchema = z.object({
  personalInfo: personalInfoSchema,
  contactInfo: contactInfoSchema,
  serviceAddress: serviceAddressSchema,
  vehicle: vehicleSchema,
  documents: documentsSchema,
  availability: availabilitySchema,
  experience: experienceSchema,
  confirm: z.boolean().default(false),
});

/**
 * A draft save. Same shape as the submission, but every section is optional
 * because the wizard posts it mid-step. The service keeps the row's status at
 * `pending` only when the applicant finally submits; a draft row is what the
 * wizard rehydrates from.
 */
export const saveRiderDraftSchema = z
  .object({
    personalInfo: personalInfoSchema.partial().optional(),
    contactInfo: contactInfoSchema.optional(),
    serviceAddress: serviceAddressSchema.partial().optional(),
    vehicle: vehicleSchema.partial().optional(),
    documents: documentsSchema.optional(),
    availability: availabilitySchema.optional(),
    experience: experienceSchema.optional(),
  })
  .passthrough();

export const reviewRiderApplicationSchema = z
  .object({
    action: z.enum(["under_review", "approve", "reject"]),
    reason: z.string().trim().max(1000).optional().default(""),
    notes: z.string().trim().max(2000).optional().default(""),
  })
  .refine((value) => value.action !== "reject" || value.reason.trim().length >= 3, {
    message: "A rejection reason is required",
    path: ["reason"],
  });

export const riderApplicationQuerySchema = z.object({
  status: z.enum([...RIDER_APPLICATION_STATUSES, "all"]).optional().default("all"),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export const riderStatusLookupSchema = z.object({
  email: z.string().trim().toLowerCase().email("A valid email is required"),
});

export type CreateRiderApplicationInput = z.infer<typeof createRiderApplicationSchema>;
export type SaveRiderDraftInput = z.infer<typeof saveRiderDraftSchema>;
export type ReviewRiderApplicationInput = z.infer<typeof reviewRiderApplicationSchema>;
export type RiderApplicationQuery = z.infer<typeof riderApplicationQuerySchema>;
