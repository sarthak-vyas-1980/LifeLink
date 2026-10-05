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

const ACTIVE_OFFER_STATUSES: OrganOfferStatus[] = [OrganOfferStatus.SENT, OrganOfferStatus.UNDER_REVIEW];
const ORGAN_TRANSITIONS: Record<OrganStatus, OrganStatus[]> = {
	REGISTERED: [OrganStatus.ASSESSMENT_PENDING, OrganStatus.CANCELLED],
	ASSESSMENT_PENDING: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.UNAVAILABLE],
	ELIGIBLE_FOR_COORDINATION: [OrganStatus.AVAILABLE, OrganStatus.UNAVAILABLE],
	AVAILABLE: [OrganStatus.MATCHING, OrganStatus.UNAVAILABLE, OrganStatus.CANCELLED],
	MATCHING: [OrganStatus.OFFERED, OrganStatus.AVAILABLE, OrganStatus.UNAVAILABLE],
	OFFERED: [OrganStatus.ACCEPTED, OrganStatus.AVAILABLE, OrganStatus.EXPIRED, OrganStatus.CANCELLED],
	ACCEPTED: [OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.CANCELLED],
	RETRIEVAL_SCHEDULED: [OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.CANCELLED],
	RETRIEVAL_IN_PROGRESS: [OrganStatus.RETRIEVED, OrganStatus.CANCELLED, OrganStatus.UNAVAILABLE],
	RETRIEVED: [OrganStatus.PRESERVING],
	PRESERVING: [OrganStatus.IN_TRANSIT, OrganStatus.UNAVAILABLE, OrganStatus.EXPIRED],
	IN_TRANSIT: [OrganStatus.ARRIVED, OrganStatus.EXPIRED],
	ARRIVED: [OrganStatus.FINAL_ASSESSMENT],
	FINAL_ASSESSMENT: [OrganStatus.ALLOCATED, OrganStatus.UNAVAILABLE],
	ALLOCATED: [OrganStatus.TRANSPLANTED],
	TRANSPLANTED: [OrganStatus.COMPLETED],
	COMPLETED: [], UNAVAILABLE: [OrganStatus.CANCELLED], EXPIRED: [], DISCARDED: [], CANCELLED: [],
};

export function isOrganTransitionAllowed(from: OrganStatus, to: OrganStatus) {
	return ORGAN_TRANSITIONS[from].includes(to);
}

type Tx = Prisma.TransactionClient;
type OrganEvent = { organId: string; actor?: Pick<AuthContext, "userId" | "institutionId" | "capabilities">; eventType: string; fromStatus?: string; toStatus?: string; metadata?: Record<string, string | number | boolean | null>; institutionIds?: string[] };

function requireInstitution(actor: AuthContext) {
	if (actor.role !== "ADMINISTRATOR" && (!actor.institutionId || (actor.role !== "ORGAN_CENTRE_USER" && !(actor.role === "HOSPITAL_USER" && actor.capabilities?.organ)))) {
		throw new ApiError(403, "ORGAN_CENTRE_REQUIRED", "Organ-centre access is required.");
	}
	return actor.institutionId;
}

async function addEvent(tx: Tx, event: OrganEvent) {
	const safeMetadata = event.metadata ?? {};
	await tx.organWorkflowEvent.create({ data: {
		organId: event.organId,
		actorId: event.actor?.userId,
		institutionId: event.actor?.institutionId,
		eventType: event.eventType,
		fromStatus: event.fromStatus,
		toStatus: event.toStatus,
		metadata: safeMetadata as Prisma.InputJsonObject,
	} });
	const eventId = randomUUID();
	await tx.workflowEvent.create({
		data: { id: eventId, eventType: event.eventType, actorId: event.actor?.userId, actorInstitutionId: event.actor?.institutionId, payload: { organId: event.organId, ...safeMetadata } as Prisma.InputJsonObject },
	});
	const institutionIds = [...new Set([event.actor?.institutionId, ...(event.institutionIds ?? [])].filter((id): id is string => Boolean(id)))];
	const administrators = await tx.user.findMany({ where: { status: "ACTIVE", role: "ADMIN" }, select: { id: true } });
	const institutionAccounts = institutionIds.length ? await tx.institutionAccount.findMany({ where: { institutionId: { in: institutionIds } }, select: { institutionId: true } }) : [];
	if (administrators.length || institutionAccounts.length) {
		await tx.notification.createMany({
			data: [
				...administrators.map(({ id }) => ({ userId: id })),
				...institutionAccounts.map(({ institutionId }) => ({ institutionId })),
			].map((recipient) => ({ ...recipient, eventId, eventType: event.eventType, title: organEventTitle(event.eventType), message: `Organ workflow ${event.eventType.toLowerCase().replaceAll("_", " ")}.`, payload: { organId: event.organId, ...safeMetadata } as Prisma.InputJsonObject, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD })),
			skipDuplicates: true,
		});
	}
}

