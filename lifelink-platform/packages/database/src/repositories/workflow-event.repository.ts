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

  if (input.requestId) {
    const request = await transaction.request.findUnique({
      where: { id: input.requestId },
      select: {
        createdById: true,
        createdByInstitutionId: true,
        matches: { select: { providerInstitutionId: true } },
      },
    });
    if (request) {
      if (request.createdById) recipientUserIds.add(request.createdById);
      const institutionIds = [
        request.createdByInstitutionId,
        ...request.matches.map((match) => match.providerInstitutionId),
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
    await transaction.notification.createMany({
      data: [
        ...[...recipientUserIds].map((userId) => ({ userId })),
        ...[...recipientInstitutionIds].map((institutionId) => ({ institutionId })),
      ].map((recipient) => ({
        ...recipient,
        eventId,
        eventType: input.eventType,
        requestId: input.requestId,
        title: notificationTitle(input.eventType),
        message: input.requestId
          ? `Request ${input.requestId} changed: ${input.eventType.toLowerCase().replaceAll("_", " ")}.`
          : notificationTitle(input.eventType),
        payload: input.payload as Prisma.InputJsonValue,
        type: NotificationType.IN_APP,
      })),
      skipDuplicates: true,
    });
  }
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
