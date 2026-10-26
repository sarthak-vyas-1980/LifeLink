import { randomUUID } from "node:crypto";
import { NotificationType, type Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

export interface WorkflowEventInput {
  eventType: string;
  requestId?: string;
  actorId?: string;
  actorInstitutionId?: string;
  payload: Record<string, string | number | boolean | null>;
}

// Persist the event and its authorized inbox rows with the state change transaction.
export async function recordWorkflowEvent(
  transaction: Transaction,
  input: WorkflowEventInput,
) {
  const eventId = randomUUID();
  const recipientUserIds = new Set<string>();
  const recipientInstitutionIds = new Set<string>();
  const requestDetails: Record<string, string | number | boolean | null> = {};

  if (input.requestId) {
    const request = await transaction.request.findUnique({
      where: { id: input.requestId },
      select: {
        id: true,
        requestType: true,
        bloodGroup: true,
        component: true,
        quantity: true,
        priority: true,
        location: true,
        createdById: true,
        createdByInstitutionId: true,
        matches: { select: { providerInstitutionId: true, bloodInventory: { select: { institutionId: true } } } },
      },
    });
    if (request) {
      if (request.requestType === "BLOOD") {
        Object.assign(requestDetails, {
          requestReference: request.id,
          bloodGroup: request.bloodGroup,
          component: request.component,
          quantity: request.quantity,
          priority: request.priority,
          location: request.location,
        });
      }
      if (request.createdById) recipientUserIds.add(request.createdById);
      const institutionIds = [
        request.createdByInstitutionId,
        ...request.matches.map((match) => match.providerInstitutionId),
        ...request.matches.map((match) => match.bloodInventory?.institutionId),
      ].filter((id): id is string => Boolean(id));
      if (institutionIds.length > 0) {
        const participants = await transaction.institutionAccount.findMany({
          where: { institutionId: { in: [...new Set(institutionIds)] } },
          select: { institutionId: true },
        });
        for (const participant of participants) recipientInstitutionIds.add(participant.institutionId);
      }
    }
  } else if (input.actorId) {
    recipientUserIds.add(input.actorId);
  } else if (input.actorInstitutionId) {
    recipientInstitutionIds.add(input.actorInstitutionId);
  }

  await transaction.workflowEvent.create({
    data: {
      id: eventId,
      eventType: input.eventType,
      requestId: input.requestId,
      actorId: input.actorId,
      actorInstitutionId: input.actorInstitutionId,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });

  if (recipientUserIds.size > 0 || recipientInstitutionIds.size > 0) {
    const eventDetails = await describeWorkflowEvent(transaction, input, requestDetails);
    await transaction.notification.createMany({
      data: [
        ...[...recipientUserIds].map((userId) => ({ userId })),
        ...[...recipientInstitutionIds].map((institutionId) => ({ institutionId })),
      ].map((recipient) => ({
        ...recipient,
        eventId,
        eventType: input.eventType,
        requestId: input.requestId,
        title: eventDetails.title,
        message: eventDetails.message,
        payload: { ...input.payload, ...requestDetails, ...eventDetails.payload } as Prisma.InputJsonValue,
        type: NotificationType.IN_APP,
      })),
      skipDuplicates: true,
    });
  }
}

async function describeWorkflowEvent(
  transaction: Transaction,
  input: WorkflowEventInput,
  requestDetails: Record<string, string | number | boolean | null>,
) {
  const payload = input.payload;
  const status = typeof payload.status === "string" ? payload.status : undefined;
  const to = typeof payload.to === "string" ? payload.to : status;
  const from = typeof payload.from === "string" ? payload.from : undefined;
  const matchId = typeof payload.matchId === "string" ? payload.matchId : undefined;
  const detail = formatRequestDetails(requestDetails);

  if (input.eventType === "OFFER_STATUS_CHANGED" && matchId) {
    const match = await transaction.match.findUnique({
      where: { id: matchId },
      select: { providerInstitution: { select: { name: true } }, bloodInventory: { select: { unitsAvailable: true, reservedUnits: true } } },
    });
    const institutionName = match?.providerInstitution?.name ?? "A matched institution";
    const offerAction: Record<string, string> = {
      ACCEPTED: "confirmed availability",
      REJECTED: "declined the offer",
      EXPIRED: "offer expired",
      PENDING: "offer is awaiting a response",
    };
    const action = offerAction[status ?? ""] ?? `offer status changed to ${humanize(status ?? "updated")}`;
    return {
      title: `Blood offer ${status === "ACCEPTED" ? "confirmed" : status === "REJECTED" ? "declined" : status === "EXPIRED" ? "expired" : "updated"}`,
      message: `${institutionName} ${action} for ${detail}.`,
      payload: {
        institutionName,
        offerStatus: status ?? null,
        unitsAvailable: match?.bloodInventory?.unitsAvailable ?? null,
        unitsReserved: match?.bloodInventory?.reservedUnits ?? null,
      },
    };
  }

  if (input.eventType === "REQUEST_STATUS_CHANGED" && to) {
    const transitions: Record<string, { title: string; message: string }> = {
      UNDER_REVIEW: { title: "Blood request entered review", message: "The request was submitted for review." },
      SEARCHING_MATCHING: { title: "Searching for blood matches", message: "LifeLink is searching eligible institutional stock." },
      INSTITUTIONS_NOTIFIED: { title: "Matched institutions notified", message: "Matched institutions have been invited to confirm availability." },
      OFFERS_RECEIVED: { title: "A provider confirmed availability", message: "At least one institution confirmed its offer; review the available providers." },
      OFFER_EVALUATION: { title: "Provider offer selected for review", message: "The requester is evaluating the confirmed provider offers." },
      OFFER_ACCEPTED: { title: "Provider offer accepted", message: "The selected provider offer was accepted; stock reservation is in progress." },
      RESERVED: { title: "Blood units reserved", message: "The selected institution's units are reserved for this request." },
      FULFILLED: { title: "Blood request fulfilled", message: "The user has collected the reserved blood units from the institution." },
      CANCELLED: { title: "Blood request cancelled", message: "The requester cancelled this request." },
      REOPENED: { title: "Blood request reopened", message: "The request returned to matching so another provider can be found." },
      EXPIRED: { title: "Blood reservation expired", message: "The reservation expired before the request was completed; the reserved units were released." },
      CREATED: { title: "Blood request created", message: "A new blood request was created." },
    };
    const transition = transitions[to] ?? { title: `Blood request ${humanize(to)}`, message: `Request status changed${from ? ` from ${humanize(from)} to ${humanize(to)}` : ` to ${humanize(to)}`}.` };
    return { title: transition.title, message: `${transition.message} ${detail}.`, payload: { fromStatus: from ?? null, toStatus: to } };
  }

  const title = notificationTitle(input.eventType);
  return { title, message: `${title}${detail ? `: ${detail}` : "."}`, payload: {} };
}

function formatRequestDetails(details: Record<string, string | number | boolean | null>) {
  if (!details.bloodGroup) return "the request";
  const bloodGroup = String(details.bloodGroup).replace("_POSITIVE", "+").replace("_NEGATIVE", "−");
  const component = String(details.component ?? "blood").replaceAll("_", " ").toLowerCase();
  return `${details.quantity} unit${details.quantity === 1 ? "" : "s"} of ${bloodGroup} ${component} near ${details.location}`;
}

function humanize(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}

function notificationTitle(eventType: string) {
  const titles: Record<string, string> = {
    REQUEST_CREATED: "Blood request created",
    EMERGENCY_REQUEST_CREATED: "Emergency blood request created",
    REQUEST_STATUS_CHANGED: "Blood request updated",
    OFFER_STATUS_CHANGED: "Blood offer updated",
    BLOOD_RESERVATION_CREATED: "Blood units reserved",
    RESERVATION_EXPIRED: "Blood reservation expired",
  };
  return titles[eventType] ?? "LifeLink workflow update";
}
