import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";
import { ENV } from "../config/env";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";

import { demoStore, isDemoAdmin } from "../modules/demo/demo.context";

const JWKS = createRemoteJWKSet(new URL(`${ENV.NEXT_PUBLIC_CLIENT_URL}/api/auth/jwks`));

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        role?: string;
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.split(" ")[1] || (req.query.token as string);

  if (!token) {
    return next(new ApiError(401, "No token provided"));
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: ENV.NEXT_PUBLIC_CLIENT_URL,
    });

    req.user = {
      id: payload.sub as string,
      email: payload.email as string | undefined,
      role: payload.role as string | undefined,
    };

    if (isDemoAdmin(req.user.email, req.user.role)) {
      return demoStore.run({ demo: true }, () => next());
    }
    return next();
  } catch {
    // If not a JWT, check Better-Auth session in DB
    const mongoose = (await import("mongoose")).default;
    const db = mongoose.connection.db;
    const session = await db?.collection("session").findOne({ token });
    if (session) {
      const rawUserId = session.userId;
      const objectId = mongoose.Types.ObjectId.isValid(String(rawUserId))
        ? new mongoose.Types.ObjectId(String(rawUserId))
        : rawUserId;

      const user = await db?.collection("user").findOne({
        $or: [{ _id: rawUserId }, { _id: objectId }],
      });

      if (user) {
        req.user = { id: String(user._id), email: user.email, role: user.role };
        if (isDemoAdmin(req.user.email, req.user.role)) {
          return demoStore.run({ demo: true }, () => next());
        }
        return next();
      }
    }
    next(new ApiError(401, "Invalid or expired token"));
  }
}