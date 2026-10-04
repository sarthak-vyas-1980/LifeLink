import {
  MatchStatus,
  Prisma,
  RequestStatus,
  RequestType,
} from "@prisma/client";
import {
  isAllowedTransition,
  type RequestStatus as DomainRequestStatus,
} from "@lifelink/shared";
import {
  consumeReservedBloodUnits,
  database,
  releaseReservedBloodUnits,
  recordWorkflowEvent,
  reserveBloodUnits,
} from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { getRuntimeConfig } from "../../config";

type Transaction = Prisma.TransactionClient;
type BloodRequest = Prisma.RequestGetPayload<{
  include: {
    createdBy: true;
    matches: { include: { bloodInventory: true; providerInstitution: true } };
  };
}>;

function notFound(message = "Blood request not found."): never {
  throw new ApiError(404, "REQUEST_NOT_FOUND", message);
}

function conflict(message: string): never {
  throw new ApiError(409, "WORKFLOW_CONFLICT", message);
}

function forbidden(): never {
  throw new ApiError(
    403,
    "FORBIDDEN",
    "You are not authorized for this blood-request action.",
  );
}

async function loadBloodRequest(
  transaction: Transaction,
  requestId: string,
): Promise<BloodRequest> {
  const request = await transaction.request.findUnique({
    where: { id: requestId },
    include: {
      createdBy: true,
      matches: {
        include: { bloodInventory: true, providerInstitution: true },
      },
    },
  });
  if (!request || request.requestType !== RequestType.BLOOD) {
    notFound();
  }
  return request;
}

function assertRequester(request: BloodRequest, actor: AuthContext) {
  if (
    actor.role === "ADMINISTRATOR" ||
    request.createdById === actor.userId ||
    (actor.role === "HOSPITAL_USER" &&
      actor.institutionId !== undefined &&
      request.createdBy.institutionId === actor.institutionId)
  ) {
    return;
  }
  forbidden();
}

function assertProvider(
  match: BloodRequest["matches"][number],
  actor: AuthContext,
) {
  if (
    actor.role === "ADMINISTRATOR" ||
    ((actor.role === "BLOOD_BANK_USER" || actor.role === "HOSPITAL_USER") &&
      actor.institutionId !== undefined &&
      match.providerInstitutionId === actor.institutionId)
  ) {
    return;
  }
  forbidden();
}

async function transitionRequest(
  transaction: Transaction,
  requestId: string,
  from: RequestStatus,
  to: RequestStatus,
  actorId: string | undefined,
) {
  if (
    !isAllowedTransition(
      from as DomainRequestStatus,
      to as DomainRequestStatus,
    )
  ) {
    conflict(`Invalid request transition: ${from} -> ${to}.`);
  }

  const result = await transaction.request.updateMany({
    where: { id: requestId, status: from },
    data: { status: to },
  });
  if (result.count !== 1) {
    conflict("Request state changed or the request does not exist.");
  }
  await transaction.auditLog.create({
    data: {
      actorId,
      action: "REQUEST_STATUS_CHANGED",
      entityType: "Request",
      entityId: requestId,
      metadata: { from, to },
    },
  });
  await recordWorkflowEvent(transaction, {
    eventType: "REQUEST_STATUS_CHANGED",
    requestId,
    actorId,
    payload: { from, to },
  });
}

async function auditMatch(
  transaction: Transaction,
  matchId: string,
  requestId: string,
  status: MatchStatus,
  actorId: string | undefined,
  action = "MATCH_STATUS_CHANGED",
) {
  await transaction.auditLog.create({
    data: {
      actorId,
      action,
      entityType: "Match",
      entityId: matchId,
      metadata: { status },
    },
  });
  await recordWorkflowEvent(transaction, {
    eventType: "OFFER_STATUS_CHANGED",
    requestId,
    actorId,
    payload: { matchId, status },
  });
}

async function expireOtherOffers(
  transaction: Transaction,
  request: BloodRequest,
  exceptMatchId: string | undefined,
  actorId: string,
) {
  const otherOffers = request.matches.filter(
    (match) =>
      match.id !== exceptMatchId &&
      (match.status === MatchStatus.PENDING ||
        match.status === MatchStatus.ACCEPTED),
  );
  for (const match of otherOffers) {
    const result = await transaction.match.updateMany({
      where: { id: match.id, status: match.status },
      data: { status: MatchStatus.EXPIRED },
    });
    if (result.count === 1) {
      await auditMatch(
        transaction,
        match.id,
        request.id,
        MatchStatus.EXPIRED,
        actorId,
      );
    }
  }
}

