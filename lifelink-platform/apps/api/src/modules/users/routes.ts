import { Router, type Request, type RequestHandler, type Response } from "express";
import { findUserById, saveUser } from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  profileUpdateSchema,
  validateRequest,
  validateUuidParams,
} from "../../middleware/validation";
import { serializeDonorForActor } from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";

// Define profile and account-management endpoints for authenticated users.
export function registerUserRoutes(router = Router()) {
  router.get("/me", authenticateRequest(), asyncRoute(getUserProfile));
  router.get(
    "/:userId",
    authenticateRequest(),
    validateUuidParams("userId"),
    asyncRoute(getUserProfile),
  );
  router.patch(
    "/me",
    authenticateRequest(),
    authorizeAction(),
    validateRequest(profileUpdateSchema),
    asyncRoute(updateUserProfile),
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

  const {
    id,
    name,
    email,
    phone,
    role,
    status,
    institutionId,
    createdAt,
    updatedAt,
    institution,
    hospitalProfile,
    donorProfile,
  } = user;
  response.json({
    id,
    name,
    email,
    phone,
    role,
    status,
    institutionId,
    createdAt,
    updatedAt,
    institution: institution
      ? {
          id: institution.id,
          name: institution.name,
          type: institution.type,
          status: institution.status,
          address: institution.address,
          latitude: institution.latitude,
          longitude: institution.longitude,
        }
      : null,
    hospitalProfile: hospitalProfile
      ? {
          department: hospitalProfile.department,
          licenseNumber: hospitalProfile.licenseNumber,
        }
      : null,
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
  response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    institutionId: user.institutionId,
    updatedAt: user.updatedAt,
  });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
