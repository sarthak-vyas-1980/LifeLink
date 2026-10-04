import { RequestPriority, RequestStatus, RequestType } from "@prisma/client";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { createRequest, findRequestById } from "@lifelink/database";
import { ApiError } from "../../middleware/api-error";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  emergencyBloodRequestSchema,
  validateRequest,
  validateUuidParams,
} from "../../middleware/validation";
import {
  serializeBloodMatchingResult,
  serializeRequestForActor,
} from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";
import {
  assertMayCoordinate,
} from "../requests/blood.routes";
import { startBloodMatchingWorkflow } from "../requests/matching.service";

const emergencyRoles = [
  "HOSPITAL_USER",
  "BLOOD_BANK_USER",
  "DONOR_RECIPIENT",
  "ADMINISTRATOR",
] as const;

// Emergency blood requests enter the normal review/matching lifecycle at high priority.
export function registerEmergencyRoutes(router = Router()) {
  router.post(
    "/blood-requests",
    authenticateRequest(),
    authorizeAction(...emergencyRoles),
    validateRequest(emergencyBloodRequestSchema),
    asyncRoute(createEmergencyRequest),
  );
  router.post(
    "/blood-requests/:requestId/broadcast",
    authenticateRequest(),
    authorizeAction(...emergencyRoles),
    validateUuidParams("requestId"),
    asyncRoute(broadcastEmergencyRequest),
  );
  return router;
}

// Create an emergency request and immediately run the established blood matcher.
export async function createEmergencyRequest(request: Request, response: Response) {
  const record = await createRequest({
    requestType: RequestType.BLOOD,
    bloodGroup: request.body.bloodGroup,
    component: request.body.component,
    quantity: request.body.quantity,
    priority: RequestPriority.EMERGENCY,
    location: request.body.location,
    latitude: request.body.latitude,
    longitude: request.body.longitude,
    radiusKm: request.body.radiusKm,
    contactNumber: request.body.contactNumber,
    status: RequestStatus.UNDER_REVIEW,
    createdBy: { connect: { id: request.auth!.userId } },
  });

  await recordAuditEvent({
    actorId: request.auth!.userId,
    action: "EMERGENCY_REQUEST_CREATED",
    entityType: "Request",
    entityId: record.id,
    metadata: { priority: record.priority },
  });

  const radiusKm = request.body?.radiusKm;
  if (radiusKm !== undefined && typeof radiusKm !== "number") {
    throw new ApiError(400, "INVALID_MATCH_CRITERIA", "Search radius must be a number.");
  }
  const outcome = await startBloodMatchingWorkflow(record.id, request.auth!.userId, radiusKm);
  response.status(201).json({
    request: serializeRequestForActor(outcome.request!, request.auth),
    matching: serializeBloodMatchingResult(outcome.matching),
    coordinationOnly: true,
  });
}

// Retry matching only for an emergency request the actor is allowed to coordinate.
export async function broadcastEmergencyRequest(request: Request, response: Response) {
  const record = await findRequestById(String(request.params.requestId));
  if (!record || record.requestType !== RequestType.BLOOD || record.priority !== RequestPriority.EMERGENCY) {
    throw new ApiError(404, "REQUEST_NOT_FOUND", "Emergency request not found.");
  }
  assertMayCoordinate(record, request.auth!);
  const radiusKm = request.body?.radiusKm;
  if (radiusKm !== undefined && typeof radiusKm !== "number") {
    throw new ApiError(400, "INVALID_MATCH_CRITERIA", "Search radius must be a number.");
  }
  const outcome = await startBloodMatchingWorkflow(record.id, request.auth!.userId, radiusKm);
  response.json({
    request: serializeRequestForActor(outcome.request!, request.auth),
    matching: serializeBloodMatchingResult(outcome.matching),
    coordinationOnly: true,
  });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
