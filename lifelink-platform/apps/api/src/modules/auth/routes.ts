import { Router, type Request, type RequestHandler, type Response } from "express";
import { invalidateAuthenticatedSession } from "../../middleware/auth";
import {
  validateRequest,
  loginSchema,
  registrationSchema,
} from "../../middleware/validation";
import { loginUser, registerUser } from "./service";

function safeUser<T extends { passwordHash: string }>(
  user: T,
): Omit<T, "passwordHash"> {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

// Define registration, login, and logout endpoints with validation at the boundary.
export function registerAuthRoutes(router = Router()) {
  router.post(
    "/register",
    validateRequest(registrationSchema),
    asyncRoute(handleRegistration),
  );
  router.post("/login", validateRequest(loginSchema), asyncRoute(handleLogin));
  router.post("/logout", handleLogout);
  return router;
}

// Handle registration without returning credential material.
export async function handleRegistration(request: Request, response: Response) {
  const result = await registerUser(request.body);
  response
    .status(201)
    .json({ user: { ...safeUser(result.user), role: result.accessRole, principalType: result.principalType, ...(result.principalType === "USER" ? { accountRole: result.user.role } : { capabilities: result.capabilities }) }, token: result.token });
}

// Handle login and return the authorized dashboard context.
export async function handleLogin(request: Request, response: Response) {
  const result = await loginUser(
    request.body.email,
    request.body.phone,
    request.body.password,
    request.body.accountType,
  );
  response.json({ user: { ...safeUser(result.user), role: result.accessRole, principalType: result.principalType, ...(result.principalType === "USER" ? { accountRole: result.user.role } : { capabilities: result.capabilities }) }, token: result.token });
}

// Revoke the presented session token at the session boundary.
export function handleLogout(request: Request, response: Response) {
  const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  response.json(
    token ? invalidateAuthenticatedSession(token) : { revoked: true },
  );
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
