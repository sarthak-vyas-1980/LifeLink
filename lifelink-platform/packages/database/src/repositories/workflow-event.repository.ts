import { randomUUID } from "node:crypto";
import { NotificationType, type Prisma } from "@prisma/client";

type Transaction = Prisma.TransactionClient;

export interface WorkflowEventInput {
  eventType: string;
  requestId?: string;
  actorId?: string;
  payload: Record<string, string | number | boolean | null>;
}

// Persist the event and its authorized inbox rows with the state change transaction.
export async function recordWorkflowEvent(
  transaction: Transaction,
  input: WorkflowEventInput,
) {
  const eventId = randomUUID();
  const recipientIds = new Set<string>();

  if (input.requestId) {
    const request = await transaction.request.findUnique({
      where: { id: input.requestId },
      select: {
        createdById: true,
        createdBy: { select: { institutionId: true } },
        matches: { select: { providerInstitutionId: true } },
      },
    });
    if (request) {
      recipientIds.add(request.createdById);
      const institutionIds = [
        request.createdBy.institutionId,
        ...request.matches.map((match) => match.providerInstitutionId),
      ].filter((id): id is string => Boolean(id));
      if (institutionIds.length > 0) {
        const participants = await transaction.user.findMany({
          where: {
            status: "ACTIVE",
            institutionId: { in: [...new Set(institutionIds)] },
            role: { in: ["HOSPITAL_USER", "BLOOD_BANK_USER"] },
          },
          select: { id: true },
        });
        for (const participant of participants) recipientIds.add(participant.id);
      }
    }
  } else if (input.actorId) {
    recipientIds.add(input.actorId);
  }

  await transaction.workflowEvent.create({
    data: {
      id: eventId,
      eventType: input.eventType,
      requestId: input.requestId,
      actorId: input.actorId,
      payload: input.payload as Prisma.InputJsonValue,
    },
  });

  if (recipientIds.size > 0) {
    await transaction.notification.createMany({
      data: [...recipientIds].map((userId) => ({
        userId,
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
