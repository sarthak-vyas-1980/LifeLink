import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import { getRuntimeConfig } from "../config";
import { ACCESS_ROLES, type AccessRole } from "@lifelink/shared";
import { database } from "@lifelink/database";

export interface AuthContext {
  userId?: string;
  principalType: "USER" | "INSTITUTION";
  role: AccessRole;
  institutionId?: string;
  capabilities?: { blood: boolean; organ: boolean };
  tokenIssuedAt?: number;
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
  if (
    typeof claims.sub !== "string" ||
    !claims.sub ||
    !claims.role ||
    !ACCESS_ROLES.includes(claims.role as AccessRole) ||
    (claims.principalType !== "USER" && claims.principalType !== "INSTITUTION")
  ) {
    throw new Error("Invalid authentication claims.");
  }

  const institutionRole = ["HOSPITAL_USER", "BLOOD_BANK_USER", "ORGAN_CENTRE_USER"].includes(claims.role);
  if ((claims.principalType === "INSTITUTION") !== institutionRole) {
    throw new Error("Invalid authentication claims.");
  }

  return {
    userId: claims.principalType === "USER" ? claims.sub : undefined,
    principalType: claims.principalType,
    role: claims.role as AccessRole,
    institutionId: claims.principalType === "INSTITUTION" ? claims.sub : claims.institutionId,
    capabilities: claims.capabilities,
    tokenIssuedAt: claims.iat,
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
      const actor = verifyToken(token);
      void (async () => {
        let active: boolean;
        let credentialsChangedAt: Date | null | undefined;

        if (actor.principalType === "INSTITUTION") {
          const institution = await database.institution.findFirst({
            where: { id: actor.institutionId, deletedAt: null, status: "ACTIVE" },
            select: { id: true, account: { select: { credentialsChangedAt: true } } },
          });
          active = Boolean(institution);
          credentialsChangedAt = institution?.account?.credentialsChangedAt;
        } else {
          const user = await database.user.findFirst({
            where: { id: actor.userId, deletedAt: null, status: "ACTIVE" },
            select: { id: true, credentialsChangedAt: true },
          });
          active = Boolean(user);
          credentialsChangedAt = user?.credentialsChangedAt;
        }

        const sessionPredatesPasswordChange = Boolean(credentialsChangedAt && actor.tokenIssuedAt && actor.tokenIssuedAt < Math.floor(credentialsChangedAt.getTime() / 1000));
        if (!active || sessionPredatesPasswordChange) {
          response.status(401).json({ code: "AUTH_INVALID", message: "This account is inactive or has been closed.", traceId: request.traceId });
          return;
        }
        request.auth = actor;
        next();
      })().catch(next);
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
