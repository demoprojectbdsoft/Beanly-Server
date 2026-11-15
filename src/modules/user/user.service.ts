import { Types } from "mongoose";
import { User } from "./user.model";
import { ApiError } from "../../utils/apiError";
import {
  GetUsersQuery,
  RevokeRoleInput,
  SetActiveRoleInput,
  SetRoleSuspensionInput,
  UpdateUserInput,
} from "./user.validator";
import { getMembershipTier } from "../order/order.service";
import { recordActivity, notifyUser } from "../activity/activity.service";
import { normalizeRole, normalizeRoles } from "../../utils/roles";

export async function getUsers(query: GetUsersQuery) {
  const { role, status, search, page, limit } = query;

  const filter: Record<string, any> = {};
  // Admin filter by role uses the array so a rider-who-shops still surfaces
  // under "rider". `$in` on a String[] field matches any array element.
  if (role) filter.roles = { $in: [role] };
  if (status) filter.status = status;
  // Optional search across name and email fields (case-insensitive)
  if (search?.trim()) {
    const q = search.trim();
    const searchRegex = new RegExp(q, "i");
    const searchOr: Record<string, any>[] = [{ name: searchRegex }, { email: searchRegex }];
    // A notification links to the exact account by its id. Without this the
    // email fallback is a substring match, so one admin address can pull up
    // every address that merely contains it.
    if (/^[0-9a-fA-F]{24}$/.test(q)) searchOr.push({ _id: q });
    filter.$or = searchOr;
  }

  const skip = (page - 1) * limit;
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getUserById(id: string) {
  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

/**
 * Applies an admin (or self-service) update.
 *
 * `role` is treated as the alias of `activeRole` and both are always kept in
 * sync here. Any write to `roles` from an admin is filtered against the known
 * list so nothing invalid can slip in through the array. A self-service call
 * never carries those keys — the controller strips them first.
 */
export async function updateUser(id: string, data: UpdateUserInput) {
  if (data.points !== undefined && data.member === undefined) {
    data.member = getMembershipTier(data.points);
  }

  const patch: Record<string, unknown> = { ...data };
  const roles = normalizeRoles(patch.roles);
  if (roles.length > 0) patch.roles = roles;
  // `role` and `activeRole` are two views of the same value. Whichever the
  // caller wrote, mirror it into the other so the JWT, the session and the
  // dashboard switcher all read the same truth.
  if (patch.activeRole) patch.role = patch.activeRole;
  else if (patch.role) patch.activeRole = patch.role;

  const user = await User.findByIdAndUpdate(id, patch, { new: true });
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

export async function deleteUser(id: string) {
  const user = await User.findByIdAndDelete(id);
  if (!user) throw new ApiError(404, "User not found");

  // Written from the copy that was just removed, so the feed can still name
  // who it was now that the account is gone.
  await recordActivity({
    type: "user_deleted",
    title: `${user.name || "A user"} was deleted`,
    detail: user.email || "",
  });
}

// ─── Multi-role helpers ───────────────────────────────────────────────────────

/**
 * The caller's approved roles and the dashboard they are looking at.
 *
 * Read from the database every time so the switcher cannot be spoofed by an
 * out-of-date session payload. A row the migration has not touched yet
 * reports as `[role]` so legacy accounts keep working normally.
 */
export async function getMyRoles(userId: string) {
  const user: any = await User.findById(userId)
    .select("roles activeRole role status vendorStatus riderStatus roleSuspensions")
    .lean();
  if (!user) throw new ApiError(404, "User not found");

  const pool = normalizeRoles(user.roles);
  const resolved = pool.length > 0 ? pool : normalizeRoles(user.role || "customer");
  const suspended = suspendedRoleNames(user);
  const active = normalizeRoles(user.activeRole || user.role)[0] || resolved[0] || "customer";
  // A parked dashboard is not a place the switcher may land, so the fallback
  // skips it the same way the API guard does.
  const usable = resolved.includes(active) && !suspended.includes(active)
    ? active
    : resolved.find((role) => role === "customer" || !suspended.includes(role)) || resolved[0];
  return {
    roles: resolved,
    suspendedRoles: suspended,
    activeRole: usable,
    vendorStatus: user.vendorStatus || "none",
    riderStatus: user.riderStatus || "none",
  };
}

/**
 * Points the account at a different dashboard.
 *
 * The requested role has to be inside the approved list — the array is the
 * only source of truth here, and the client's `activeRole` claim is treated as
 * a hint. Both `activeRole` and the legacy `role` string are written together
 * so the JWT's next refresh keeps reading the same thing.
 */
export async function setActiveRole(userId: string, input: SetActiveRoleInput) {
  const user: any = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  const approved = normalizeRoles(user.roles);
  const pool = approved.length > 0 ? approved : normalizeRoles(user.role || "customer");
  const wanted = String(input.role || "").toLowerCase();
  if (!pool.includes(wanted)) {
    throw new ApiError(403, "This account has not been approved for that dashboard");
  }
  // A parked dashboard cannot be entered by switching, even though the role
  // is still approved — only an admin lifting the suspension reopens it.
  if (wanted !== "customer" && suspendedRoleNames(user).includes(wanted)) {
    throw new ApiError(403, "That dashboard is suspended for this account");
  }

  user.activeRole = wanted;
  // Mirror the alias so every reader — the session hook, the JWT, the legacy
  // middleware — sees the same value.
  user.role = wanted;
  await user.save();

  return {
    roles: pool,
    activeRole: wanted,
  };
}

/**
 * Removes one approved role and, when necessary, moves the account back to
 * being a plain customer.
 *
 * Called from the admin desk when a seller's shop is closed or a rider's
 * licence lapses. The customer entry is never revoked: even if it is passed
 * in, the service silently adds it back so the account can still sign in.
 */
export async function revokeRole(userId: string, input: RevokeRoleInput, adminId?: string) {
  if (!Types.ObjectId.isValid(userId)) throw new ApiError(404, "User not found");

  const user: any = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  const target = String(input.role || "").toLowerCase();
  const current = normalizeRoles(user.roles);
  const pool = current.length > 0 ? current : normalizeRoles(user.role || "customer");

  if (!pool.includes(target)) {
    throw new ApiError(400, `This account does not hold the ${target} role`);
  }
  if (target === "customer") {
    throw new ApiError(400, "The customer role cannot be revoked");
  }

  const remaining = pool.filter((role) => role !== target);
  // Every account keeps customer so the person can still sign in and shop.
  const nextRoles = remaining.includes("customer") ? remaining : [...remaining, "customer"];
  const active = nextRoles.includes(user.activeRole) ? user.activeRole : "customer";

  user.roles = nextRoles;
  user.activeRole = active;
  user.role = active;
  // Clear the marketplace state so the applicant can reapply if the platform
  // policy allows; keeping "approved" here would let a stale screen reopen the
  // workspace after the revoke.
  if (target === "vendor") {
    user.vendorStatus = "none";
    user.vendorApplicationId = null;
    // The store row itself is left alone; the store team closes it separately.
  }
  if (target === "rider") {
    user.riderStatus = "none";
    user.riderApplicationId = null;
  }
  // A revoked authority cannot stay parked. A suspension is stored per role,
  // so a leftover row would reopen the workspace already closed the moment an
  // admin grants the role again — a fresh grant must start unsuspended.
  const parked = Array.isArray(user.roleSuspensions) ? user.roleSuspensions : [];
  user.roleSuspensions = parked.filter((row: any) => normalizeRole(row?.role) !== target);
  await user.save();

  // Only the marketplace roles have a bell of their own. Demoting staff is an
  // authority change, not a marketplace event, so it is recorded but not
  // pushed to the account.
  if (target === "vendor" || target === "rider") {
    await notifyUser({
      userId: String(user._id),
      role: target,
      type: target === "rider" ? "rider_application" : "vendor_application",
      title: `Your ${target} access was removed`,
      detail: input.reason?.trim() || "Contact support if you think this is a mistake.",
      ref: String(adminId || ""),
    });
  }

  await recordActivity({
    type: target === "rider" ? "rider" : target === "vendor" ? "vendor" : "user",
    title: `${target} role revoked`,
    detail: `${user.email || "Account"} · by admin`,
    ref: String(user._id),
  });

  return {
    roles: nextRoles,
    activeRole: active,
    roleSuspensions: user.roleSuspensions || [],
  };
}

/** The role names parked in `roleSuspensions`, defensively normalised. */
function suspendedRoleNames(user: any): string[] {
  const rows = Array.isArray(user?.roleSuspensions) ? user.roleSuspensions : [];
  return rows
    .map((row: any) => normalizeRole(typeof row?.role === "string" ? row.role : null))
    .filter(Boolean);
}

/**
 * Writes the whole approved list the way the admin desk means it.
 *
 * The raw `POST /:id/roles` payload used to land on `updateUser` untouched, so
 * a desk could park an account on a dashboard it no longer held, leave a
 * revoked vendor's marketplace state pointing at a stale application, or hand
 * an admin entry to an account that still shopped. This keeps every invariant
 * the rest of the system already assumes:
 *
 * - an administrator holds exactly one authority and never shops, so any
 *   customer/rider/vendor entry is dropped the moment admin is granted;
 * - every non-admin account keeps `customer`, because revoking a workspace
 *   must still leave the person able to sign in and shop;
 * - `activeRole` always names a held, unsuspended dashboard — when the old one
 *   disappears the account falls back to customer, or to its first entry;
 * - removing vendor/rider authority clears the marketplace state the same way
 *   `revokeRole` does, so no stale "approved" screen can reopen a workspace.
 */
export async function adminSetRoles(userId: string, input: { roles: string[] }, adminId?: string) {
  if (!Types.ObjectId.isValid(userId)) throw new ApiError(404, "User not found");

  const user: any = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  const requested = normalizeRoles(input.roles);
  if (requested.length === 0) throw new ApiError(400, "At least one role is required");

  const isAdminPool = requested.includes("admin") || requested.includes("demoadmin");
  // An admin desk cannot demote itself into a shopper by accident: the array
  // collapses to the single admin authority, mirroring ensureDemoAdmin.
  const nextRoles = isAdminPool
    ? [requested.includes("admin") ? "admin" : "demoadmin"]
    : Array.from(new Set([...requested, "customer"]));

  const previous = normalizeRoles(user.roles);
  const removed = previous.filter((role) => !nextRoles.includes(role));

  // A parked dashboard only survives while the role it parks is still held AND
  // was already held before this write. A role that left the array and came
  // back was effectively revoked and re-granted, so its old parking must not
  // follow it in — otherwise the new grant would open already suspended.
  const parkedRows = (Array.isArray(user.roleSuspensions) ? user.roleSuspensions : []).filter(
    (row: any) => {
      const name = normalizeRole(row?.role);
      return Boolean(name) && nextRoles.includes(name) && previous.includes(name);
    }
  );
  user.roleSuspensions = parkedRows;
  const suspended = suspendedRoleNames({ roleSuspensions: parkedRows });
  let active = normalizeRole(user.activeRole);
  if (!nextRoles.includes(active) || (active !== "customer" && suspended.includes(active))) {
    active = nextRoles.includes("customer") ? "customer" : nextRoles[0];
  }

  user.roles = nextRoles;
  user.activeRole = active;
  user.role = active;
  for (const role of removed) {
    if (role === "vendor") {
      user.vendorStatus = "none";
      user.vendorApplicationId = null;
    }
    if (role === "rider") {
      user.riderStatus = "none";
      user.riderApplicationId = null;
    }
  }
  // A role that left the array and came back was effectively revoked and
  // re-granted; its old marketplace state must not resurface.
  for (const role of nextRoles.filter((r) => requested.includes(r) && previous.length > 0 && !previous.includes(r))) {
    if (role === "vendor") {
      user.vendorStatus = "none";
      user.vendorApplicationId = null;
    }
    if (role === "rider") {
      user.riderStatus = "none";
      user.riderApplicationId = null;
    }
  }
  await user.save();

  await recordActivity({
    type: "user",
    title: `Roles updated for ${user.email || user.name || "an account"}`,
    detail: `${nextRoles.join(", ")} · by admin`,
    ref: String(user._id),
  });

  return {
    roles: nextRoles,
    activeRole: active,
    roleSuspensions: user.roleSuspensions || [],
    removed,
  };
}

/**
 * Parks or releases one approved role without touching the account itself.
 *
 * `customer` has no per-role suspension — that decision is the whole-account
 * `status` field — and an administrator's authority is never parked here;
 * demoting staff is a role change, not a suspension. When the parked role is
 * the dashboard the person is standing on, the account steps back to customer
 * (or its next held role) in the same write.
 */
export async function setRoleSuspension(
  userId: string,
  input: SetRoleSuspensionInput,
  adminId?: string
) {
  if (!Types.ObjectId.isValid(userId)) throw new ApiError(404, "User not found");

  const user: any = await User.findById(userId);
  if (!user) throw new ApiError(404, "User not found");

  const target = String(input.role || "").toLowerCase();
  if (target === "customer") {
    throw new ApiError(400, "Suspending the customer role means suspending the whole account — use the account status");
  }
  if (target === "admin" || target === "demoadmin") {
    throw new ApiError(400, "Administrator access is removed by a role change, not suspended");
  }

  const pool = normalizeRoles(user.roles);
  if (!pool.includes(target)) {
    throw new ApiError(400, `This account does not hold the ${target} role`);
  }

  const rows = Array.isArray(user.roleSuspensions) ? user.roleSuspensions : [];
  const nextRows = rows.filter((row: any) => normalizeRole(row?.role) !== target);
  if (input.suspended) {
    nextRows.push({
      role: target,
      reason: input.reason?.trim() || "",
      suspendedAt: new Date(),
    });
  }
  user.roleSuspensions = nextRows;

  // The parked dashboard must not stay the active one.
  if (input.suspended && normalizeRole(user.activeRole) === target) {
    const active = pool.includes("customer") ? "customer" : pool.find((role) => role !== target) || "customer";
    user.activeRole = active;
    user.role = active;
  }
  await user.save();

  await notifyUser({
    userId: String(user._id),
    role: target === "rider" ? "rider" : "vendor",
    type: target === "rider" ? "rider_application" : "vendor_application",
    title: input.suspended ? `Your ${target} access is suspended` : `Your ${target} access is back`,
    detail: input.suspended
      ? input.reason?.trim() || "Contact support if you think this is a mistake."
      : "The dashboard is open again — nothing else about your account changed.",
    ref: String(adminId || ""),
  });

  await recordActivity({
    type: target === "rider" ? "rider" : "vendor",
    title: `${target} role ${input.suspended ? "suspended" : "released"}`,
    detail: `${user.email || "Account"} · by admin`,
    ref: String(user._id),
  });

  return {
    role: target,
    suspended: Boolean(input.suspended),
    roleSuspensions: nextRows,
    activeRole: normalizeRole(user.activeRole),
  };
}

/**
 * Promotes the shared demo account to sandboxed admin authority.
 *
 * The login screen advertises `DEMO_ADMIN_EMAIL` as an admin, but a normal
 * sign-up (or a row the migration left as a plain customer) only ever carries
 * the `customer` entry — so that account lands on the storefront and gets a
 * 403 at the admin gate. This runs at startup and gives the one advertised
 * address the `demoadmin` role.
 *
 * The array holds `demoadmin` and nothing else, on purpose: an admin never
 * shops, so the customer entry stays out and the storefront, cart and wishlist
 * remain locked to real buyers. It is idempotent and only ever touches the
 * account whose email matches, so a restart cannot demote it again and no other
 * row is affected.
 */
export async function ensureDemoAdmin(): Promise<{ promoted: boolean }> {
  const email = (process.env.DEMO_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!email) return { promoted: false };

  // Match case-insensitively without trusting the email's regex metacharacters.
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const user: any = await User.findOne({
    email: { $regex: `^${escaped}$`, $options: "i" },
  }).lean();
  if (!user) return { promoted: false };

  // Already exactly the sandboxed admin — leave it untouched.
  const current = normalizeRoles(user.roles);
  const active = normalizeRole(user.activeRole || user.role);
  if (current.length === 1 && current[0] === "demoadmin" && active === "demoadmin") {
    return { promoted: false };
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { roles: ["demoadmin"], activeRole: "demoadmin", role: "demoadmin" } }
  );
  return { promoted: true };
}

/**
 * One-off sweep that gives every existing row a `roles` array and an
 * `activeRole` mirror, and heals rows whose legacy `role` drifted out of sync
 * with the authority array.
 *
 * Runs at server start and is idempotent: only rows that are missing either
 * field — or whose legacy `role` still names an administrator the `roles`
 * array lost — are written, so a restart never re-touches an account that
 * already fits the shape.
 *
 * The administrator clause closes a real gap: an account whose `role` was set
 * to `admin` but whose `roles` stayed `["customer"]` would otherwise be left
 * alone (both fields exist), stranding the admin on the customer dashboard and
 * locking them out of the admin gate with a 403.
 */
export async function syncLegacyRoles(): Promise<{ updated: number }> {
  const cursor = User.find({
    $or: [
      { roles: { $exists: false } },
      { roles: { $size: 0 } },
      { activeRole: { $exists: false } },
      { activeRole: null },
      // A legacy `role` that still names an administrator but whose authority
      // array never gained that entry — the divergence that strands an admin.
      { role: "admin", roles: { $ne: "admin" } },
      { role: "demoadmin", roles: { $ne: "demoadmin" } },
    ],
  })
    .select("_id role roles activeRole vendorStatus riderStatus")
    .cursor();

  let updated = 0;
  for await (const user of cursor as any) {
    const legacy = normalizeRoles((user as any).role)[0] || "customer";
    const roles = normalizeRoles((user as any).roles);
    const isAdministrator = legacy === "admin" || legacy === "demoadmin";

    let nextRoles: string[];
    let active: string;

    if (isAdministrator) {
      // An admin holds a single authority and never shops, so the array
      // collapses to the admin role and any stray `customer` entry is dropped.
      nextRoles = [legacy];
      active = legacy;
    } else {
      // A legacy rider also keeps the customer entry because they still shop.
      nextRoles = roles.length > 0 ? Array.from(new Set([...roles, "customer"])) : [legacy];
      if (!nextRoles.includes("customer")) {
        nextRoles.push("customer");
      }
      active = normalizeRoles((user as any).activeRole)[0] || legacy;
    }

    await User.updateOne(
      { _id: (user as any)._id },
      {
        $set: {
          roles: nextRoles,
          activeRole: active,
          role: active,
        },
      }
    );
    updated += 1;
  }

  return { updated };
}