function getMatch(request: BloodRequest, matchId: string) {
  const match = request.matches.find((candidate) => candidate.id === matchId);
  if (!match) {
    notFound("Offer not found for this request.");
  }
  return match;
}

// Approve a newly created request for the matching workflow.
export function reviewBloodRequest(requestId: string, actor: AuthContext) {
  if (actor.role !== "ADMINISTRATOR") {
    forbidden();
  }
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    if (request.status !== RequestStatus.CREATED) {
      conflict("Only a newly created request can be reviewed.");
    }
    await transitionRequest(
      transaction,
      requestId,
      RequestStatus.CREATED,
      RequestStatus.UNDER_REVIEW,
      actor.userId,
    );
    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// Record a blood bank's response to a candidate offer.
export function respondToBloodOffer(
  requestId: string,
  matchId: string,
  action: "ACCEPT" | "REJECT",
  actor: AuthContext,
) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    const match = getMatch(request, matchId);
    assertProvider(match, actor);
    const offerCollectingStatuses: RequestStatus[] = [
      RequestStatus.INSTITUTIONS_NOTIFIED,
      RequestStatus.OFFERS_RECEIVED,
      RequestStatus.OFFER_EVALUATION,
    ];
    if (!offerCollectingStatuses.includes(request.status)) {
      conflict("Offers can only be answered while the request is collecting offers.");
    }
    if (match.status !== MatchStatus.PENDING) {
      conflict("This offer has already been answered or is no longer available.");
    }

    const status =
      action === "ACCEPT" ? MatchStatus.ACCEPTED : MatchStatus.REJECTED;
    const update = await transaction.match.updateMany({
      where: { id: matchId, requestId, status: MatchStatus.PENDING },
      data: { status },
    });
    if (update.count !== 1) {
      conflict("This offer has already been answered or is no longer available.");
    }
    await auditMatch(transaction, matchId, requestId, status, actor.userId, "OFFER_RESPONDED");

    if (
      action === "ACCEPT" &&
      request.status === RequestStatus.INSTITUTIONS_NOTIFIED
    ) {
      await transitionRequest(
        transaction,
        requestId,
        RequestStatus.INSTITUTIONS_NOTIFIED,
        RequestStatus.OFFERS_RECEIVED,
        actor.userId,
      );
    } else if (action === "REJECT") {
      const remainingOffers = await transaction.match.count({
        where: {
          requestId,
          id: { not: matchId },
          status: { in: [MatchStatus.PENDING, MatchStatus.ACCEPTED] },
        },
      });
      if (remainingOffers === 0) {
        await transitionRequest(
          transaction,
          requestId,
          request.status,
          RequestStatus.REOPENED,
          actor.userId,
        );
      }
    }

    return transaction.match.findUniqueOrThrow({ where: { id: matchId } });
  });
}

// Let the requester accept an institution's offer and reserve its live units.
export function evaluateBloodOffer(
  requestId: string,
  matchId: string,
  action: "ACCEPT" | "REJECT",
  actor: AuthContext,
) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    assertRequester(request, actor);
    const match = getMatch(request, matchId);
    if (match.status !== MatchStatus.ACCEPTED || !match.bloodInventoryId) {
      conflict("Only an available provider offer can be evaluated.");
    }
    if (
      request.status !== RequestStatus.OFFERS_RECEIVED &&
      request.status !== RequestStatus.OFFER_EVALUATION
    ) {
      conflict("The request is not in offer evaluation.");
    }

    if (request.status === RequestStatus.OFFERS_RECEIVED) {
      await transitionRequest(
        transaction,
        requestId,
        RequestStatus.OFFERS_RECEIVED,
        RequestStatus.OFFER_EVALUATION,
        actor.userId,
      );
    }

    if (action === "REJECT") {
      const update = await transaction.match.updateMany({
        where: {
          id: matchId,
          requestId,
          status: MatchStatus.ACCEPTED,
        },
        data: { status: MatchStatus.REJECTED },
      });
      if (update.count !== 1) {
        conflict("This offer has already been evaluated.");
      }
      await auditMatch(
        transaction,
        matchId,
        requestId,
        MatchStatus.REJECTED,
        actor.userId,
        "OFFER_REJECTED",
      );
      const remainingOffers = await transaction.match.count({
        where: {
          requestId,
          id: { not: matchId },
          status: { in: [MatchStatus.PENDING, MatchStatus.ACCEPTED] },
        },
      });
      if (remainingOffers === 0) {
        await transitionRequest(
          transaction,
          requestId,
          RequestStatus.OFFER_EVALUATION,
          RequestStatus.REOPENED,
          actor.userId,
        );
      }
      return {
        outcome: remainingOffers === 0 ? "REOPENED" : "OFFER_REJECTED",
        match: await transaction.match.findUniqueOrThrow({ where: { id: matchId } }),
      };
    }

    const reservationExpiresAt = new Date(
      Date.now() + getRuntimeConfig().bloodReservationTtlMinutes * 60_000,
    );
    await transitionRequest(
      transaction,
      requestId,
      RequestStatus.OFFER_EVALUATION,
      RequestStatus.OFFER_ACCEPTED,
      actor.userId,
    );
    try {
      await reserveBloodUnits(
        transaction,
        match.bloodInventoryId,
        request.quantity,
        actor.userId,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("inventory is unavailable")
      ) {
        conflict(
          "The provider's inventory changed. Reopen the request to search again.",
        );
      }
      throw error;
    }
    await transitionRequest(
      transaction,
      requestId,
      RequestStatus.OFFER_ACCEPTED,
      RequestStatus.RESERVED,
      actor.userId,
    );
    await transaction.match.update({
      where: { id: matchId },
      data: { reservedAt: new Date(), reservationExpiresAt },
    });
    await expireOtherOffers(transaction, request, matchId, actor.userId);
    await transaction.auditLog.create({
      data: {
        actorId: actor.userId,
        action: "BLOOD_RESERVATION_CREATED",
        entityType: "Request",
        entityId: requestId,
        metadata: { matchId, reservationExpiresAt },
      },
    });

    return {
      outcome: "RESERVED",
      match: await transaction.match.findUniqueOrThrow({ where: { id: matchId } }),
      reservationExpiresAt,
    };
  });
}

