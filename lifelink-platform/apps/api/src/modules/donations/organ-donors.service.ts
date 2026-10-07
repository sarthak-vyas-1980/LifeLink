import { randomUUID } from "node:crypto";
import {
	ConsentStatus,
	NotificationStatus,
	NotificationType,
	OrganAuthorizationStatus,
	OrganDonorStatus,
	OrganMatchStatus,
	OrganOfferStatus,
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

import { assertInstitution, requireInstitution } from '../organ-coordination/shared';

export async function verifyDonorConsent(actor: AuthContext, donorId: string) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, institutionId: true, reference: true, consentStatus: true, authorizationStatus: true } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, donor.institutionId);
	if (donor.consentStatus !== ConsentStatus.ACCEPTED) throw new ApiError(409, "CONSENT_NOT_ACCEPTED", "User acceptance is required before institutional verification.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const updated = await tx.organDonor.update({ where: { id: donor.id }, data: { consentStatus: ConsentStatus.VERIFIED, consentDate: now }, include: { consents: true } });
		await tx.organConsent.updateMany({ where: { donorId: donor.id, status: ConsentStatus.ACCEPTED }, data: { status: ConsentStatus.VERIFIED, verifiedAt: now, authorizedById: actor.userId } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "CONSENT_VERIFIED", entityType: "OrganDonor", entityId: donor.id, metadata: { reference: donor.reference } } });
		return updated;
	});
}

