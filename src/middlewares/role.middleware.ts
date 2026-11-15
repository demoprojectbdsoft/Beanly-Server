import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";
import { isAdminRole, normalizeRole, hasAnyRole } from "../utils/roles";

/**
 * Allows the request only when the caller holds one of `allowedRoles`.
 *
 * The check reads the caller's approved `roles` array, not `activeRole`. A
 * customer who also runs a shop keeps both entries no matter which dashboard
 * they opened, so a vendor endpoint stays reachable while they are looking at
 * their cart, and a rider endpoint stays unreachable when they only applied.
 *
 * Admin authority keeps the legacy bypass: an admin (or the sandboxed demo
 * admin) can reach any route that explicitly names "admin", the way the store
 * team's review screens have always worked.
 */
export function requireRole(...allowedRoles: string[]) {
  const allowed = allowedRoles.map(normalizeRole);

  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    const isAllowed = hasAnyRole(user?.roles, allowed, user?.role);
    const isAdminAsking = allowed.includes("admin") && isAdminRole(user?.role);

    // A parked workspace is closed even though the role stays approved: a
    // suspension keeps the entry in `roles`, so the array alone would let a
    // suspended seller keep calling their endpoints from any dashboard. The
    // check names the roles this route guards, which makes it the same rule
    // for a rider and a vendor.
    const suspended = user?.suspendedRoles || [];
    const parked = allowed.filter((role) => suspended.includes(role));
    if (parked.length > 0 && !isAdminAsking) {
      return next(new ApiError(403, `Your ${parked[0]} access is suspended. Contact support.`));
    }

    if (!isAllowed && !isAdminAsking) {
      return next(new ApiError(403, "You don't have permission to perform this action"));
    }

    next();
  };
}