function organEventTitle(type: string) {
	const labels: Record<string, string> = { ORGAN_CREATED: "Organ record created", ORGAN_STATUS_CHANGED: "Organ status updated", ORGAN_MATCH_GENERATED: "Potential coordination matches generated", ORGAN_OFFER_SENT: "Organ offer sent", ORGAN_OFFER_ACCEPTED: "Organ offer accepted", ORGAN_OFFER_REJECTED: "Organ offer rejected", ORGAN_OFFER_EXPIRED: "Organ offer expired", ORGAN_PRESERVATION_STARTED: "Preservation timing started", PRESERVATION_WARNING: "Preservation timer warning", PRESERVATION_CRITICAL: "Preservation timer critical", PRESERVATION_EXPIRED: "Configured preservation timer expired" };
	return labels[type] ?? "Organ coordination update";
}

async function assertInstitution(actor: AuthContext, institutionId: string) {
	const institution = await database.institution.findUnique({ where: { id: institutionId }, select: { id: true, type: true, status: true, hospitalProfile: { select: { organService: { select: { id: true } } } } } });
	const hasOrganCapability = institution?.type === "ORGAN_CENTRE" || institution?.type === "HOSPITAL" && Boolean(institution.hospitalProfile?.organService);
	if (!institution || !hasOrganCapability || institution.status !== "ACTIVE" || actor.role !== "ADMINISTRATOR" && (actor.institutionId !== institutionId || actor.role === "HOSPITAL_USER" && !actor.capabilities?.organ || actor.role !== "HOSPITAL_USER" && actor.role !== "ORGAN_CENTRE_USER")) {
		throw new ApiError(404, "ORGAN_RESOURCE_NOT_FOUND", "Organ coordination record not found.");
	}
}

async function findPreservationPolicy(organType: OrganType, method: PreservationMethod, institutionId: string) {
	const policies = await database.organPreservationPolicy.findMany({ where: { organType, method, active: true, OR: [{ institutionId }, { institutionId: null }] } });
	return policies.find((policy) => policy.institutionId === institutionId) ?? policies.find((policy) => policy.institutionId === null) ?? null;
}

export async function createOrganDonor(actor: AuthContext, input: { institutionId?: string; donorType: string; bloodGroup?: string; consentType: string; documentReference?: string }) {
	const institutionId = requireInstitution(actor) ?? input.institutionId;
	if (!institutionId) throw new ApiError(400, "INSTITUTION_REQUIRED", "An organ centre is required.");
	await assertInstitution(actor, institutionId);
	return database.$transaction(async (tx) => {
		const donor = await tx.organDonor.create({ data: {
			reference: `DNR-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`,
			institutionId, donorType: input.donorType, bloodGroup: input.bloodGroup as never,
			status: OrganDonorStatus.REGISTERED, userId: undefined,
			consents: { create: { consentType: input.consentType, documentReference: input.documentReference, status: ConsentStatus.RECORDED, recordedAt: new Date() } },
		}, include: { consents: true } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_DONOR_CREATED", entityType: "OrganDonor", entityId: donor.id, metadata: { reference: donor.reference } } });
		return donor;
	});
}

export async function verifyDonorConsent(actor: AuthContext, donorId: string) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, institutionId: true, reference: true, consentStatus: true, authorizationStatus: true } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, donor.institutionId);
	if (donor.consentStatus !== ConsentStatus.RECORDED) throw new ApiError(409, "CONSENT_NOT_RECORDED", "Recorded consent is required before verification.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const updated = await tx.organDonor.update({ where: { id: donor.id }, data: { consentStatus: ConsentStatus.VERIFIED, authorizationStatus: OrganAuthorizationStatus.AUTHORIZED, consentDate: now, authorizationDate: now, status: OrganDonorStatus.ACTIVE }, include: { consents: true } });
		await tx.organConsent.updateMany({ where: { donorId: donor.id, status: ConsentStatus.RECORDED }, data: { status: ConsentStatus.VERIFIED, verifiedAt: now, authorizedById: actor.userId } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "CONSENT_VERIFIED", entityType: "OrganDonor", entityId: donor.id, metadata: { reference: donor.reference } } });
		return updated;
	});
}