// Reopen a request and release any selected offer reservation atomically.
export function reopenBloodRequest(requestId: string, actor: AuthContext) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    assertRequester(request, actor);
    const reopenableStatuses: RequestStatus[] = [
      RequestStatus.SEARCHING_MATCHING,
      RequestStatus.INSTITUTIONS_NOTIFIED,
      RequestStatus.OFFERS_RECEIVED,
      RequestStatus.OFFER_EVALUATION,
      RequestStatus.RESERVED,
    ];
    if (!reopenableStatuses.includes(request.status)) {
      conflict("This request cannot be reopened from its current state.");
    }

    await transitionRequest(
      transaction,
      requestId,
      request.status,
      RequestStatus.REOPENED,
      actor.userId,
    );

    if (request.status === RequestStatus.RESERVED) {
      const reservedMatch = request.matches.find(
        (candidate) =>
          candidate.status === MatchStatus.ACCEPTED &&
          candidate.bloodInventoryId !== null,
      );
      if (!reservedMatch?.bloodInventoryId) {
        conflict("The reservation has no selected inventory record.");
      }
      await releaseReservedBloodUnits(
        transaction,
        reservedMatch.bloodInventoryId,
        request.quantity,
        actor.userId,
      );
      await transaction.match.update({
        where: { id: reservedMatch.id },
        data: { status: MatchStatus.EXPIRED, reservationExpiresAt: null },
      });
      await auditMatch(
        transaction,
        reservedMatch.id,
        requestId,
        MatchStatus.EXPIRED,
        actor.userId,
        "BLOOD_RESERVATION_RELEASED",
      );
    }

    await expireOtherOffers(transaction, request, undefined, actor.userId);
    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// Cancel an active request, releasing reserved units when necessary.
export function cancelBloodRequest(requestId: string, actor: AuthContext) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    assertRequester(request, actor);
    const cancellableStatuses: RequestStatus[] = [
      RequestStatus.REOPENED,
      RequestStatus.CREATED,
      RequestStatus.UNDER_REVIEW,
      RequestStatus.SEARCHING_MATCHING,
      RequestStatus.INSTITUTIONS_NOTIFIED,
      RequestStatus.OFFERS_RECEIVED,
      RequestStatus.OFFER_EVALUATION,
      RequestStatus.RESERVED,
    ];
    if (!cancellableStatuses.includes(request.status)) {
      conflict("This request cannot be cancelled from its current state.");
    }

    await transitionRequest(
      transaction,
      requestId,
      request.status,
      RequestStatus.CANCELLED,
      actor.userId,
    );

    if (request.status === RequestStatus.RESERVED) {
      const reservedMatch = request.matches.find(
        (candidate) =>
          candidate.status === MatchStatus.ACCEPTED &&
          candidate.bloodInventoryId !== null,
      );
      if (!reservedMatch?.bloodInventoryId) {
        conflict("The reservation has no selected inventory record.");
      }
      await releaseReservedBloodUnits(
        transaction,
        reservedMatch.bloodInventoryId,
        request.quantity,
        actor.userId,
      );
      await transaction.match.update({
        where: { id: reservedMatch.id },
        data: { status: MatchStatus.EXPIRED, reservationExpiresAt: null },
      });
      await auditMatch(
        transaction,
        reservedMatch.id,
        requestId,
        MatchStatus.EXPIRED,
        actor.userId,
        "BLOOD_RESERVATION_RELEASED",
      );
    }

    await expireOtherOffers(transaction, request, undefined, actor.userId);
    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// The selected provider dispatches units while the reservation is still valid.