export async function updateOrganDonor(actor: AuthContext, donorId: string, input: { donorType?: string; bloodGroup?: string | null }) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, institutionId: true } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, donor.institutionId);
	return database.$transaction(async (tx) => {
		const updated = await tx.organDonor.update({ where: { id: donorId }, data: { donorType: input.donorType, bloodGroup: input.bloodGroup as never }, select: { id: true, reference: true, donorType: true, bloodGroup: true, consentStatus: true, authorizationStatus: true, status: true, updatedAt: true } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_DONOR_UPDATED", entityType: "OrganDonor", entityId: donorId, metadata: { fields: Object.keys(input) } } });
		return updated;
	});
}
export async function authorizeOrganDonor(actor: AuthContext, donorId: string, status: "AUTHORIZED" | "REJECTED" | "WITHDRAWN") {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, institutionId: true, userId: true, reference: true, consentStatus: true, authorizationStatus: true } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, donor.institutionId);
	if (status === "AUTHORIZED" && donor.consentStatus !== ConsentStatus.VERIFIED) throw new ApiError(409, "CONSENT_NOT_VERIFIED", "Verified consent is required before authorization.");
	const canReject = status === "REJECTED" && donor.authorizationStatus === OrganAuthorizationStatus.PENDING;
	const canWithdraw = status === "WITHDRAWN" && donor.authorizationStatus === OrganAuthorizationStatus.AUTHORIZED;
	if (status === "AUTHORIZED" && donor.authorizationStatus !== OrganAuthorizationStatus.PENDING || status === "REJECTED" && !canReject || status === "WITHDRAWN" && !canWithdraw) throw new ApiError(409, "AUTHORIZATION_FINALIZED", "This authorization cannot be changed from its current state.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const rejectUnverifiedConsent = status === "REJECTED" && donor.consentStatus !== ConsentStatus.VERIFIED;
		const updated = await tx.organDonor.update({ where: { id: donor.id }, data: { authorizationStatus: status, ...(status === "AUTHORIZED" ? { authorizationDate: now } : {}), ...(rejectUnverifiedConsent ? { consentStatus: ConsentStatus.REJECTED } : {}), ...(status === "WITHDRAWN" ? { consentStatus: ConsentStatus.WITHDRAWN } : {}), status: status === "AUTHORIZED" ? OrganDonorStatus.ACTIVE : OrganDonorStatus.CLOSED } });
		if (rejectUnverifiedConsent) await tx.organConsent.updateMany({ where: { donorId, status: { in: [ConsentStatus.PENDING, ConsentStatus.RECORDED] } }, data: { status: ConsentStatus.REJECTED } });
		if (status === "WITHDRAWN") await tx.organConsent.updateMany({ where: { donorId, status: { in: [ConsentStatus.RECORDED, ConsentStatus.VERIFIED] } }, data: { status: ConsentStatus.WITHDRAWN } });
		const eventId = randomUUID();
		const eventType = `DONOR_AUTHORIZATION_${status}`;
		await tx.workflowEvent.create({ data: { id: eventId, eventType, actorId: actor.userId, actorInstitutionId: actor.institutionId, payload: { reference: donor.reference } } });
		if (donor.userId) await tx.notification.create({ data: { userId: donor.userId, eventId, eventType, title: status === "AUTHORIZED" ? "Donor interest approved" : status === "REJECTED" ? "Donor request not approved" : "Donor authorization withdrawn", message: status === "AUTHORIZED" ? "The organ service completed its consent review and authorized your donor profile." : status === "REJECTED" ? "The organ service did not approve your donor request." : "The organ service withdrew the donor authorization. Contact the institution for next steps.", payload: { reference: donor.reference, status }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: eventType, entityType: "OrganDonor", entityId: donorId, metadata: { reference: donor.reference } } });
		return updated;
	});
}
export async function withdrawDonorConsent(actor: AuthContext, donorId: string) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, institutionId: true, reference: true, consentStatus: true } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, donor.institutionId);
	const withdrawableStatuses: ConsentStatus[] = [ConsentStatus.RECORDED, ConsentStatus.VERIFIED];
	if (!withdrawableStatuses.includes(donor.consentStatus)) throw new ApiError(409, "CONSENT_NOT_WITHDRAWABLE", "Consent is not in a withdrawable state.");
	return database.$transaction(async (tx) => {
		const updated = await tx.organDonor.update({ where: { id: donor.id }, data: { consentStatus: ConsentStatus.WITHDRAWN, authorizationStatus: OrganAuthorizationStatus.WITHDRAWN, status: OrganDonorStatus.CLOSED } });
		await tx.organConsent.updateMany({ where: { donorId, status: { in: [ConsentStatus.RECORDED, ConsentStatus.VERIFIED] } }, data: { status: ConsentStatus.WITHDRAWN } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_CONSENT_WITHDRAWN", entityType: "OrganDonor", entityId: donorId, metadata: { reference: donor.reference } } });
		return updated;
	});
}
export type OrganWorkflowStage = "REVIEW" | "MATCHING" | "OFFER" | "PROCUREMENT" | "COMPLETED" | "REJECTED" | "CANCELLED" | "EXPIRED";
export async function listOrganDonors(actor: AuthContext, filters: { q?: string; status?: string; consentStatus?: ConsentStatus; stage?: OrganWorkflowStage } = {}) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const clauses: Prisma.OrganDonorWhereInput[] = [institutionId ? { institutionId } : {}];
	if (filters.status) clauses.push({ status: filters.status as OrganDonorStatus });
	if (filters.consentStatus) clauses.push({ consentStatus: filters.consentStatus });
	if (filters.stage) {
		const stageWhere: Record<OrganWorkflowStage, Prisma.OrganDonorWhereInput> = {
			REVIEW: { status: OrganDonorStatus.REGISTERED },
			MATCHING: { organs: { some: { status: { in: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.AVAILABLE, OrganStatus.MATCHING] } } } },
			OFFER: { organs: { some: { OR: [{ status: { in: [OrganStatus.OFFERED, OrganStatus.ACCEPTED] } }, { offers: { some: { status: { in: [OrganOfferStatus.SENT, OrganOfferStatus.UNDER_REVIEW, OrganOfferStatus.ACCEPTED] } } } }] } } },
			PROCUREMENT: { organs: { some: { OR: [{ status: { in: [OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.RETRIEVED, OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED] } }, { procurements: { some: { status: { in: [ProcurementStatus.SCHEDULED, ProcurementStatus.IN_PROGRESS, ProcurementStatus.COMPLETED] } } } }] } } },
			COMPLETED: { OR: [{ status: OrganDonorStatus.CLOSED }, { organs: { some: { status: { in: [OrganStatus.TRANSPLANTED, OrganStatus.COMPLETED] } } } }] },
			REJECTED: { authorizationStatus: OrganAuthorizationStatus.REJECTED },
			CANCELLED: { OR: [{ authorizationStatus: OrganAuthorizationStatus.WITHDRAWN }, { consentStatus: ConsentStatus.WITHDRAWN }, { organs: { some: { status: OrganStatus.CANCELLED } } }] },
			EXPIRED: { OR: [{ consentStatus: ConsentStatus.EXPIRED }, { organs: { some: { status: OrganStatus.EXPIRED } } }] },
		};
		clauses.push(stageWhere[filters.stage]);
	}
	if (filters.q) clauses.push({ reference: { contains: filters.q, mode: "insensitive" as const } });
	const donors = await database.organDonor.findMany({ where: { AND: clauses }, select: { id: true, reference: true, institutionId: true, donorType: true, organType: true, bloodGroup: true, consentStatus: true, authorizationStatus: true, status: true, createdAt: true, user: { select: { name: true, phone: true, email: true } }, institution: { select: { name: true } }, organs: { select: { status: true, matches: { select: { status: true } }, offers: { select: { status: true } }, procurements: { select: { status: true } } } } }, orderBy: { createdAt: "desc" }, take: 100 });
	return donors.map(({ user, organs, ...donor }) => ({ ...donor, workflowStage: donorWorkflowStage({ ...donor, organs }), contactName: user?.name ?? null, contactPhone: user?.phone ?? null, contactEmail: user?.email ?? null }));
}

