import { z } from "zod";

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID");

export const createProductSchema = z.object({
  ownerId: objectId,
  title: z.string().min(1, "Title is required"),
  slug: z
    .string()
    .min(1, "Slug is required")
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase, hyphen-separated"),

  categoryId: objectId,
  subCategoryIds: z.array(objectId).optional(),

  price: z.number().positive("Price must be positive"),
  originalPrice: z.number().positive().optional(),
  investPrice: z.number().nonnegative().optional(), // admin-only: purchase/cost price

  image: z.string().url("Image must be a valid URL"),
  additionalImages: z.array(z.string().url()).optional(),

   inStock: z.boolean().optional(),
  stockQuantity: z.number().int().nonnegative().optional(),
  sellCount: z.number().int().nonnegative().optional(),

  badges: z.array(z.string()).optional(),  // plain strings, matches current form

  sku: z.string().optional(),
  description: z.string().optional(),
  specifications: z.record(z.string(), z.string()).optional(),
  isFeatured: z.boolean().optional(),
  offerEndDate: z.coerce.date().optional().nullable(),
});

export const updateProductSchema = createProductSchema.partial();

export const getProductsQuerySchema = z.object({
  category: z.string().optional(),
  categoryId: z.string().optional(),
  subCategory: z.string().optional(),
  subCategoryId: z.string().optional(),
  search: z.string().optional(),
  minPrice: z.coerce.number().nonnegative().optional(),
  maxPrice: z.coerce.number().nonnegative().optional(),
  minDiscount: z.coerce.number().nonnegative().optional(),
  maxDiscount: z.coerce.number().nonnegative().optional(),
  discount: z.string().optional(),
  badge: z.string().optional(),
  badges: z.string().optional(),
  isFeatured: z
    .preprocess(
      (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : undefined),
      z.boolean().optional()
    ),
  inStock: z
    .preprocess(
      (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : undefined),
      z.boolean().optional()
    ),
  sort: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(1000).default(20),
  minRating: z.coerce.number().min(0).max(5).optional(),
  hasOffer: z
    .preprocess(
      (v) => (v === "true" || v === true ? true : v === "false" || v === false ? false : undefined),
      z.boolean().optional()
    ),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type GetProductsQuery = z.infer<typeof getProductsQuerySchema>;