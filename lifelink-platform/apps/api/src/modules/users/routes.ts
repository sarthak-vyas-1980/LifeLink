import { Router, type Request, type Response } from "express";
import { findUserById, saveUser } from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  profileUpdateSchema,
  validateRequest,
} from "../../middleware/validation";
import { serializeDonorForActor } from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";

// Define profile and account-management endpoints for authenticated users.
export function registerUserRoutes(router = Router()) {
  router.get("/me", authenticateRequest(), getUserProfile);
  router.get("/:userId", authenticateRequest(), getUserProfile);
  router.patch(
    "/me",
    authenticateRequest(),
    authorizeAction(),
    validateRequest(profileUpdateSchema),
    updateUserProfile,
  );
  return router;
}

// Read a profile only for its owner or an administrator.
export async function getUserProfile(request: Request, response: Response) {
  const requestedId = request.params.userId
    ? String(request.params.userId)
    : request.auth?.userId;
  if (
    !requestedId ||
    (requestedId !== request.auth?.userId &&
      request.auth?.role !== "ADMINISTRATOR")
  ) {
    response
      .status(403)
      .json({ code: "FORBIDDEN", message: "Profile access is restricted." });
    return;
  }

  const user = await findUserById(requestedId);
  if (!user) {
    response
      .status(404)
      .json({ code: "USER_NOT_FOUND", message: "User not found." });
    return;
  }

  const { passwordHash: _passwordHash, donorProfile, ...publicUser } = user;
  response.json({
    ...publicUser,
    donorProfile: donorProfile
      ? serializeDonorForActor(donorProfile, request.auth)
      : null,
  });
}

// Update only permitted self-service profile fields and audit the change.
export async function updateUserProfile(request: Request, response: Response) {
  const userId = request.auth?.userId;
  if (!userId) {
    response
      .status(401)
      .json({ code: "AUTH_REQUIRED", message: "Authentication required." });
    return;
  }

  const user = await saveUser(userId, request.body);
  await recordAuditEvent({
    actorId: userId,
    action: "USER_PROFILE_UPDATED",
    entityType: "User",
    entityId: userId,
    metadata: { fields: Object.keys(request.body) },
  });
  const { passwordHash: _passwordHash, ...publicUser } = user;
  response.json(publicUser);
}
