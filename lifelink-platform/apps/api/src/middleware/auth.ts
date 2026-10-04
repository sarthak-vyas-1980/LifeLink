import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { getRuntimeConfig } from "../config";
import type { UserRole } from "@lifelink/shared";

export interface AuthContext {
  userId: string;
  role: UserRole;
  institutionId?: string;
}

const revokedTokens = new Map<string, number>();

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

function readBearerToken(request: Request) {
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }

  return header.slice("Bearer ".length).trim();
}

function verifyToken(token: string): AuthContext {
  const revokedUntil = revokedTokens.get(token);
  if (revokedUntil) {
    if (revokedUntil > Date.now()) {
      throw new Error("Authentication token has been revoked.");
    }
    revokedTokens.delete(token);
  }

  const payload = jwt.verify(token, getRuntimeConfig().jwtSecret);
  if (typeof payload === "string") {
    throw new Error("Invalid authentication token.");
  }

  const claims = payload as JwtPayload & Partial<AuthContext>;
  if (!claims.sub || !claims.role) {
    throw new Error("Invalid authentication claims.");
  }

  return {
    userId: claims.sub,
    role: claims.role as UserRole,
    institutionId: claims.institutionId,
  };
}

// Validate Socket.IO handshakes with the same JWT and revocation rules as HTTP.
export function authenticateSocketToken(token: string): AuthContext {
  return verifyToken(token);
}

// Resolve the authenticated actor from the incoming request/session.
export function authenticateRequest(): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = readBearerToken(request);
    if (!token) {
      response
        .status(401)
        .json({
          code: "AUTH_REQUIRED",
          message: "Authentication required.",
          traceId: request.traceId,
        });
      return;
    }

    try {
      request.auth = verifyToken(token);
      next();
    } catch {
      response.status(401).json({
        code: "AUTH_INVALID",
        message: "Invalid authentication token.",
        traceId: request.traceId,
      });
    }
  };
}

// Invalidate the current client session; production clusters should back this map with Redis.
export function invalidateAuthenticatedSession(token: string) {
  const payload = jwt.decode(token);
  const expiresAt =
    typeof payload === "object" && payload?.exp
      ? payload.exp * 1000
      : Date.now() + 3_600_000;
  revokedTokens.set(token, expiresAt);
  return { revoked: true };
}
