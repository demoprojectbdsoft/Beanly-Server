import { z } from "zod";

export const createReviewSchema = z.object({
  productId: z.string().min(1, "Product ID is required"),
  userId: z.string().min(1, "User ID is required"),
  rating: z.number().int().min(1, "Rating must be at least 1").max(5, "Rating cannot exceed 5"),
  comment: z.string().min(1, "Comment is required"),
  images: z.array(z.string().url()).max(5, "Maximum 5 images per review").optional().default([]),
});

export const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().min(1).optional(),
  images: z.array(z.string().url()).max(5).optional(),
});

export const getReviewsQuerySchema = z.object({
  productId: z.string().optional(),
  userId: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  search: z.string().optional(),
  sort: z.enum(["newest", "oldest", "rating_high", "rating_low"]).optional().default("newest"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;
export type GetReviewsQuery = z.infer<typeof getReviewsQuerySchema>;