import { randomUUID } from "node:crypto";
import {
	ConsentStatus,
	NotificationStatus,
	NotificationType,
	OrganAuthorizationStatus,
	OrganDonorStatus,
	OrganMatchStatus,
	OrganOfferStatus,
	OrganRecipientStatus,
	OrganStatus,
	OrganType,
	Prisma,
	PreservationMethod,
	PreservationStatus,
	ProcurementStatus,
	RequestPriority,
} from "@prisma/client";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { calculateDistance } from "../maps/geospatial.service";

import { addEvent, assertInstitution, requireInstitution } from './shared';

export async function listOrganRecipients(actor: AuthContext, filters: { q?: string; status?: OrganRecipientStatus; stage?: "REVIEW" | "MATCHING" | "OFFER" | "PROCUREMENT" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED" } = {}) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const stageWhere: Record<NonNullable<typeof filters.stage>, Prisma.OrganRecipientWhereInput> = {
		REVIEW: { status: OrganRecipientStatus.PENDING_REVIEW },
		MATCHING: { status: OrganRecipientStatus.ACTIVE, matches: { some: { status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } } } },
		OFFER: { OR: [{ status: OrganRecipientStatus.MATCHED }, { offers: { some: { status: { in: [OrganOfferStatus.SENT, OrganOfferStatus.UNDER_REVIEW, OrganOfferStatus.ACCEPTED] } } } }] },
		PROCUREMENT: { offers: { some: { status: OrganOfferStatus.ACCEPTED, organ: { procurements: { some: { status: { in: [ProcurementStatus.SCHEDULED, ProcurementStatus.IN_PROGRESS, ProcurementStatus.COMPLETED] } } } } } } },
		COMPLETED: { status: OrganRecipientStatus.CLOSED },
		REJECTED: { status: OrganRecipientStatus.REJECTED },
		CANCELLED: { status: OrganRecipientStatus.CANCELLED },
		EXPIRED: { offers: { some: { status: OrganOfferStatus.EXPIRED } } },
	};
	const recipients = await database.organRecipient.findMany({ where: { AND: [{ ...(institutionId ? { institutionId } : {}), ...(filters.status ? { status: filters.status } : {}), ...(filters.q ? { reference: { contains: filters.q, mode: "insensitive" } } : {}) }, ...(filters.stage ? [stageWhere[filters.stage]] : [])] }, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, updatedAt: true, user: { select: { name: true, phone: true, email: true } }, institution: { select: { name: true } }, requirement: true, matches: { select: { status: true } }, offers: { select: { status: true, organ: { select: { id: true, status: true, procurements: { select: { status: true } } } } } } }, orderBy: [{ updatedAt: "desc" }, { registrationDate: "desc" }], take: 100 });
	return recipients.map(({ user, matches, offers, ...recipient }) => ({ ...recipient, workflowStage: recipientWorkflowStage({ status: recipient.status, matches, offers }), contactName: user?.name ?? null, contactPhone: user?.phone ?? null, contactEmail: user?.email ?? null }));
}