function donorWorkflowStage(donor: { consentStatus: ConsentStatus; authorizationStatus: OrganAuthorizationStatus; status: OrganDonorStatus; organs: Array<{ status: OrganStatus; matches: Array<{ status: OrganMatchStatus }>; offers: Array<{ status: OrganOfferStatus }>; procurements: Array<{ status: ProcurementStatus }> }> }) {
	const organ = donor.organs[0];
	const is = (values: readonly string[], value: string | undefined) => value !== undefined && values.includes(value);
	if (is([OrganStatus.COMPLETED, OrganStatus.TRANSPLANTED], organ?.status)) return "FULFILLED";
	if (organ?.status === OrganStatus.EXPIRED || donor.consentStatus === ConsentStatus.EXPIRED) return "EXPIRED";
	if (is([OrganStatus.UNAVAILABLE, OrganStatus.DISCARDED], organ?.status) || donor.authorizationStatus === OrganAuthorizationStatus.REJECTED) return "UNAVAILABLE";
	if (donor.consentStatus === ConsentStatus.REJECTED || donor.consentStatus === ConsentStatus.DECLINED) return "REJECTED";
	if (donor.status === OrganDonorStatus.CLOSED || donor.consentStatus === ConsentStatus.WITHDRAWN || donor.authorizationStatus === OrganAuthorizationStatus.WITHDRAWN) return "CANCELLED";
	if (organ?.procurements.some((item) => item.status === ProcurementStatus.COMPLETED) || is([OrganStatus.RETRIEVED, OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED], organ?.status)) return "PROCUREMENT_COMPLETED";
	if (organ?.procurements.some((item) => item.status === ProcurementStatus.IN_PROGRESS) || is([OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.RETRIEVAL_IN_PROGRESS], organ?.status)) return "PROCUREMENT_IN_PROGRESS";
	if (organ?.offers.some((item) => item.status === OrganOfferStatus.ACCEPTED)) return "OFFER_ACCEPTED";
	if (organ?.offers.some((item) => item.status === OrganOfferStatus.UNDER_REVIEW)) return "OFFER_EVALUATION";
	if (organ?.offers.some((item) => item.status === OrganOfferStatus.SENT)) return "OFFER_SENT";
	if (organ?.matches.some((item) => [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED, OrganMatchStatus.CONVERTED_TO_OFFER].some((status) => status === item.status))) return "POTENTIAL_MATCHES";
	if (is([OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.AVAILABLE, OrganStatus.MATCHING], organ?.status) || donor.authorizationStatus === OrganAuthorizationStatus.AUTHORIZED) return "MATCHING";
	return "UNDER_REVIEW";
}
export async function getOrganDonor(actor: AuthContext, donorId: string) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, reference: true, institutionId: true, donorType: true, organType: true, bloodGroup: true, consentStatus: true, authorizationStatus: true, consentDate: true, authorizationDate: true, status: true, createdAt: true, user: { select: { name: true, phone: true, email: true } }, consents: { select: { id: true, status: true, consentType: true, recordedAt: true, verifiedAt: true, requestedAt: true, respondedAt: true, documentReference: true, notes: true, createdAt: true } }, organs: { select: { id: true, reference: true, organType: true, status: true, createdAt: true, matches: { select: { status: true } }, offers: { select: { status: true } }, procurements: { select: { status: true } } } } } });
	if (!donor || actor.role !== "ADMINISTRATOR" && actor.institutionId !== donor.institutionId) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	return { ...donor, workflowStage: donorWorkflowStage(donor) };
}
