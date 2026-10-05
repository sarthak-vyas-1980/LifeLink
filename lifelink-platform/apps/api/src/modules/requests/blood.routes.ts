import { RequestType } from "@prisma/client";
import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  createRequest,
  findRequestById,
  searchRequests,
} from "@lifelink/database";
import { authenticateRequest, type AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { authorizeAction } from "../../middleware/rbac";
import {
  bloodRequestSchema,
  bloodOfferEvaluationSchema,
  bloodOfferResponseSchema,
  validateRequest,
  validateUuidParams,
} from "../../middleware/validation";
import {
  serializeBloodMatchingResult,
  serializeRequestForActor,
} from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";
import { startBloodMatchingWorkflow } from "./matching.service";
import {
  cancelBloodRequest as cancelBloodRequestWorkflow,
  dispatchBloodRequest as dispatchBloodRequestWorkflow,
  evaluateBloodOffer,
  expireBloodReservations,
  receiveBloodRequest as receiveBloodRequestWorkflow,
  reopenBloodRequest as reopenBloodRequestWorkflow,
  respondToBloodOffer,
  reviewBloodRequest as reviewBloodRequestWorkflow,
} from "./blood-workflow.service";

const requestRoles = [
  "HOSPITAL_USER",
  "USER",
  "BLOOD_BANK_USER",
  "ADMINISTRATOR",
] as const;

// Define the blood-request lifecycle endpoints.
export function registerBloodRequestRoutes(router = Router()) {
  startReservationExpiryWorker();
  router.post(
    "/",
    authenticateRequest(),
    authorizeAction(...requestRoles),
    validateRequest(bloodRequestSchema),
    asyncRoute(createBloodRequest),
  );
  router.get(
    "/:requestId",
    authenticateRequest(),
    validateUuidParams("requestId"),
    asyncRoute(getBloodRequest),
  );
  router.post(
    "/:requestId/match",
    authenticateRequest(),
    authorizeAction(...requestRoles),
    validateUuidParams("requestId"),
    asyncRoute(startBloodMatching),
  );
  router.get("/", authenticateRequest(), authorizeAction(...requestRoles), asyncRoute(listBloodRequests));
  router.get("/:requestId/offers", authenticateRequest(), validateUuidParams("requestId"), asyncRoute(listBloodOffers));
  router.post(
    "/:requestId/review",
    authenticateRequest(),
    authorizeAction("ADMINISTRATOR"),
    validateUuidParams("requestId"),
    asyncRoute(reviewBloodRequest),
  );
  router.post(
    "/:requestId/offers/:matchId/respond",
    authenticateRequest(),
    authorizeAction("BLOOD_BANK_USER", "HOSPITAL_USER", "ADMINISTRATOR"),
    validateUuidParams("requestId", "matchId"),
    validateRequest(bloodOfferResponseSchema),
    asyncRoute(respondToBloodOfferRoute),
  );
  router.post(
    "/:requestId/offers/:matchId/evaluate",
    authenticateRequest(),
    authorizeAction("HOSPITAL_USER", "USER", "ADMINISTRATOR"),
    validateUuidParams("requestId", "matchId"),
    validateRequest(bloodOfferEvaluationSchema),
    asyncRoute(evaluateBloodOfferRoute),
  );
  router.post(
    "/:requestId/reopen",
    authenticateRequest(),
    authorizeAction("HOSPITAL_USER", "USER", "ADMINISTRATOR"),
    validateUuidParams("requestId"),
    asyncRoute(reopenBloodRequest),
  );
  router.post(
    "/:requestId/cancel",
    authenticateRequest(),
    authorizeAction("HOSPITAL_USER", "USER", "ADMINISTRATOR"),
    validateUuidParams("requestId"),
    asyncRoute(cancelBloodRequest),
  );
  router.post(
    "/:requestId/dispatch",
    authenticateRequest(),
    authorizeAction("BLOOD_BANK_USER", "HOSPITAL_USER", "ADMINISTRATOR"),
    validateUuidParams("requestId"),
    asyncRoute(dispatchBloodRequest),
  );
  router.post(
    "/:requestId/receipt",
    authenticateRequest(),
    authorizeAction("HOSPITAL_USER", "USER", "ADMINISTRATOR"),
    validateUuidParams("requestId"),
    asyncRoute(receiveBloodRequest),
  );
  return router;
}

// Search live inventory and return candidates, never a fulfilment guarantee.
export async function startBloodMatching(request: Request, response: Response) {
  const requestId = String(request.params.requestId);
  const bloodRequest = await findRequestById(requestId);
  if (!bloodRequest || bloodRequest.requestType !== RequestType.BLOOD) {
    throw new ApiError(404, "REQUEST_NOT_FOUND", "Blood request not found.");
  }
  assertMayCoordinate(bloodRequest, request.auth!);
  const radiusKm = request.body?.radiusKm;
  if (radiusKm !== undefined && typeof radiusKm !== "number") {
    throw new ApiError(400, "INVALID_MATCH_CRITERIA", "Search radius must be a number.");
  }
  const result = await startBloodMatchingWorkflow(requestId, request.auth?.userId, radiusKm);
  response.json({
    request: serializeRequestForActor(result.request!, request.auth),
    matching: serializeBloodMatchingResult(result.matching),
  });
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
    ...(request.auth?.userId
      ? { createdBy: { connect: { id: request.auth.userId } } }
      : { createdByInstitution: { connect: { id: request.auth?.institutionId } } }),
  });

  await recordAuditEvent({
    actorId: request.auth?.userId,
    actorInstitutionId: request.auth?.institutionId,
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

  if (!mayReadRequest(record, request.auth!)) {
    throw new ApiError(404, "REQUEST_NOT_FOUND", "Request not found.");
  }

  response.json(serializeRequestForActor(record, request.auth));
}

// Apply a validated state transition and write its audit record transactionally.
export async function reviewBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await reviewBloodRequestWorkflow(
    String(request.params.requestId),
    request.auth!,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}

export async function listBloodRequests(request: Request, response: Response) {
  const actor = request.auth!;
  const takeRaw = request.query.limit;
  const take = typeof takeRaw === "string" && /^\d+$/.test(takeRaw) ? Number(takeRaw) : 50;
  if (take < 1 || take > 100) throw new ApiError(400, "INVALID_LIMIT", "Limit must be from 1 to 100.");
  const where: Record<string, unknown> = { requestType: RequestType.BLOOD };
  if (actor.role !== "ADMINISTRATOR") {
    const scopes: Record<string, unknown>[] = [];
    if (actor.userId) scopes.push({ createdById: actor.userId }, { recipients: { some: { userId: actor.userId } } });
    if (actor.institutionId) {
      scopes.push({ createdByInstitutionId: actor.institutionId }, { matches: { some: { providerInstitutionId: actor.institutionId } } });
    }
    where.OR = scopes.length ? scopes : [{ id: "" }];
  }
  const rows = await searchRequests(where as never, take + 1);
  response.json({ requests: rows.slice(0, take).map((row) => serializeRequestForActor(row, actor)), hasMore: rows.length > take });
}

export async function listBloodOffers(request: Request, response: Response) {
  const record = await findRequestById(String(request.params.requestId));
  if (!record || record.requestType !== RequestType.BLOOD || !mayReadRequest(record, request.auth!)) {
    throw new ApiError(404, "REQUEST_NOT_FOUND", "Request not found.");
  }
  response.json({ offers: record.matches.map((match) => ({
    matchId: match.id, status: match.status, providerInstitutionId: match.providerInstitutionId,
    providerName: match.providerInstitution?.name ?? "Eligible institution", compatibilityScore: match.compatibilityScore,
    matchedAt: match.matchedDate, unitsAvailable: match.bloodInventory?.unitsAvailable ?? 0, expiryDate: match.bloodInventory?.expiryDate,
    reservationExpiresAt: match.reservationExpiresAt, dispatchedAt: match.dispatchedAt, receivedAt: match.receivedAt,
  })) });
}

export function assertMayCoordinate(
  record: NonNullable<Awaited<ReturnType<typeof findRequestById>>>,
  actor: AuthContext,
) {
  if (
    actor.role === "ADMINISTRATOR" ||
    record.createdById === actor.userId ||
    (actor.role === "HOSPITAL_USER" &&
      !!actor.institutionId &&
      record.createdByInstitutionId === actor.institutionId)
  ) {
    return;
  }
  throw new ApiError(404, "REQUEST_NOT_FOUND", "Request not found.");
}

export function mayReadRequest(
  record: NonNullable<Awaited<ReturnType<typeof findRequestById>>>,
  actor: AuthContext,
) {
  return (
    actor.role === "ADMINISTRATOR" ||
    record.createdById === actor.userId ||
    record.recipients.some((recipient) => recipient.userId === actor.userId) ||
    ((actor.role === "HOSPITAL_USER" || actor.role === "BLOOD_BANK_USER") &&
      !!actor.institutionId &&
      (record.createdByInstitutionId === actor.institutionId ||
        record.matches.some(
          (match) => match.providerInstitutionId === actor.institutionId,
        )))
  );
}

export async function respondToBloodOfferRoute(
  request: Request,
  response: Response,
) {
  const match = await respondToBloodOffer(
    String(request.params.requestId),
    String(request.params.matchId),
    request.body.action,
    request.auth!,
  );
  response.json(match);
}

export async function evaluateBloodOfferRoute(
  request: Request,
  response: Response,
) {
  const result = await evaluateBloodOffer(
    String(request.params.requestId),
    String(request.params.matchId),
    request.body.action,
    request.auth!,
  );
  response.json(result);
}

export async function reopenBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await reopenBloodRequestWorkflow(
    String(request.params.requestId),
    request.auth!,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}

export async function cancelBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await cancelBloodRequestWorkflow(
    String(request.params.requestId),
    request.auth!,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}

export async function dispatchBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await dispatchBloodRequestWorkflow(
    String(request.params.requestId),
    request.auth!,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}

export async function receiveBloodRequest(
  request: Request,
  response: Response,
) {
  const updated = await receiveBloodRequestWorkflow(
    String(request.params.requestId),
    request.auth!,
  );
  response.json(serializeRequestForActor(updated, request.auth));
}

let reservationExpiryTimer: ReturnType<typeof setInterval> | undefined;

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function startReservationExpiryWorker() {
  if (reservationExpiryTimer) return;
  void expireBloodReservations().catch((error: unknown) => {
    console.error(
      "LifeLink reservation expiry failed",
      error instanceof Error ? error.name : "UnknownError",
    );
  });
  reservationExpiryTimer = setInterval(() => {
    void expireBloodReservations().catch((error: unknown) => {
      console.error(
        "LifeLink reservation expiry failed",
        error instanceof Error ? error.name : "UnknownError",
      );
    });
  }, 60_000);
  reservationExpiryTimer.unref?.();
}