export async function createOrganRecord(actor: AuthContext, input: { organType: OrganType; donorId: string; institutionId?: string; bloodGroup?: string; notes?: string }) {
	const institutionId = requireInstitution(actor) ?? input.institutionId;
	if (!institutionId) throw new ApiError(400, "INSTITUTION_REQUIRED", "An organ centre is required.");
	await assertInstitution(actor, institutionId);
	const donor = await database.organDonor.findUnique({ where: { id: input.donorId }, select: { id: true, institutionId: true, consentStatus: true, authorizationStatus: true } });
	if (!donor || donor.institutionId !== institutionId) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	if (donor.consentStatus !== ConsentStatus.VERIFIED || donor.authorizationStatus !== OrganAuthorizationStatus.AUTHORIZED) throw new ApiError(409, "DONOR_NOT_AUTHORIZED", "Verified donor authorization is required.");
	return database.$transaction(async (tx) => {
		const organ = await tx.organRecord.create({ data: { reference: `ORG-${input.organType.slice(0, 3)}-${randomUUID().slice(0, 8).toUpperCase()}`, institutionId, currentLocationId: institutionId, donorId: donor.id, organType: input.organType, bloodGroup: input.bloodGroup as never, status: OrganStatus.ASSESSMENT_PENDING, notes: input.notes } });
		await addEvent(tx, { organId: organ.id, actor, eventType: "ORGAN_CREATED", toStatus: organ.status, metadata: { reference: organ.reference } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_CREATED", entityType: "OrganRecord", entityId: organ.id, metadata: { reference: organ.reference, organType: organ.organType } } });
		return organ;
	});
}

export async function transitionOrgan(actor: AuthContext, organId: string, toStatus: OrganStatus) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, status: true, reference: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (!isOrganTransitionAllowed(organ.status, toStatus)) throw new ApiError(409, "INVALID_ORGAN_TRANSITION", "The requested organ workflow transition is not allowed.");
	return database.$transaction(async (tx) => {
		const updated = await tx.organRecord.update({ where: { id: organ.id }, data: { status: toStatus } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_STATUS_CHANGED", fromStatus: organ.status, toStatus, metadata: { reference: organ.reference } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_STATUS_CHANGED", entityType: "OrganRecord", entityId: organ.id, metadata: { fromStatus: organ.status, toStatus } } });
		return updated;
	});
}

export async function listOrgans(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const records = await database.organRecord.findMany({ where: institutionId ? { OR: [{ institutionId }, { destinationCentreId: institutionId }] } : undefined, include: { donor: { select: { id: true, reference: true, consentStatus: true, authorizationStatus: true } }, currentLocation: { select: { id: true, name: true } }, destinationCentre: { select: { id: true, name: true } }, offers: { select: { id: true, status: true, responseDeadline: true } }, events: { orderBy: { createdAt: "asc" } }, }, orderBy: { updatedAt: "desc" }, take: 100 });
	return attachPreservationClocks(records);
}

async function attachPreservationClocks<T extends { id: string; organType: OrganType; institutionId: string; preservationMethod: PreservationMethod | null; preservationStartTime: Date | null }>(records: T[]) {
	const organTypes = [...new Set(records.map((record) => record.organType))];
	const methods = [...new Set(records.flatMap((record) => record.preservationMethod ? [record.preservationMethod] : []))];
	const policies = organTypes.length && methods.length ? await database.organPreservationPolicy.findMany({ where: { organType: { in: organTypes }, method: { in: methods }, active: true, OR: [{ institutionId: { in: [...new Set(records.map((record) => record.institutionId))] } }, { institutionId: null }] } }) : [];
	return records.map((organ) => {
		const policy = organ.preservationMethod ? policies.find((candidate) => candidate.organType === organ.organType && candidate.method === organ.preservationMethod && candidate.institutionId === organ.institutionId) ?? policies.find((candidate) => candidate.organType === organ.organType && candidate.method === organ.preservationMethod && candidate.institutionId === null) : undefined;
		return { ...organ, preservation: policy ? { policyLabel: policy.label, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, ...calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }) } : { status: PreservationStatus.NOT_STARTED, elapsedMs: 0, remainingMs: 0, policyLabel: null } };
	});
}