export function dispatchBloodRequest(requestId: string, actor: AuthContext) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    if (request.status !== RequestStatus.RESERVED) {
      conflict("Only reserved blood requests can be dispatched.");
    }
    const selectedMatch = request.matches.find(
      (candidate) =>
        candidate.status === MatchStatus.ACCEPTED &&
        candidate.reservationExpiresAt !== null,
    );
    if (!selectedMatch) {
      conflict("The selected offer has no active reservation.");
    }
    assertProvider(selectedMatch, actor);
    if (selectedMatch.reservationExpiresAt! <= new Date()) {
      conflict("The reservation has expired and cannot be dispatched.");
    }
    await transaction.match.update({
      where: { id: selectedMatch.id },
      data: { dispatchedAt: new Date() },
    });
    await transitionRequest(
      transaction,
      requestId,
      RequestStatus.RESERVED,
      RequestStatus.IN_TRANSIT,
      actor.userId,
    );
    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// Confirm receipt, consume the reserved inventory and fulfil the request.
export function receiveBloodRequest(requestId: string, actor: AuthContext) {
  return database.$transaction(async (transaction) => {
    const request = await loadBloodRequest(transaction, requestId);
    assertRequester(request, actor);
    if (request.status !== RequestStatus.IN_TRANSIT) {
      conflict("Only in-transit blood requests can be marked received.");
    }
    const selectedMatch = request.matches.find(
      (candidate) =>
        candidate.status === MatchStatus.ACCEPTED &&
        candidate.bloodInventoryId !== null,
    );
    if (!selectedMatch?.bloodInventoryId) {
      conflict("The in-transit request has no selected inventory record.");
    }

    await consumeReservedBloodUnits(
      transaction,
      selectedMatch.bloodInventoryId,
      request.quantity,
      actor.userId,
    );
    await transaction.match.update({
      where: { id: selectedMatch.id },
      data: { receivedAt: new Date(), reservationExpiresAt: null },
    });
    await transitionRequest(
      transaction,
      requestId,
      RequestStatus.IN_TRANSIT,
      RequestStatus.FULFILLED,
      actor.userId,
    );
    return transaction.request.findUniqueOrThrow({ where: { id: requestId } });
  });
}

// Expire due reservations; safe to invoke from a periodic worker or maintenance job.
export async function expireBloodReservations(now = new Date()) {
  const dueReservations = await database.match.findMany({
    where: {
      status: MatchStatus.ACCEPTED,
      reservationExpiresAt: { lte: now },
      request: { status: RequestStatus.RESERVED, requestType: RequestType.BLOOD },
    },
    select: { id: true, requestId: true },
  });
  let expiredCount = 0;

  for (const reservation of dueReservations) {
    const expired = await database.$transaction(async (transaction) => {
      const request = await loadBloodRequest(transaction, reservation.requestId);
      const match = getMatch(request, reservation.id);
      if (
        request.status !== RequestStatus.RESERVED ||
        match.status !== MatchStatus.ACCEPTED ||
        !match.bloodInventoryId ||
        !match.reservationExpiresAt ||
        match.reservationExpiresAt > now
      ) {
        return false;
      }

      await transitionRequest(
        transaction,
        request.id,
        RequestStatus.RESERVED,
        RequestStatus.EXPIRED,
        undefined,
      );
      await releaseReservedBloodUnits(
        transaction,
        match.bloodInventoryId,
        request.quantity,
      );
      await transaction.match.update({
        where: { id: match.id },
        data: { status: MatchStatus.EXPIRED, reservationExpiresAt: null },
      });
      await auditMatch(
        transaction,
        match.id,
        request.id,
        MatchStatus.EXPIRED,
        undefined,
        "RESERVATION_EXPIRED",
      );
      await transaction.auditLog.create({
        data: {
          action: "RESERVATION_EXPIRED",
          entityType: "Request",
          entityId: request.id,
          metadata: { matchId: match.id },
        },
      });
      return true;
    });
    if (expired) expiredCount += 1;
  }

  return { expiredCount };
}
