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

import { ACTIVE_OFFER_STATUSES, addEvent, assertInstitution, findPreservationPolicy, requireInstitution } from './shared';
import { calculatePreservationClock } from "../inventories/organ-preservation.service";

export async function createOrganOffer(actor: AuthContext, input: { matchId: string; responseDeadline: Date; responseReason?: string }) {
	const match = await database.organMatch.findUnique({ where: { id: input.matchId }, include: { organ: { include: { donor: { select: { donorType: true } } } }, recipient: { select: { id: true, institutionId: true, reference: true } } } });
	if (!match) throw new ApiError(404, "ORGAN_MATCH_NOT_FOUND", "Potential coordination match not found.");
	await assertInstitution(actor, match.organ.institutionId);
	if (match.status !== OrganMatchStatus.SHORTLISTED) throw new ApiError(409, "MATCH_NOT_SHORTLISTED", "An authorized review and shortlist are required before creating an offer.");
	const posthumous = match.organ.donor.donorType === "POSTHUMOUS_INTENT";
	if (posthumous) {
		const policy = match.organ.preservationMethod ? await findPreservationPolicy(match.organ.organType, match.organ.preservationMethod, match.organ.institutionId) : null;
		if (match.organ.status !== OrganStatus.PRESERVING || !policy || calculatePreservationClock({ start: match.organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }).status === PreservationStatus.EXPIRED) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "A posthumous organ can be offered only while its preservation timeline is active.");
	} else if (match.organ.status !== OrganStatus.ELIGIBLE_FOR_COORDINATION && match.organ.status !== OrganStatus.MATCHING && match.organ.status !== OrganStatus.AVAILABLE) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "The organ is not available for an offer.");
	if (input.responseDeadline <= new Date()) throw new ApiError(400, "INVALID_RESPONSE_DEADLINE", "Offer response deadline must be in the future.");
	const prior = await database.organOffer.findFirst({ where: { matchId: match.id, status: { in: ACTIVE_OFFER_STATUSES } } });
	if (prior) throw new ApiError(409, "ACTIVE_OFFER_EXISTS", "An active offer already exists for this potential match.");
	return database.$transaction(async (tx) => {
		const reserved = await tx.organRecord.updateMany({ where: { id: match.organId, status: posthumous ? OrganStatus.PRESERVING : { in: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.MATCHING, OrganStatus.AVAILABLE] } }, data: { status: OrganStatus.OFFERED } });
		if (!reserved.count) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "The organ already has an active offer or is no longer available.");
		const offer = await tx.organOffer.create({ data: { reference: `OFF-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, organId: match.organId, recipientId: match.recipientId, matchId: match.id, offeringCentreId: match.organ.institutionId, receivingCentreId: match.recipient.institutionId, status: OrganOfferStatus.SENT, offeredAt: new Date(), responseDeadline: input.responseDeadline, responseReason: input.responseReason } });
		await tx.organMatch.update({ where: { id: match.id }, data: { status: OrganMatchStatus.CONVERTED_TO_OFFER } });
		await addEvent(tx, { organId: match.organId, actor, eventType: "ORGAN_OFFER_SENT", fromStatus: match.organ.status, toStatus: OrganStatus.OFFERED, metadata: { offerReference: offer.reference }, institutionIds: [match.recipient.institutionId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_OFFER_SENT", entityType: "OrganOffer", entityId: offer.id, metadata: { reference: offer.reference, receivingCentreId: match.recipient.institutionId } } });
		return offer;
	});
}
export async function listOrganOffers(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const offers = await database.organOffer.findMany({ where: institutionId ? { OR: [{ offeringCentreId: institutionId }, { receivingCentreId: institutionId }] } : undefined, include: { organ: { select: { id: true, reference: true, organType: true, status: true } }, recipient: { select: { reference: true } }, offeringCentre: { select: { name: true } }, receivingCentre: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
	return offers.map((offer) => ({ ...offer, canScheduleProcurement: offer.status === OrganOfferStatus.ACCEPTED && offer.organ.status === OrganStatus.ACCEPTED && (actor.role === "ADMINISTRATOR" || actor.institutionId === offer.offeringCentreId) }));
}
export async function respondToOrganOffer(actor: AuthContext, offerId: string, action: "ACCEPT" | "REJECT", responseReason?: string) {
	const offer = await database.organOffer.findUnique({ where: { id: offerId }, include: { organ: { select: { status: true, preservationStartTime: true, preservationMethod: true, organType: true, institutionId: true, donor: { select: { donorType: true } } } }, recipient: { select: { userId: true } } } });
	if (!offer) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	if (actor.principalType !== "USER" || !actor.userId || actor.userId !== offer.recipient.userId) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	if (!ACTIVE_OFFER_STATUSES.includes(offer.status)) throw new ApiError(409, "OFFER_NOT_RESPONDABLE", "This offer is no longer awaiting a response.");
	if (offer.responseDeadline <= new Date()) throw new ApiError(409, "OFFER_EXPIRED", "The offer response deadline has passed.");
	if (action === "ACCEPT" && offer.organ.donor.donorType === "POSTHUMOUS_INTENT") {
		const policy = offer.organ.preservationMethod ? await findPreservationPolicy(offer.organ.organType, offer.organ.preservationMethod, offer.organ.institutionId) : null;
		if (offer.organ.status !== OrganStatus.OFFERED || !policy || calculatePreservationClock({ start: offer.organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }).status === PreservationStatus.EXPIRED) throw new ApiError(409, "PRESERVATION_EXPIRED", "This organ's preservation timeline has ended; the offer can no longer be accepted.");
	}
	return database.$transaction(async (tx) => {
		const nextOffer = action === "ACCEPT" ? OrganOfferStatus.ACCEPTED : OrganOfferStatus.REJECTED;
		const preservedPosthumous = offer.organ.donor.donorType === "POSTHUMOUS_INTENT" && Boolean(offer.organ.preservationStartTime);
		const nextOrgan = action === "ACCEPT" ? preservedPosthumous ? OrganStatus.FINAL_ASSESSMENT : OrganStatus.ACCEPTED : preservedPosthumous ? OrganStatus.PRESERVING : OrganStatus.AVAILABLE;
		const now = new Date();
		const changedOffer = await tx.organOffer.updateMany({ where: { id: offerId, status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { gt: now } }, data: { status: nextOffer, respondedAt: now, responderId: actor.userId, responseReason } });
		if (!changedOffer.count) throw new ApiError(409, "OFFER_NOT_RESPONDABLE", "This offer has already received a response or expired.");
		const changedOrgan = await tx.organRecord.updateMany({ where: { id: offer.organId, status: OrganStatus.OFFERED }, data: { status: nextOrgan } });
		if (!changedOrgan.count) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "The organ is no longer awaiting this offer.");
		if (action === "ACCEPT") await tx.organRecipient.updateMany({ where: { id: offer.recipientId, status: OrganRecipientStatus.ACTIVE }, data: { status: OrganRecipientStatus.MATCHED } });
		await tx.organMatch.update({ where: { id: offer.matchId }, data: { status: action === "ACCEPT" ? OrganMatchStatus.CONVERTED_TO_OFFER : OrganMatchStatus.REJECTED } });
		await addEvent(tx, { organId: offer.organId, actor, eventType: action === "ACCEPT" ? "ORGAN_OFFER_ACCEPTED" : "ORGAN_OFFER_REJECTED", fromStatus: offer.organ.status, toStatus: nextOrgan, metadata: { offerReference: offer.reference }, institutionIds: [offer.offeringCentreId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: action === "ACCEPT" ? "ORGAN_OFFER_ACCEPTED" : "ORGAN_OFFER_REJECTED", entityType: "OrganOffer", entityId: offer.id, metadata: { status: nextOffer } } });
		return tx.organOffer.findUniqueOrThrow({ where: { id: offerId } });
	});
}

export async function updateOrganOfferStatus(actor: AuthContext, offerId: string, status: "UNDER_REVIEW" | "CANCELLED") {
	const offer = await database.organOffer.findUnique({ where: { id: offerId }, include: { organ: { select: { status: true, preservationStartTime: true, donor: { select: { donorType: true } } } } } });
	if (!offer) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	const receivingActor = actor.institutionId === offer.receivingCentreId && (actor.role === "ORGAN_CENTRE_USER" || actor.role === "HOSPITAL_USER" && actor.capabilities?.organ);
	const offeringActor = actor.institutionId === offer.offeringCentreId && actor.role === "ORGAN_CENTRE_USER";
	if (actor.role !== "ADMINISTRATOR" && (status === "UNDER_REVIEW" ? !receivingActor : !offeringActor)) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	if (!ACTIVE_OFFER_STATUSES.includes(offer.status)) throw new ApiError(409, "OFFER_NOT_UPDATABLE", "This offer is no longer active.");
	return database.$transaction(async (tx) => {
		const changed = await tx.organOffer.updateMany({ where: { id: offer.id, status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { gt: new Date() } }, data: { status, ...(status === "CANCELLED" ? { respondedAt: new Date(), responderId: actor.userId } : {}) } });
		if (!changed.count) throw new ApiError(409, "OFFER_NOT_UPDATABLE", "This offer has expired or already changed.");
		if (status === "CANCELLED") {
			const releaseStatus = offer.organ.donor?.donorType === "POSTHUMOUS_INTENT" && offer.organ.preservationStartTime ? OrganStatus.PRESERVING : OrganStatus.AVAILABLE;
			const released = await tx.organRecord.updateMany({ where: { id: offer.organId, status: OrganStatus.OFFERED }, data: { status: releaseStatus } });
			if (!released.count) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "The organ is no longer awaiting this offer.");
			await tx.organMatch.update({ where: { id: offer.matchId }, data: { status: OrganMatchStatus.SHORTLISTED } });
		}
		const releaseStatus = offer.organ.donor?.donorType === "POSTHUMOUS_INTENT" && offer.organ.preservationStartTime ? OrganStatus.PRESERVING : OrganStatus.AVAILABLE;
		await addEvent(tx, { organId: offer.organId, actor, eventType: status === "CANCELLED" ? "ORGAN_OFFER_CANCELLED" : "ORGAN_OFFER_UNDER_REVIEW", fromStatus: offer.organ.status, toStatus: status === "CANCELLED" ? releaseStatus : offer.organ.status, metadata: { offerReference: offer.reference }, institutionIds: [offer.offeringCentreId, offer.receivingCentreId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: status === "CANCELLED" ? "OFFER_CANCELLED" : "OFFER_UNDER_REVIEW", entityType: "OrganOffer", entityId: offer.id, metadata: { status } } });
		return tx.organOffer.findUniqueOrThrow({ where: { id: offer.id } });
	});
}
export async function expireOrganOffers(now = new Date()) {
	const expired = await database.organOffer.findMany({ where: { status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { lte: now } }, select: { id: true, reference: true, organId: true, matchId: true, offeringCentreId: true, receivingCentreId: true } });
	for (const offer of expired) {
		await database.$transaction(async (tx) => {
			const changed = await tx.organOffer.updateMany({ where: { id: offer.id, status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { lte: now } }, data: { status: OrganOfferStatus.EXPIRED, respondedAt: now } });
			if (!changed.count) return;
			const organ = await tx.organRecord.findUnique({ where: { id: offer.organId }, select: { status: true, preservationStartTime: true, donor: { select: { donorType: true } } } });
			const releaseStatus = organ?.donor?.donorType === "POSTHUMOUS_INTENT" && organ.preservationStartTime ? OrganStatus.PRESERVING : OrganStatus.AVAILABLE;
			if (organ?.status === OrganStatus.OFFERED) await tx.organRecord.update({ where: { id: offer.organId }, data: { status: releaseStatus } });
			await tx.organMatch.updateMany({ where: { id: offer.matchId, status: OrganMatchStatus.CONVERTED_TO_OFFER }, data: { status: OrganMatchStatus.EXPIRED } });
			await addEvent(tx, { organId: offer.organId, eventType: "ORGAN_OFFER_EXPIRED", fromStatus: organ?.status, toStatus: organ?.status === OrganStatus.OFFERED ? releaseStatus : organ?.status, metadata: { offerReference: offer.reference }, institutionIds: [offer.offeringCentreId, offer.receivingCentreId] });
			await tx.auditLog.create({ data: { action: "ORGAN_OFFER_EXPIRED", entityType: "OrganOffer", entityId: offer.id, metadata: { reference: offer.reference } } });
		});
	}
	return expired.length;
}
export async function getOrganOffer(actor: AuthContext, offerId: string) {
	const offer = await database.organOffer.findUnique({ where: { id: offerId }, include: { organ: { select: { id: true, reference: true, organType: true, status: true, events: { orderBy: { createdAt: "asc" } } } }, recipient: { select: { reference: true } }, offeringCentre: { select: { name: true } }, receivingCentre: { select: { name: true } } } });
	if (!offer || actor.role !== "ADMINISTRATOR" && actor.institutionId !== offer.offeringCentreId && actor.institutionId !== offer.receivingCentreId) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	return { ...offer, canScheduleProcurement: offer.status === OrganOfferStatus.ACCEPTED && offer.organ.status === OrganStatus.ACCEPTED && (actor.role === "ADMINISTRATOR" || actor.institutionId === offer.offeringCentreId) };
}
