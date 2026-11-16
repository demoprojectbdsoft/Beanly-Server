import { z } from "zod";
import { objectIdSchema } from "../../utils/ids";
import { WARRANTY_TYPE_VALUES } from "../warranty/warranty.types";
import { VENDOR_PRODUCT_STATUSES } from "./vendor.types";

/**
 * What a vendor may write about one of their own products.
 *
 * The ownership fields (`ownerId`, `vendorId`, `storeId`), the slug suffix, the
 * counters and `isFeatured` are absent on purpose: the service derives them
 * from the token and the plan, so a vendor cannot publish as someone else or
 * promote their own product for free.
 *
 * Badges, the offer countdown and the warranty are about the product itself, so
 * they use the same fields and limits as the admin form — a listing saved from
 * either dashboard reads the same everywhere.
 */

const objectId = objectIdSchema("Invalid ID");

const variantSchema = z.object({
  name: z.string().trim().min(1, "Name the option").max(40),
  values: z
    .array(z.string().trim().min(1).max(60))
    .min(1, "Add at least one value")
    .max(20),
});

const shippingSchema = z.object({
  weightKg: z.number().nonnegative().max(1000).nullable().optional(),
  deliveryDays: z.number().int().nonnegative().max(90).nullable().optional(),
  freeShipping: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
});

export const vendorProductSchema = z.object({
  title: z.string().trim().min(2, "Title is too short").max(160),
  /** Left empty by the form; the service derives a unique slug from the title. */
  slug: z
    .string()
    .trim()
    .max(160)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase, hyphen-separated")
    .optional()
    .or(z.literal("")),

  categoryId: objectId,
  subCategoryIds: z.array(objectId).max(10).optional(),

  price: z.number().positive("Price must be positive"),
  originalPrice: z.number().positive().nullable().optional(),

  image: z.string().url("Image must be a valid URL"),
  additionalImages: z.array(z.string().url()).max(8).optional(),

  stockQuantity: z.number().int().nonnegative().nullable().optional(),
  sku: z.string().trim().max(80).optional(),
  brand: z.string().trim().max(80).optional(),
  description: z.string().trim().max(5000).optional(),
  specifications: z.record(z.string(), z.any()).optional(),

  badges: z.array(z.string().trim().max(40)).max(6).optional(),
  offerEndDate: z.coerce.date().nullable().optional(),
  warrantyPeriodMonths: z.number().int().nonnegative().max(120).optional(),
  warrantyType: z.enum(WARRANTY_TYPE_VALUES).optional(),
  warrantyTerms: z.string().trim().max(1000).optional(),

  variantOptions: z.array(variantSchema).max(5).optional(),
  shippingInfo: shippingSchema.optional(),

  isVisible: z.boolean().optional(),
});

export const updateVendorProductSchema = vendorProductSchema.partial().extend({
  status: z.enum(["draft", "published", "archived", "out_of_stock"]).optional(),
});

export const createVendorProductSchema = vendorProductSchema.extend({
  /** `true` publishes immediately; the default saves a draft. */
  publish: z.boolean().optional().default(false),
});

export const vendorProductQuerySchema = z.object({
  status: z.enum([...VENDOR_PRODUCT_STATUSES, "all"]).optional().default("all"),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateVendorProductInput = z.infer<typeof createVendorProductSchema>;
export type UpdateVendorProductInput = z.infer<typeof updateVendorProductSchema>;
export type VendorProductQuery = z.infer<typeof vendorProductQuerySchema>;
