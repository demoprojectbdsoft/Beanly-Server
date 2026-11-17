import { z } from "zod";
import { warehouseInputSchema } from "../../utils/warehouse";
import { VENDOR_STORE_STATUSES } from "./vendor.types";

/**
 * What a vendor may change about their own storefront.
 *
 * The store's slug, status, counters and promotion flags are deliberately
 * absent: they are either permanent (links are built from the slug) or owned
 * by the store team (status, featured placement).
 */

const addressSchema = z.object({
  country: z.string().trim().max(80).optional().default("Bangladesh"),
  division: z.string().trim().max(80).optional().default(""),
  city: z.string().trim().max(80).optional().default(""),
  area: z.string().trim().max(120).optional().default(""),
  address: z.string().trim().max(400).optional().default(""),
  postalCode: z.string().trim().max(20).optional().default(""),
  latitude: z.coerce.number().min(-90).max(90).nullable().optional(),
  longitude: z.coerce.number().min(-180).max(180).nullable().optional(),
});

const socialLinksSchema = z.object({
  facebook: z.string().trim().max(300).optional().default(""),
  instagram: z.string().trim().max(300).optional().default(""),
  x: z.string().trim().max(300).optional().default(""),
  linkedin: z.string().trim().max(300).optional().default(""),
});

export const updateStoreSchema = z
  .object({
    name: z.string().trim().min(2, "Store name is too short").max(120).optional(),
    description: z.string().trim().max(2000).optional(),
    logo: z.string().trim().max(500).optional(),
    coverImage: z.string().trim().max(500).optional(),
    email: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(30).optional(),
    category: z.string().trim().max(80).optional(),
    website: z.string().trim().max(300).optional(),
    address: addressSchema.optional(),
    warehouse: warehouseInputSchema.optional(),
    socialLinks: socialLinksSchema.optional(),
    isVisible: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });

export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

/**
 * The store team's read of every shop.
 *
 * A seller never asks this for a list — they have `/vendor-store/mine` — so the
 * filters here exist for the desks that must choose a shop among everyone's.
 */
export const storeQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum([...VENDOR_STORE_STATUSES, "all"]).optional().default("all"),
  /** Only the shops a placement is lighting up right now. */
  featured: z
    .preprocess(
      (value) =>
        value === "true" || value === true ? true : value === "false" || value === false ? false : undefined,
      z.boolean().optional()
    ),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type StoreQuery = z.infer<typeof storeQuerySchema>;

/**
 * The shopper's read of the shops that trade today. The `sort` list accepts
 * "featured", "rating", "newest" and "popular".
 *
 * There is no status filter here on purpose: the public only ever sees an
 * active, visible shop, so the one choice a caller gets is which of those
 * to put first. `featured` narrows to the shops a paid placement is lighting
 * up right now, so a stale flag cannot keep a shop on the rail.
 */
export const publicStoreQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  category: z.string().trim().max(80).optional(),
  featured: z
    .preprocess(
      (value) =>
        value === "true" || value === true ? true : value === "false" || value === false ? false : undefined,
      z.boolean().optional()
    ),
  sort: z.enum(["featured", "latest", "rating", "newest", "popular"]).optional().default("featured"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});

export type PublicStoreQuery = z.infer<typeof publicStoreQuerySchema>;

/** A storefront URL segment: the slug the shop was published under. */
export const storeSlugParamSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(2, "Store not found")
    .max(140)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Store not found"),
});
