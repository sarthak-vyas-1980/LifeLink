import { NotificationStatus, NotificationType, Prisma } from "@prisma/client";

type OrganNotification = {
	organId: string;
	eventId: string;
	eventType: string;
	metadata: Prisma.InputJsonObject;
	institutionIds: string[];
};

// Persist organ workflow notifications in the same transaction as their event.
export async function createOrganNotifications(tx: Prisma.TransactionClient, event: OrganNotification) {
	const administrators = await tx.user.findMany({ where: { status: "ACTIVE", role: "ADMIN" }, select: { id: true } });
	const institutionAccounts = event.institutionIds.length
		? await tx.institutionAccount.findMany({ where: { institutionId: { in: event.institutionIds } }, select: { institutionId: true } })
		: [];
	if (!administrators.length && !institutionAccounts.length) return;
	await tx.notification.createMany({
		data: [
			...administrators.map(({ id }) => ({ userId: id })),
			...institutionAccounts.map(({ institutionId }) => ({ institutionId })),
		].map((recipient) => ({
			...recipient,
			eventId: event.eventId,
			eventType: event.eventType,
			title: organEventTitle(event.eventType),
			message: `Organ workflow ${event.eventType.toLowerCase().replaceAll("_", " ")}.`,
			payload: { organId: event.organId, ...event.metadata },
			type: NotificationType.IN_APP,
			status: NotificationStatus.UNREAD,
		})),
		skipDuplicates: true,
	});
}

function organEventTitle(type: string) {
	const labels: Record<string, string> = {
		ORGAN_CREATED: "Organ record created",
		ORGAN_STATUS_CHANGED: "Organ status updated",
		ORGAN_MATCH_GENERATED: "Potential coordination matches generated",
		ORGAN_OFFER_SENT: "Organ offer sent",
		ORGAN_OFFER_ACCEPTED: "Organ offer accepted",
		ORGAN_OFFER_REJECTED: "Organ offer rejected",
		ORGAN_OFFER_EXPIRED: "Organ offer expired",
		ORGAN_PRESERVATION_STARTED: "Preservation timing started",
		PRESERVATION_WARNING: "Preservation timer warning",
		PRESERVATION_CRITICAL: "Preservation timer critical",
		PRESERVATION_EXPIRED: "Configured preservation timer expired",
	};
	return labels[type] ?? "Organ coordination update";
}