function recipientWorkflowStage(recipient: { status: OrganRecipientStatus; matches: Array<{ status: OrganMatchStatus }>; offers: Array<{ status: OrganOfferStatus; organ: { status: OrganStatus; procurements: Array<{ status: ProcurementStatus }> } }> }) {
	const is = (values: readonly string[], value: string | undefined) => value !== undefined && values.includes(value);
	if (recipient.status === OrganRecipientStatus.PENDING_REVIEW) return "UNDER_REVIEW";
	if (recipient.status === OrganRecipientStatus.REJECTED) return "REJECTED";
	if (recipient.status === OrganRecipientStatus.CANCELLED) return "CANCELLED";
	if (recipient.status === OrganRecipientStatus.CLOSED) return "FULFILLED";
	const acceptedOffer = recipient.offers.find((item) => item.status === OrganOfferStatus.ACCEPTED);
	if (acceptedOffer?.organ.status === OrganStatus.EXPIRED || recipient.offers.some((item) => item.status === OrganOfferStatus.EXPIRED)) return "EXPIRED";
	if (acceptedOffer?.organ.status === OrganStatus.UNAVAILABLE) return "UNAVAILABLE";
	if (is([OrganStatus.COMPLETED, OrganStatus.TRANSPLANTED], acceptedOffer?.organ.status)) return "FULFILLED";
	if (is([OrganStatus.RETRIEVED, OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED], acceptedOffer?.organ.status)) return "TRANSPLANT_COORDINATION";
	if (acceptedOffer?.organ.procurements.some((item) => item.status === ProcurementStatus.COMPLETED)) return "TRANSPLANT_COORDINATION";
	if (acceptedOffer) return "PROCUREMENT_IN_PROGRESS";
	if (recipient.offers.some((item) => item.status === OrganOfferStatus.UNDER_REVIEW)) return "OFFER_EVALUATION";
	if (recipient.offers.some((item) => item.status === OrganOfferStatus.SENT)) return "OFFER_SENT";
	if (recipient.matches.some((item) => [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED, OrganMatchStatus.CONVERTED_TO_OFFER].some((status) => status === item.status))) return "POTENTIAL_MATCHES";
	return "MATCHING";
}
	export async function getOrganRecipient(actor: AuthContext, recipientId: string) {
	const recipient = await database.organRecipient.findUnique({ where: { id: recipientId }, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, user: { select: { name: true, phone: true, email: true } }, institution: { select: { name: true } }, requirement: true, matches: { select: { id: true, status: true, coordinationScore: true, matchReasons: true, generatedAt: true, organ: { select: { reference: true, organType: true, status: true } } }, orderBy: { coordinationScore: "desc" } }, offers: { select: { id: true, reference: true, status: true, offeredAt: true, responseDeadline: true, organ: { select: { id: true, status: true, procurements: { select: { status: true } } } } } } } });
	if (!recipient || actor.role !== "ADMINISTRATOR" && actor.institutionId !== recipient.institutionId) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient record not found.");
	return { ...recipient, workflowStage: recipientWorkflowStage(recipient), contactName: recipient.user?.name ?? null, contactPhone: recipient.user?.phone ?? null, contactEmail: recipient.user?.email ?? null };
}
export async function updateOrganRecipient(actor: AuthContext, recipientId: string, input: { organType?: OrganType; bloodGroup?: string | null; priority?: RequestPriority; latitude?: number | null; longitude?: number | null; maximumDistanceKm?: number | null; urgency?: string | null; requiredBy?: Date | null }) {
	const recipient = await database.organRecipient.findUnique({ where: { id: recipientId }, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true } });
	if (!recipient) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient record not found.");
	await assertInstitution(actor, recipient.institutionId);
	return database.$transaction(async (tx) => {
		const baseData = { organType: input.organType, bloodGroup: input.bloodGroup as never, priority: input.priority };
		await tx.organRecipient.update({ where: { id: recipientId }, data: baseData });
		await tx.recipientRequirement.upsert({
			where: { recipientId },
			create: { recipientId, organType: input.organType ?? recipient.organType, bloodGroup: input.bloodGroup === undefined ? recipient.bloodGroup : input.bloodGroup as never, priority: input.priority ?? recipient.priority, latitude: input.latitude, longitude: input.longitude, maximumDistanceKm: input.maximumDistanceKm, urgency: input.urgency, requiredBy: input.requiredBy },
			update: { organType: input.organType, bloodGroup: input.bloodGroup as never, priority: input.priority, latitude: input.latitude, longitude: input.longitude, maximumDistanceKm: input.maximumDistanceKm, urgency: input.urgency, requiredBy: input.requiredBy },
		});
		const affectedMatches = await tx.organMatch.findMany({ where: { recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } }, select: { id: true, organId: true } });
		if (affectedMatches.length) await tx.organMatch.updateMany({ where: { id: { in: affectedMatches.map(({ id }) => id) } }, data: { status: OrganMatchStatus.CANCELLED } });
		const organIds = [...new Set(affectedMatches.map(({ organId }) => organId))];
		for (const organId of organIds) await addEvent(tx, { organId, actor, eventType: "RECIPIENT_REQUIREMENT_UPDATED", metadata: { recipientReference: recipient.reference }, institutionIds: [recipient.institutionId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_RECIPIENT_UPDATED", entityType: "OrganRecipient", entityId: recipientId, metadata: { reference: recipient.reference, fields: Object.keys(input) } } });
		return tx.organRecipient.findUniqueOrThrow({ where: { id: recipientId }, include: { requirement: true } });
	});
}

export async function reviewOrganRecipient(actor: AuthContext, recipientId: string, decision: "APPROVE" | "REJECT", reason?: string) {
	const recipient = await database.organRecipient.findUnique({ where: { id: recipientId }, select: { id: true, reference: true, institutionId: true, userId: true, status: true } });
	if (!recipient) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient request not found.");
	await assertInstitution(actor, recipient.institutionId);
	if (recipient.status !== OrganRecipientStatus.PENDING_REVIEW) throw new ApiError(409, "RECIPIENT_NOT_PENDING", "Only recipient requests awaiting review can be approved or rejected.");
	const status = decision === "APPROVE" ? OrganRecipientStatus.ACTIVE : OrganRecipientStatus.REJECTED;
	return database.$transaction(async (tx) => {
		const changed = await tx.organRecipient.updateMany({ where: { id: recipient.id, status: OrganRecipientStatus.PENDING_REVIEW }, data: { status } });
		if (!changed.count) throw new ApiError(409, "RECIPIENT_NOT_PENDING", "This recipient request has already been reviewed.");
		const eventId = randomUUID();
		const eventType = decision === "APPROVE" ? "ORGAN_RECIPIENT_APPROVED" : "ORGAN_RECIPIENT_REJECTED";
		await tx.workflowEvent.create({ data: { id: eventId, eventType, actorId: actor.userId, actorInstitutionId: actor.institutionId, payload: { recipientId: recipient.id, reference: recipient.reference, reason: reason ?? null } } });
		if (recipient.userId) await tx.notification.create({ data: { userId: recipient.userId, eventId, eventType, title: decision === "APPROVE" ? "Recipient requirement approved" : "Recipient request not approved", message: decision === "APPROVE" ? "The receiving organ service approved your requirement for professional coordination review." : `The receiving organ service did not approve your request.${reason ? ` Reason: ${reason}` : ""}`, payload: { reference: recipient.reference, decision, reason: reason ?? null }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: eventType, entityType: "OrganRecipient", entityId: recipient.id, metadata: { reference: recipient.reference, reason: reason ?? null } } });
		return tx.organRecipient.findUniqueOrThrow({ where: { id: recipient.id }, select: { id: true, reference: true, status: true, updatedAt: true } });
	});
}