export async function listOrganDonors(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organDonor.findMany({ where: institutionId ? { institutionId } : undefined, select: { id: true, reference: true, institutionId: true, donorType: true, consentStatus: true, authorizationStatus: true, status: true, createdAt: true, _count: { select: { organs: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function generateOrganMatches(actor: AuthContext, organId: string, radiusKm?: number) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, include: { institution: { select: { latitude: true, longitude: true } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (organ.status !== OrganStatus.AVAILABLE && organ.status !== OrganStatus.MATCHING) throw new ApiError(409, "ORGAN_NOT_AVAILABLE", "Only available organs can be considered for coordination matching.");
	const requirements = await database.recipientRequirement.findMany({ where: { organType: organ.organType, recipient: { status: "ACTIVE" } }, include: { recipient: { include: { institution: { select: { id: true, name: true, latitude: true, longitude: true } } } } } });
	const candidates = requirements.flatMap((requirement) => {
		if (requirement.bloodGroup && organ.bloodGroup && requirement.bloodGroup !== organ.bloodGroup) return [];
		const hasCoordinates = organ.institution.latitude !== null && organ.institution.longitude !== null && requirement.latitude !== null && requirement.longitude !== null;
		const distanceKm = hasCoordinates ? calculateDistance(organ.institution.latitude!, organ.institution.longitude!, requirement.latitude!, requirement.longitude!) : undefined;
		if (radiusKm !== undefined && (distanceKm === undefined || distanceKm > radiusKm)) return [];
		if (requirement.maximumDistanceKm !== null && distanceKm !== undefined && distanceKm > requirement.maximumDistanceKm) return [];
		const priorityScore = requirement.priority === RequestPriority.EMERGENCY ? 40 : requirement.priority === RequestPriority.URGENT ? 25 : 10;
		const distanceScore = distanceKm === undefined ? 0 : Math.max(0, 30 - Math.min(distanceKm, 300) / 10);
		const reasons = ["organ type matches the active recipient requirement", ...(requirement.bloodGroup && organ.bloodGroup ? ["blood group matches the configured filter"] : []), ...(distanceKm === undefined ? [] : ["location is within the configured search range"]), `coordination priority: ${requirement.priority.toLowerCase()}`];
		return [{ requirement, distanceKm, score: Math.round((priorityScore + distanceScore) * 100) / 100, reasons }];
	}).sort((a, b) => b.score - a.score);
	await database.$transaction(async (tx) => {
		const saved = [];
		for (const candidate of candidates) {
			const prior = await tx.organMatch.findFirst({ where: { organId, recipientId: candidate.requirement.recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } } });
			if (prior) { saved.push({ ...prior, distanceKm: candidate.distanceKm }); continue; }
			saved.push(await tx.organMatch.create({ data: { organId, recipientId: candidate.requirement.recipientId, coordinationScore: candidate.score, matchReasons: candidate.reasons, criteriaSnapshot: { organType: organ.organType, bloodGroupFilterApplied: Boolean(candidate.requirement.bloodGroup && organ.bloodGroup), distanceKm: candidate.distanceKm ?? null, priority: candidate.requirement.priority, radiusKm: radiusKm ?? null } } }));
		}
		if (candidates.length && organ.status === OrganStatus.AVAILABLE) await tx.organRecord.update({ where: { id: organId }, data: { status: OrganStatus.MATCHING } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_MATCH_GENERATED", fromStatus: organ.status, toStatus: candidates.length ? OrganStatus.MATCHING : organ.status, metadata: { candidateCount: candidates.length } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_MATCH_GENERATED", entityType: "OrganRecord", entityId: organId, metadata: { candidateCount: candidates.length } } });
	});
	const matches = await database.organMatch.findMany({ where: { organId }, include: { recipient: { select: { reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } });
	return { label: "Potential Coordination Matches", matches, clinicalDecision: false as const };
}

export function calculatePreservationClock(input: { start: Date | null; maximumHours: number; warningHours: number; criticalHours: number; now?: Date }) {
	if (!input.start) return { status: PreservationStatus.NOT_STARTED, elapsedMs: 0, remainingMs: input.maximumHours * 3_600_000 };
	const elapsedMs = Math.max(0, (input.now ?? new Date()).getTime() - input.start.getTime());
	const remainingMs = input.maximumHours * 3_600_000 - elapsedMs;
	const status = remainingMs <= 0 ? PreservationStatus.EXPIRED : remainingMs <= input.criticalHours * 3_600_000 ? PreservationStatus.CRITICAL : remainingMs <= input.warningHours * 3_600_000 ? PreservationStatus.WARNING : PreservationStatus.NORMAL;
	return { status, elapsedMs, remainingMs: Math.max(0, remainingMs) };
}

export async function startOrganPreservation(actor: AuthContext, organId: string, input: { method: PreservationMethod; solution?: string }) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, status: true, organType: true, preservationStartTime: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (organ.status !== OrganStatus.RETRIEVED || organ.preservationStartTime) throw new ApiError(409, "PRESERVATION_NOT_ALLOWED", "Preservation can start once retrieval is recorded.");
	const policy = await findPreservationPolicy(organ.organType, input.method, organ.institutionId);
	if (!policy) throw new ApiError(409, "PRESERVATION_POLICY_REQUIRED", "An active configurable operational timing policy is required.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const updated = await tx.organRecord.update({ where: { id: organId }, data: { status: OrganStatus.PRESERVING, preservationStartTime: now, coldIschemiaStart: now, preservationMethod: input.method, preservationSolution: input.solution } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_PRESERVATION_STARTED", fromStatus: organ.status, toStatus: OrganStatus.PRESERVING, metadata: { method: input.method, policyLabel: policy.label } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_PRESERVATION_STARTED", entityType: "OrganRecord", entityId: organId, metadata: { method: input.method, policyLabel: policy.label } } });
		return { organ: updated, policy: { method: policy.method, targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label }, clock: calculatePreservationClock({ start: now, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }) };
	});
}

export async function getOrganPreservation(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, destinationCentreId: true, organType: true, preservationStartTime: true, preservationMethod: true, currentLocation: { select: { name: true } }, destinationCentre: { select: { name: true } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId && actor.institutionId !== organ.destinationCentreId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (!organ.preservationMethod) return { organ, policy: null, clock: { status: PreservationStatus.NOT_STARTED, elapsedMs: 0, remainingMs: 0 }, disclaimer: "Operational timing indicator; clinical suitability is determined by authorized professionals." };
	const policy = await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId);
	if (!policy) return { organ, policy: null, clock: null, disclaimer: "Operational timing policy is not configured." };
	return { organ, policy: { targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label }, clock: calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }), disclaimer: "Operational timing indicator; clinical suitability is determined by authorized professionals." };
}

export async function listOrganRecipients(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organRecipient.findMany({ where: institutionId ? { institutionId } : undefined, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, institution: { select: { name: true } }, requirement: true }, orderBy: [{ priority: "desc" }, { registrationDate: "asc" }], take: 100 });
}

export async function reviewOrganMatch(actor: AuthContext, matchId: string, status: "UNDER_REVIEW" | "SHORTLISTED" | "REJECTED") {
	const match = await database.organMatch.findUnique({ where: { id: matchId }, include: { organ: { select: { institutionId: true } } } });
	if (!match) throw new ApiError(404, "ORGAN_MATCH_NOT_FOUND", "Potential coordination match not found.");
	await assertInstitution(actor, match.organ.institutionId);
	const reviewableStatuses: OrganMatchStatus[] = [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED];
	if (!reviewableStatuses.includes(match.status)) throw new ApiError(409, "MATCH_NOT_REVIEWABLE", "This potential match can no longer be reviewed.");
	return database.$transaction(async (tx) => {
		const updated = await tx.organMatch.update({ where: { id: match.id }, data: { status, reviewedAt: new Date(), reviewedById: actor.userId } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_MATCH_REVIEWED", entityType: "OrganMatch", entityId: match.id, metadata: { status } } });
		return updated;
	});
}

export async function createOrganOffer(actor: AuthContext, input: { matchId: string; responseDeadline: Date; responseReason?: string }) {
	const match = await database.organMatch.findUnique({ where: { id: input.matchId }, include: { organ: true, recipient: { select: { id: true, institutionId: true, reference: true } } } });
	if (!match) throw new ApiError(404, "ORGAN_MATCH_NOT_FOUND", "Potential coordination match not found.");
	await assertInstitution(actor, match.organ.institutionId);
	if (match.status !== OrganMatchStatus.SHORTLISTED) throw new ApiError(409, "MATCH_NOT_SHORTLISTED", "An authorized review and shortlist are required before creating an offer.");
	if (match.organ.status !== OrganStatus.MATCHING && match.organ.status !== OrganStatus.AVAILABLE) throw new ApiError(409, "ORGAN_NOT_OFFERABLE", "The organ is not available for an offer.");
	if (input.responseDeadline <= new Date()) throw new ApiError(400, "INVALID_RESPONSE_DEADLINE", "Offer response deadline must be in the future.");
	const prior = await database.organOffer.findFirst({ where: { matchId: match.id, status: { in: ACTIVE_OFFER_STATUSES } } });
	if (prior) throw new ApiError(409, "ACTIVE_OFFER_EXISTS", "An active offer already exists for this potential match.");
	return database.$transaction(async (tx) => {
		const offer = await tx.organOffer.create({ data: { reference: `OFF-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, organId: match.organId, recipientId: match.recipientId, matchId: match.id, offeringCentreId: match.organ.institutionId, receivingCentreId: match.recipient.institutionId, status: OrganOfferStatus.SENT, offeredAt: new Date(), responseDeadline: input.responseDeadline, responseReason: input.responseReason } });
		await tx.organMatch.update({ where: { id: match.id }, data: { status: OrganMatchStatus.CONVERTED_TO_OFFER } });
		await tx.organRecord.update({ where: { id: match.organId }, data: { status: OrganStatus.OFFERED, destinationCentreId: match.recipient.institutionId } });
		await addEvent(tx, { organId: match.organId, actor, eventType: "ORGAN_OFFER_SENT", fromStatus: match.organ.status, toStatus: OrganStatus.OFFERED, metadata: { offerReference: offer.reference }, institutionIds: [match.recipient.institutionId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_OFFER_SENT", entityType: "OrganOffer", entityId: offer.id, metadata: { reference: offer.reference, receivingCentreId: match.recipient.institutionId } } });
		return offer;
	});
}

export async function listOrganOffers(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organOffer.findMany({ where: institutionId ? { OR: [{ offeringCentreId: institutionId }, { receivingCentreId: institutionId }] } : undefined, include: { organ: { select: { reference: true, organType: true, status: true } }, recipient: { select: { reference: true } }, offeringCentre: { select: { name: true } }, receivingCentre: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function respondToOrganOffer(actor: AuthContext, offerId: string, action: "ACCEPT" | "REJECT", responseReason?: string) {
	const offer = await database.organOffer.findUnique({ where: { id: offerId }, include: { organ: { select: { status: true } } } });
	if (!offer) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	if (actor.role !== "ADMINISTRATOR" && (actor.role !== "ORGAN_CENTRE_USER" || actor.institutionId !== offer.receivingCentreId)) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	if (!ACTIVE_OFFER_STATUSES.includes(offer.status)) throw new ApiError(409, "OFFER_NOT_RESPONDABLE", "This offer is no longer awaiting a response.");
	if (offer.responseDeadline <= new Date()) throw new ApiError(409, "OFFER_EXPIRED", "The offer response deadline has passed.");
	return database.$transaction(async (tx) => {
		const nextOffer = action === "ACCEPT" ? OrganOfferStatus.ACCEPTED : OrganOfferStatus.REJECTED;
		const nextOrgan = action === "ACCEPT" ? OrganStatus.ACCEPTED : OrganStatus.AVAILABLE;
		const updated = await tx.organOffer.update({ where: { id: offerId }, data: { status: nextOffer, respondedAt: new Date(), responderId: actor.userId, responseReason } });
		await tx.organRecord.update({ where: { id: offer.organId }, data: { status: nextOrgan, destinationCentreId: action === "REJECT" ? null : offer.receivingCentreId } });
		await tx.organMatch.update({ where: { id: offer.matchId }, data: { status: action === "ACCEPT" ? OrganMatchStatus.CONVERTED_TO_OFFER : OrganMatchStatus.REJECTED } });
		await addEvent(tx, { organId: offer.organId, actor, eventType: action === "ACCEPT" ? "ORGAN_OFFER_ACCEPTED" : "ORGAN_OFFER_REJECTED", fromStatus: offer.organ.status, toStatus: nextOrgan, metadata: { offerReference: offer.reference }, institutionIds: [offer.offeringCentreId] });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: action === "ACCEPT" ? "ORGAN_OFFER_ACCEPTED" : "ORGAN_OFFER_REJECTED", entityType: "OrganOffer", entityId: offer.id, metadata: { status: nextOffer } } });
		return updated;
	});
}

export async function expireOrganOffers(now = new Date()) {
	const expired = await database.organOffer.findMany({ where: { status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { lte: now } }, select: { id: true, reference: true, organId: true, matchId: true, offeringCentreId: true, receivingCentreId: true } });
	for (const offer of expired) {
		await database.$transaction(async (tx) => {
			const changed = await tx.organOffer.updateMany({ where: { id: offer.id, status: { in: ACTIVE_OFFER_STATUSES }, responseDeadline: { lte: now } }, data: { status: OrganOfferStatus.EXPIRED, respondedAt: now } });
			if (!changed.count) return;
			const organ = await tx.organRecord.findUnique({ where: { id: offer.organId }, select: { status: true } });
			if (organ?.status === OrganStatus.OFFERED) await tx.organRecord.update({ where: { id: offer.organId }, data: { status: OrganStatus.AVAILABLE, destinationCentreId: null } });
			await tx.organMatch.updateMany({ where: { id: offer.matchId, status: OrganMatchStatus.CONVERTED_TO_OFFER }, data: { status: OrganMatchStatus.EXPIRED } });
			await addEvent(tx, { organId: offer.organId, eventType: "ORGAN_OFFER_EXPIRED", fromStatus: organ?.status, toStatus: organ?.status === OrganStatus.OFFERED ? OrganStatus.AVAILABLE : organ?.status, metadata: { offerReference: offer.reference }, institutionIds: [offer.offeringCentreId, offer.receivingCentreId] });
			await tx.auditLog.create({ data: { action: "ORGAN_OFFER_EXPIRED", entityType: "OrganOffer", entityId: offer.id, metadata: { reference: offer.reference } } });
		});
	}
	return expired.length;
}

export async function checkOrganPreservationAlerts(now = new Date()) {
	const active = await database.organRecord.findMany({ where: { status: { in: [OrganStatus.PRESERVING, OrganStatus.IN_TRANSIT] }, preservationStartTime: { not: null }, preservationMethod: { not: null } }, select: { id: true, institutionId: true, destinationCentreId: true, organType: true, preservationMethod: true, preservationStartTime: true, reference: true } });
	let alertsCreated = 0;
	for (const organ of active) {
		if (!organ.preservationStartTime || !organ.preservationMethod) continue;
		const policy = await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId);
		if (!policy) continue;
		const clock = calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, now });
		const alertStatuses: PreservationStatus[] = [PreservationStatus.WARNING, PreservationStatus.CRITICAL, PreservationStatus.EXPIRED];
		if (!alertStatuses.includes(clock.status)) continue;
		const eventType = `PRESERVATION_${clock.status}`;
		const alreadyNotified = await database.organWorkflowEvent.findFirst({ where: { organId: organ.id, eventType, createdAt: { gte: organ.preservationStartTime } }, select: { id: true } });
		if (alreadyNotified) continue;
		await database.$transaction(async (tx) => {
			const duplicate = await tx.organWorkflowEvent.findFirst({ where: { organId: organ.id, eventType, createdAt: { gte: organ.preservationStartTime! } }, select: { id: true } });
			if (duplicate) return;
			await addEvent(tx, { organId: organ.id, eventType, metadata: { reference: organ.reference, preservationStatus: clock.status, remainingMs: clock.remainingMs, policyLabel: policy.label }, institutionIds: [organ.institutionId, ...(organ.destinationCentreId ? [organ.destinationCentreId] : [])] });
			await tx.auditLog.create({ data: { action: eventType, entityType: "OrganRecord", entityId: organ.id, metadata: { preservationStatus: clock.status, policyLabel: policy.label } } });
			alertsCreated++;
		});
	}
	return alertsCreated;
}

export async function createOrganProcurement(actor: AuthContext, input: { organId: string; scheduledAt: Date; responsibleReference?: string; notes?: string }) {
	const organ = await database.organRecord.findUnique({ where: { id: input.organId }, select: { id: true, institutionId: true, status: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (organ.status !== OrganStatus.ACCEPTED) throw new ApiError(409, "PROCUREMENT_NOT_ALLOWED", "Procurement can be scheduled after an offer is accepted.");
	if (input.scheduledAt <= new Date()) throw new ApiError(400, "INVALID_SCHEDULED_TIME", "Procurement time must be in the future.");
	return database.$transaction(async (tx) => {
		const procurement = await tx.organProcurement.create({ data: { organId: organ.id, procurementCentreId: organ.institutionId, scheduledAt: input.scheduledAt, responsibleReference: input.responsibleReference, notes: input.notes } });
		const changed = await tx.organRecord.update({ where: { id: organ.id }, data: { status: OrganStatus.RETRIEVAL_SCHEDULED } });
		await addEvent(tx, { organId: organ.id, actor, eventType: "PROCUREMENT_SCHEDULED", fromStatus: organ.status, toStatus: changed.status });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "PROCUREMENT_SCHEDULED", entityType: "OrganProcurement", entityId: procurement.id } });
		return procurement;
	});
}

export async function updateOrganProcurement(actor: AuthContext, procurementId: string, status: ProcurementStatus) {
	const record = await database.organProcurement.findUnique({ where: { id: procurementId }, include: { organ: { select: { id: true, institutionId: true, status: true } } } });
	if (!record) throw new ApiError(404, "PROCUREMENT_NOT_FOUND", "Procurement record not found.");
	await assertInstitution(actor, record.procurementCentreId);
	const allowed: Record<ProcurementStatus, ProcurementStatus[]> = { SCHEDULED: [ProcurementStatus.IN_PROGRESS, ProcurementStatus.CANCELLED], IN_PROGRESS: [ProcurementStatus.COMPLETED, ProcurementStatus.CANCELLED, ProcurementStatus.FAILED], COMPLETED: [], CANCELLED: [], FAILED: [] };
	if (!allowed[record.status].includes(status)) throw new ApiError(409, "INVALID_PROCUREMENT_TRANSITION", "The requested procurement transition is not allowed.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const updated = await tx.organProcurement.update({ where: { id: record.id }, data: { status, startedAt: status === ProcurementStatus.IN_PROGRESS ? now : undefined, completedAt: status === ProcurementStatus.COMPLETED ? now : undefined, retrievalTime: status === ProcurementStatus.COMPLETED ? now : undefined } });
		const organStatus = status === ProcurementStatus.IN_PROGRESS ? OrganStatus.RETRIEVAL_IN_PROGRESS : status === ProcurementStatus.COMPLETED ? OrganStatus.RETRIEVED : status === ProcurementStatus.CANCELLED || status === ProcurementStatus.FAILED ? OrganStatus.CANCELLED : undefined;
		if (organStatus) {
			await tx.organRecord.update({ where: { id: record.organ.id }, data: { status: organStatus, retrievalTime: status === ProcurementStatus.COMPLETED ? now : undefined } });
			await addEvent(tx, { organId: record.organ.id, actor, eventType: status === ProcurementStatus.IN_PROGRESS ? "PROCUREMENT_STARTED" : status === ProcurementStatus.COMPLETED ? "PROCUREMENT_COMPLETED" : "PROCUREMENT_CANCELLED", fromStatus: record.organ.status, toStatus: organStatus });
		}
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: `PROCUREMENT_${status}`, entityType: "OrganProcurement", entityId: record.id } });
		return updated;
	});
}

export async function listOrganProcurements(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organProcurement.findMany({ where: institutionId ? { procurementCentreId: institutionId } : undefined, include: { organ: { select: { reference: true, organType: true, status: true } } }, orderBy: { scheduledAt: "desc" }, take: 100 });
}

export async function getOrganDetail(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, include: { donor: { select: { id: true, reference: true, consentStatus: true, authorizationStatus: true, status: true } }, institution: { select: { id: true, name: true } }, currentLocation: { select: { id: true, name: true } }, destinationCentre: { select: { id: true, name: true } }, matches: { include: { recipient: { select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } }, offers: { orderBy: { createdAt: "desc" } }, procurements: { orderBy: { createdAt: "desc" } }, events: { orderBy: { createdAt: "asc" } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId && actor.institutionId !== organ.destinationCentreId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	const [withClock] = await attachPreservationClocks([organ]);
	return withClock;
}

export async function upsertOrganPreservationPolicy(actor: AuthContext, input: { institutionId?: string; organType: OrganType; method: PreservationMethod; targetHours: number; warningHours: number; criticalHours: number; maximumHours: number; label: string }) {
	return database.$transaction(async (tx) => {
		const prior = await tx.organPreservationPolicy.findFirst({ where: { institutionId: input.institutionId ?? null, organType: input.organType, method: input.method } });
		const policy = !prior ? await tx.organPreservationPolicy.create({ data: { ...input, institutionId: input.institutionId } }) : await tx.organPreservationPolicy.update({ where: { id: prior.id }, data: { targetHours: input.targetHours, warningHours: input.warningHours, criticalHours: input.criticalHours, maximumHours: input.maximumHours, label: input.label, active: true } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_PRESERVATION_POLICY_UPDATED", entityType: "OrganPreservationPolicy", entityId: policy.id, metadata: { organType: policy.organType, method: policy.method, targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label } } });
		return policy;
	});
}

export async function listOrganAudit(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, destinationCentreId: true } });
	if (!organ || actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId && actor.institutionId !== organ.destinationCentreId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	return database.organWorkflowEvent.findMany({ where: { organId }, orderBy: { createdAt: "desc" }, take: 100 });
}

export async function listAllOrganAudit(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organWorkflowEvent.findMany({ where: institutionId ? { OR: [{ institutionId }, { organ: { institutionId } }, { organ: { destinationCentreId: institutionId } }] } : undefined, include: { organ: { select: { reference: true, organType: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
}

export async function getOrganDonor(actor: AuthContext, donorId: string) {
	const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, reference: true, institutionId: true, donorType: true, consentStatus: true, authorizationStatus: true, consentDate: true, authorizationDate: true, status: true, createdAt: true, consents: { select: { id: true, status: true, consentType: true, recordedAt: true, verifiedAt: true, documentReference: true, createdAt: true } }, organs: { select: { id: true, reference: true, organType: true, status: true, createdAt: true } } } });
	if (!donor || actor.role !== "ADMINISTRATOR" && actor.institutionId !== donor.institutionId) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	return donor;
}

export async function getOrganRecipient(actor: AuthContext, recipientId: string) {
	const recipient = await database.organRecipient.findUnique({ where: { id: recipientId }, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, institution: { select: { name: true } }, requirement: true, matches: { select: { id: true, status: true, coordinationScore: true, matchReasons: true, generatedAt: true, organ: { select: { reference: true, organType: true, status: true } } }, orderBy: { coordinationScore: "desc" } }, offers: { select: { id: true, reference: true, status: true, offeredAt: true, responseDeadline: true } } } });
	if (!recipient || actor.role !== "ADMINISTRATOR" && actor.institutionId !== recipient.institutionId) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient record not found.");
	return recipient;
}

export async function getOrganOffer(actor: AuthContext, offerId: string) {
	const offer = await database.organOffer.findUnique({ where: { id: offerId }, include: { organ: { select: { reference: true, organType: true, status: true, events: { orderBy: { createdAt: "asc" } } } }, recipient: { select: { reference: true } }, offeringCentre: { select: { name: true } }, receivingCentre: { select: { name: true } } } });
	if (!offer || actor.role !== "ADMINISTRATOR" && actor.institutionId !== offer.offeringCentreId && actor.institutionId !== offer.receivingCentreId) throw new ApiError(404, "ORGAN_OFFER_NOT_FOUND", "Organ offer not found.");
	return offer;
}


export async function createOrganRecipient(actor: AuthContext, input: { institutionId?: string; organType: OrganType; bloodGroup?: string; priority: RequestPriority; latitude?: number; longitude?: number; maximumDistanceKm?: number; urgency?: string; requiredBy?: Date }) {
	const institutionId = requireInstitution(actor) ?? input.institutionId;
	if (!institutionId) throw new ApiError(400, "INSTITUTION_REQUIRED", "A receiving organ centre is required.");
	await assertInstitution(actor, institutionId);
	return database.$transaction(async (tx) => {
		const recipient = await tx.organRecipient.create({ data: { reference: `RCPT-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, institutionId, organType: input.organType, bloodGroup: input.bloodGroup as never, priority: input.priority, requirement: { create: { organType: input.organType, bloodGroup: input.bloodGroup as never, priority: input.priority, latitude: input.latitude, longitude: input.longitude, maximumDistanceKm: input.maximumDistanceKm, urgency: input.urgency, requiredBy: input.requiredBy } } } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_RECIPIENT_CREATED", entityType: "OrganRecipient", entityId: recipient.id, metadata: { reference: recipient.reference, organType: recipient.organType } } });
		return recipient;
	});
}
