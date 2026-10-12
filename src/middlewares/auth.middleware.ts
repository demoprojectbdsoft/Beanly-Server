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
    next();
  } catch (err) {
    next(new ApiError(401, "Invalid or expired token"));
  }
}