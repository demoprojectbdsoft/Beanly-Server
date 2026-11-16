import { z } from "zod";
import { warehouseInputSchema } from "../../utils/warehouse";
import { USER_ROLES } from "./user.model";

/**
 * Roles the caller may hand to the update endpoint.
 *
 * `demoadmin` is deliberately excluded from the writable set: the sandboxed
 * admin is created by seeding, never by an admin typing the string into a
 * form. The list still validates against `USER_ROLES` so adding a new role
 * later will not silently drop out of the check.
 */
const ASSIGNABLE_ROLES = USER_ROLES.filter((role) => role !== "demoadmin") as unknown as [
  string,
  ...string[]
];

export const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  image: z.string().optional(),
  role: z.enum(ASSIGNABLE_ROLES).optional(),
  /**
   * The full approved list. Only written by an admin — and only by the review
   * flow or the revoke desk, never by a customer's own PATCH.
   */
  roles: z.array(z.enum(ASSIGNABLE_ROLES)).optional(),
  activeRole: z.enum(ASSIGNABLE_ROLES).optional(),
  plan: z.string().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  member: z.enum(["silver", "gold", "platinum", "diamond"]).optional(),
  points: z.number().int().nonnegative().optional(),
  phone: z.string().optional(),
  bio: z.string().optional(),
  department: z.string().optional(),
  /**
   * Where the store team hands parcels over, for an order whose seller has no
   * warehouse of their own. Admin-only: it is an address riders are sent to.
   */
  warehouse: warehouseInputSchema.optional(),
  /** Rider-only details, written from the rider's own profile page. */
  vehicleType: z.string().optional(),
  vehicleNumber: z.string().optional(),
  licenseNumber: z.string().optional(),
  availability: z.enum(["online", "offline"]).optional(),
});

/**
 * Fields that decide what an account can do. Only an admin may write these —
 * otherwise any signed-in user could promote themselves.
 */
export const ADMIN_ONLY_USER_FIELDS = [
  "role",
  "roles",
  "activeRole",
  "plan",
  "status",
  "member",
  "points",
  "department",
  "warehouse",
] as const;

/**
 * The only fields a customer may change on their own profile. The rider fields
 * are here too: a rider signs into the same account, and going online or
 * filling in a plate number must not need an admin.
 */
export const selfUpdateUserSchema = updateUserSchema.pick({
  name: true,
  image: true,
  phone: true,
  bio: true,
  vehicleType: true,
  vehicleNumber: true,
  licenseNumber: true,
  availability: true,
});

/**
 * Body for `PATCH /api/users/me/active-role`.
 *
 * The server validates the choice against the account's approved roles, so a
 * client cannot claim a role it does not hold by naming it here.
 */
export const setActiveRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
});

/**
 * Body for the admin revoke desk. `role` names which approved entry to remove;
 * the service refuses to strip a user's last role and quietly falls back to
 * `customer` if that was the one held.
 */
export const revokeRoleSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  reason: z.string().trim().max(500).optional().default(""),
});

/**
 * Body for the admin per-role suspension desk. Unlike a revoke, a suspension
 * keeps the entry approved — it only parks the dashboard until an admin lifts
 * it — so the account can be caught again without a fresh application.
 */
export const setRoleSuspensionSchema = z.object({
  role: z.enum(ASSIGNABLE_ROLES),
  suspended: z.boolean(),
  reason: z.string().trim().max(500).optional().default(""),
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
export type SelfUpdateUserInput = z.infer<typeof selfUpdateUserSchema>;
export type GetUsersQuery = z.infer<typeof getUsersQuerySchema>;
export type SetActiveRoleInput = z.infer<typeof setActiveRoleSchema>;
export type RevokeRoleInput = z.infer<typeof revokeRoleSchema>;
export type SetRoleSuspensionInput = z.infer<typeof setRoleSuspensionSchema>;
