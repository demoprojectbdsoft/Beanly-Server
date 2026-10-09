import { z } from "zod";

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  image: z.string().optional(),
  role: z.enum(["admin", "customer"]).optional(),
  plan: z.string().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  member: z.enum(["silver", "gold", "platinum", "diamond"]).optional(),
  points: z.number().int().nonnegative().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
  department: z.string().optional(),
});

export const getUsersQuerySchema = z.object({
  role: z.string().optional(),
  status: z.string().optional(),
  member: z.enum(["silver", "gold", "platinum", "diamond"]).optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(1000).default(20),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type GetUsersQuery = z.infer<typeof getUsersQuerySchema>;