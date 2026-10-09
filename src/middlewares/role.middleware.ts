import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";

export function requireRole(...allowedRoles: string[]) {
  const normalizedAllowed = allowedRoles.map((r) => r.toLowerCase());
  return (req: Request, res: Response, next: NextFunction) => {
    const userRole = (req.user?.role || "").toLowerCase();
    if (!userRole || !normalizedAllowed.includes(userRole)) {
      return next(new ApiError(403, "You don't have permission to perform this action"));
    }
    next();
  };
}