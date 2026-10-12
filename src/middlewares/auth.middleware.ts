import { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/apiError";
import { ENV } from "../config/env";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";

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
    return next();
  } catch {
    // If not a JWT, check Better-Auth session in DB
    const db = (await import("mongoose")).default.connection.db;
    const session = await db?.collection("session").findOne({ token });
    if (session) {
      const user = await db?.collection("user").findOne({ _id: session.userId });
      if (user) {
        req.user = { id: String(user._id), email: user.email, role: user.role };
        return next();
      }
    }
    next(new ApiError(401, "Invalid or expired token"));
  }
}