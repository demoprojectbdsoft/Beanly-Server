import { z } from "zod";

/**
 * The fields an admin writes on a plan.
 *
 * The enums mirror the limit vocabulary the dashboards render: a value outside
 * them is a 400, never a stored typo the screens would then have to guess
 * about. The same shape is reused by the create call, where the name is the
 * only required field — everything else falls back to a sensible zero.
 */
const planFields = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  monthlyPrice: z.coerce.number().min(0).optional(),
  yearlyPrice: z.coerce.number().min(0).optional(),
  maxProducts: z.coerce.number().int().min(0).optional(),
  featuredProducts: z.coerce.number().int().min(0).optional(),
  featuredDurationDays: z.coerce.number().int().min(0).optional(),
  activeCoupons: z.coerce.number().int().min(0).optional(),
  analytics: z.enum(["basic", "detailed", "advanced"]).optional(),
  salesReports: z.enum(["basic", "advanced"]).optional(),
  exports: z.enum(["limited", "full"]).optional(),
  storeCustomization: z.enum(["basic", "enhanced", "full"]).optional(),
  promotionalCampaigns: z.enum(["none", "limited", "priority"]).optional(),
  storeVisibility: z.enum(["standard", "enhanced", "priority"]).optional(),
  support: z.enum(["standard", "priority"]).optional(),
  highlights: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  isActive: z.boolean().optional(),
  commissionPercent: z.coerce.number().min(0).max(100).optional(),
  gracePeriodDays: z.coerce.number().int().min(0).max(90).optional(),
  billingCycles: z.array(z.enum(["monthly", "yearly"])).min(1).optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

/** An admin's edit to one plan; every field is optional. */
export const updatePlanSchema = planFields;

/** A new plan. Only the name is needed; the rest starts at zero. */
export const createPlanSchema = planFields.extend({
  name: z.string().trim().min(2).max(60),
});

export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
