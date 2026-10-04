import { RequestStatus, RequestType } from "@prisma/client";
import { Router, type Request, type Response } from "express";
import {
  createRequest,
  findRequestById,
  saveRequestTransition,
} from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  bloodRequestSchema,
  validateRequest,
  validateWorkflowTransition,
} from "../../middleware/validation";
import { serializeRequestForActor } from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";
import { findBloodMatches, reopenMatchingCycle } from "./matching.service";

const requestRoles = [
  "HOSPITAL_USER",
  "DONOR_RECIPIENT",
  "BLOOD_BANK_USER",
  "ADMINISTRATOR",
] as const;

// Define the blood-request lifecycle endpoints.
export function registerBloodRequestRoutes(router = Router()) {
  router.post(
    "/",
    authenticateRequest(),
    authorizeAction(...requestRoles),
    validateRequest(bloodRequestSchema),
    createBloodRequest,
  );
  router.get("/:requestId", authenticateRequest(), getBloodRequest);
  router.post(
    "/:requestId/match",
    authenticateRequest(),
    authorizeAction(...requestRoles),
    startBloodMatching,
  );
  router.patch(
    "/:requestId/status",
    authenticateRequest(),
    authorizeAction(...requestRoles),
    validateWorkflowTransition(),
    transitionBloodRequest,
  );
  return router;
}

// Search live inventory and return candidates, never a fulfilment guarantee.
export async function startBloodMatching(request: Request, response: Response) {
  const requestId = String(request.params.requestId);
  const bloodRequest = await findRequestById(requestId);
  if (!bloodRequest || bloodRequest.requestType !== RequestType.BLOOD) {
    response
      .status(404)
      .json({ code: "REQUEST_NOT_FOUND", message: "Blood request not found." });
    return;
  }

  const matchableStatuses = [
    RequestStatus.UNDER_REVIEW,
    RequestStatus.REOPENED,
    RequestStatus.SEARCHING_MATCHING,
  ];
  if (!matchableStatuses.includes(bloodRequest.status)) {
    response.status(409).json({
      code: "REQUEST_NOT_MATCHABLE",
      message: "The request is not in a matchable workflow state.",
    });
    return;
  }

  if (
    bloodRequest.status === RequestStatus.UNDER_REVIEW ||
    bloodRequest.status === RequestStatus.REOPENED
  ) {
    await saveRequestTransition(
      requestId,
      bloodRequest.status,
      RequestStatus.SEARCHING_MATCHING,
      request.auth?.userId,
    );
  }

  const result = await findBloodMatches({
    requestId,
    bloodGroup: bloodRequest.bloodGroup!,
    component: bloodRequest.component!,
    quantity: bloodRequest.quantity,
    latitude: bloodRequest.latitude ?? undefined,
    longitude: bloodRequest.longitude ?? undefined,
    radiusKm: bloodRequest.radiusKm ?? undefined,
  });

  if (result.status === "NO_MATCH") {
    await reopenMatchingCycle(requestId, request.auth?.userId);
    response.status(200).json(result);
    return;
  }

  await saveRequestTransition(
    requestId,
    RequestStatus.SEARCHING_MATCHING,
    RequestStatus.INSTITUTIONS_NOTIFIED,
    request.auth?.userId,
  );
  response.status(200).json(result);
}

// Create a request in the initial review state.
export async function createBloodRequest(request: Request, response: Response) {
  const created = await createRequest({
    requestType: RequestType.BLOOD,
    bloodGroup: request.body.bloodGroup,
    component: request.body.component,
    quantity: request.body.quantity,
    priority: request.body.priority,
    location: request.body.location,
    latitude: request.body.latitude,
    longitude: request.body.longitude,
    radiusKm: request.body.radiusKm,
    contactNumber: request.body.contactNumber,
    createdBy: { connect: { id: request.auth?.userId } },
  });

  await recordAuditEvent({
    actorId: request.auth?.userId,
    action: "REQUEST_CREATED",
    entityType: "Request",
    entityId: created.id,
    metadata: { requestType: created.requestType, priority: created.priority },
  });
  response.status(201).json(serializeRequestForActor(created, request.auth));
}

// Return only request fields allowed for the current actor.
export async function getBloodRequest(request: Request, response: Response) {
  const record = await findRequestById(String(request.params.requestId));
  if (!record) {
    response
      .status(404)
      .json({ code: "REQUEST_NOT_FOUND", message: "Request not found." });
    return;
  }

  response.json(serializeRequestForActor(record, request.auth));
}

// Apply a validated state transition and write its audit record transactionally.
export async function transitionBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await saveRequestTransition(
    String(request.params.requestId),
    request.body.from as RequestStatus,
    request.body.to as RequestStatus,
    request.auth?.userId,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}
