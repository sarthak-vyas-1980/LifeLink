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

import { ACTIVE_OFFER_STATUSES, addEvent, assertInstitution, findPreservationPolicy, requireInstitution, isOrganTransitionAllowed } from '../organ-coordination/shared';
import { calculatePreservationClock } from './organ-preservation.service';

export async function createOrganRecord(actor: AuthContext, input: { organType: OrganType; donorId: string; institutionId?: string; bloodGroup?: string; notes?: string }) {
	const donor = await database.organDonor.findUnique({ where: { id: input.donorId }, select: { id: true, institutionId: true, organType: true, consentStatus: true, authorizationStatus: true, organs: { select: { id: true } } } });
	if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	const actorInstitutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const institutionId = actorInstitutionId ?? input.institutionId ?? donor.institutionId;
	if (donor.institutionId !== institutionId || input.institutionId && input.institutionId !== donor.institutionId) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
	await assertInstitution(actor, institutionId);
	if (donor.consentStatus !== ConsentStatus.VERIFIED || donor.authorizationStatus !== OrganAuthorizationStatus.AUTHORIZED) throw new ApiError(409, "DONOR_NOT_AUTHORIZED", "Verified donor authorization is required.");
	if (donor.organType !== input.organType) throw new ApiError(409, "ORGAN_TYPE_MISMATCH", "The organ case must match the donor's authorized organ interest.");
	if (donor.organs.length > 0) throw new ApiError(409, "ORGAN_CASE_EXISTS", "An organ case is already registered for this donor record.");
	return database.$transaction(async (tx) => {
		const organ = await tx.organRecord.create({ data: { reference: `ORG-${input.organType.slice(0, 3)}-${randomUUID().slice(0, 8).toUpperCase()}`, institutionId, donorId: donor.id, organType: input.organType, bloodGroup: input.bloodGroup as never, status: OrganStatus.ASSESSMENT_PENDING, notes: input.notes } });
		await addEvent(tx, { organId: organ.id, actor, eventType: "ORGAN_CREATED", toStatus: organ.status, metadata: { reference: organ.reference } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_CREATED", entityType: "OrganRecord", entityId: organ.id, metadata: { reference: organ.reference, organType: organ.organType } } });
		return organ;
	});
}
export async function updateOrganRecord(actor: AuthContext, organId: string, input: { bloodGroup?: string | null; notes?: string | null }) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, reference: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	return database.$transaction(async (tx) => {
		const updated = await tx.organRecord.update({ where: { id: organId }, data: { bloodGroup: input.bloodGroup as never, notes: input.notes } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_RECORD_UPDATED", metadata: { reference: organ.reference, fields: Object.keys(input).join(",") } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_RECORD_UPDATED", entityType: "OrganRecord", entityId: organId, metadata: { fields: Object.keys(input) } } });
		return updated;
	});
}
export async function transitionOrgan(actor: AuthContext, organId: string, toStatus: OrganStatus) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, donorId: true, donor: { select: { donorType: true } }, status: true, reference: true, transplantScheduledAt: true, organType: true, preservationMethod: true, preservationStartTime: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (new Set<OrganStatus>([OrganStatus.MATCHING, OrganStatus.OFFERED, OrganStatus.ACCEPTED]).has(toStatus)) throw new ApiError(409, "COORDINATION_ACTION_REQUIRED", "Matching, offer creation, and offer acceptance must use their dedicated workflow actions.");
	if (new Set<OrganStatus>([OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.RETRIEVED]).has(toStatus)) throw new ApiError(409, "PROCUREMENT_WORKFLOW_REQUIRED", "Retrieval states can only be advanced through the procurement workflow.");
	if (toStatus === OrganStatus.PRESERVING) throw new ApiError(409, "PRESERVATION_WORKFLOW_REQUIRED", "Start the preservation timer to record the storage method and timeline.");
	if (organ.status === OrganStatus.RETRIEVED && toStatus === OrganStatus.FINAL_ASSESSMENT && organ.donor.donorType === "POSTHUMOUS_INTENT") throw new ApiError(409, "PRESERVATION_REQUIRED", "Posthumous organ cases must start preservation before they can continue to assessment or matching.");
	if (toStatus === OrganStatus.TRANSPLANTED) {
		if (!organ.transplantScheduledAt) throw new ApiError(409, "TRANSPLANT_NOT_SCHEDULED", "Schedule the transplant before recording its completion.");
		if (organ.donor.donorType === "POSTHUMOUS_INTENT") {
			const policy = organ.preservationMethod ? await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId) : null;
			if (!policy || calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }).status === PreservationStatus.EXPIRED) throw new ApiError(409, "PRESERVATION_EXPIRED", "The posthumous organ's configured preservation timeline has ended.");
		}
	}
	if (toStatus === OrganStatus.FINAL_ASSESSMENT || toStatus === OrganStatus.ALLOCATED || toStatus === OrganStatus.TRANSPLANTED || toStatus === OrganStatus.COMPLETED) {
		const acceptedOffer = await database.organOffer.findFirst({ where: { organId, status: OrganOfferStatus.ACCEPTED }, select: { id: true } });
		if (!acceptedOffer) throw new ApiError(409, "ACCEPTED_OFFER_REQUIRED", "Recipient acceptance is required before transplant coordination can proceed.");
	}
	if (!isOrganTransitionAllowed(organ.status, toStatus)) throw new ApiError(409, "INVALID_ORGAN_TRANSITION", "The requested organ workflow transition is not allowed.");
	return database.$transaction(async (tx) => {
		const updated = await tx.organRecord.update({ where: { id: organ.id }, data: { status: toStatus, transplantCompletedAt: toStatus === OrganStatus.TRANSPLANTED ? new Date() : undefined } });
		if (new Set<OrganStatus>([OrganStatus.TRANSPLANTED, OrganStatus.COMPLETED, OrganStatus.CANCELLED, OrganStatus.EXPIRED, OrganStatus.DISCARDED]).has(toStatus)) {
			const otherActiveOrgans = await tx.organRecord.count({ where: { donorId: organ.donorId, id: { not: organ.id }, status: { notIn: [OrganStatus.TRANSPLANTED, OrganStatus.COMPLETED, OrganStatus.CANCELLED, OrganStatus.EXPIRED, OrganStatus.DISCARDED, OrganStatus.UNAVAILABLE] } } });
			if (!otherActiveOrgans) await tx.organDonor.updateMany({ where: { id: organ.donorId, status: { in: [OrganDonorStatus.REGISTERED, OrganDonorStatus.ACTIVE] } }, data: { status: toStatus === OrganStatus.TRANSPLANTED || toStatus === OrganStatus.COMPLETED ? OrganDonorStatus.FULFILLED : OrganDonorStatus.CLOSED } });
		}
		const acceptedOffer = await tx.organOffer.findFirst({ where: { organId, status: OrganOfferStatus.ACCEPTED }, select: { recipientId: true } });
		if (acceptedOffer && (toStatus === OrganStatus.TRANSPLANTED || toStatus === OrganStatus.COMPLETED)) await tx.organRecipient.updateMany({ where: { id: acceptedOffer.recipientId, status: { in: [OrganRecipientStatus.ACTIVE, OrganRecipientStatus.MATCHED] } }, data: { status: OrganRecipientStatus.CLOSED } });
		if (acceptedOffer && (toStatus === OrganStatus.CANCELLED || toStatus === OrganStatus.UNAVAILABLE)) await tx.organRecipient.updateMany({ where: { id: acceptedOffer.recipientId, status: OrganRecipientStatus.MATCHED }, data: { status: OrganRecipientStatus.ACTIVE } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_STATUS_CHANGED", fromStatus: organ.status, toStatus, metadata: { reference: organ.reference } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_STATUS_CHANGED", entityType: "OrganRecord", entityId: organ.id, metadata: { fromStatus: organ.status, toStatus } } });
		return updated;
	});
}
export async function listOrgans(actor: AuthContext, filters: { q?: string; status?: string; organType?: string; bloodGroup?: string; institutionId?: string; preservationStatus?: PreservationStatus; createdFrom?: Date; createdTo?: Date; page?: number; pageSize?: number } = {}) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const scope: Prisma.OrganRecordWhereInput = institutionId ? { institutionId } : {};
	if (filters.institutionId && institutionId && filters.institutionId !== institutionId) throw new ApiError(403, "INSTITUTION_SCOPE_VIOLATION", "You may only filter records within your institution scope.");
	const clauses: Prisma.OrganRecordWhereInput[] = [scope];
	if (filters.institutionId) clauses.push({ institutionId: filters.institutionId });
	if (filters.status) clauses.push({ status: filters.status as OrganStatus });
	if (filters.organType) clauses.push({ organType: filters.organType as OrganType });
	if (filters.bloodGroup) clauses.push({ bloodGroup: filters.bloodGroup as never });
	if (filters.createdFrom || filters.createdTo) clauses.push({ createdAt: { ...(filters.createdFrom ? { gte: filters.createdFrom } : {}), ...(filters.createdTo ? { lte: filters.createdTo } : {}) } });
	if (filters.preservationStatus) clauses.push(filters.preservationStatus === PreservationStatus.NOT_STARTED ? { NOT: { status: OrganStatus.PRESERVING } } : { status: OrganStatus.PRESERVING });
	if (filters.q) clauses.push({ OR: [{ reference: { contains: filters.q, mode: "insensitive" as const } }, { donor: { reference: { contains: filters.q, mode: "insensitive" as const } } }] });
	const where: Prisma.OrganRecordWhereInput = { AND: clauses };
	const page = filters.page ?? 1; const pageSize = filters.pageSize ?? 25;
	const include = { donor: { select: { id: true, reference: true, donorType: true, consentStatus: true, authorizationStatus: true } }, institution: { select: { id: true, name: true } }, offers: { select: { id: true, status: true, responseDeadline: true, recipient: { select: { reference: true } } } }, events: { orderBy: { createdAt: "asc" as const } } };
	if (filters.preservationStatus && filters.preservationStatus !== PreservationStatus.NOT_STARTED) {
		const candidates = await database.organRecord.findMany({ where, include, orderBy: { updatedAt: "desc" } });
		const filtered = (await attachPreservationClocks(candidates)).filter((record) => record.preservation.status === filters.preservationStatus);
		const total = filtered.length;
		return { organs: filtered.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
	}
	const [records, total] = await Promise.all([database.organRecord.findMany({ where, include, orderBy: { updatedAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }), database.organRecord.count({ where })]);
	return { organs: await attachPreservationClocks(records), pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
}

export async function getOrganInventorySummary(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const stock = await database.organRecord.findMany({
			where: {
				...(institutionId ? { institutionId } : {}),
				donor: { donorType: "POSTHUMOUS_INTENT" },
				retrievalTime: { not: null },
				status: { notIn: [OrganStatus.TRANSPLANTED, OrganStatus.COMPLETED, OrganStatus.UNAVAILABLE, OrganStatus.DISCARDED, OrganStatus.CANCELLED] },
			},
			select: { id: true, reference: true, organType: true, institutionId: true, status: true, retrievalTime: true, preservationMethod: true, preservationStartTime: true, donor: { select: { id: true, reference: true } } },
		});
	const stockWithClocks = await attachPreservationClocks(stock);
	const organTypes = Object.values(OrganType);
	return {
		stock: organTypes.map((organType) => {
			const organs = stockWithClocks.filter((organ) => organ.organType === organType);
			return { organType, quantity: organs.length, organs: organs.map(({ id, reference, status, retrievalTime, preservationMethod, preservationStartTime, donor, preservation }) => ({ id, reference, status, retrievalTime, preservationStartTime, preservationMethod, donor, maximumHours: "maximumHours" in preservation ? preservation.maximumHours : null, warningHours: "warningHours" in preservation ? preservation.warningHours : null, criticalHours: "criticalHours" in preservation ? preservation.criticalHours : null, remainingMs: preservation.remainingMs, preservationStatus: preservation.status })) };
		}),
		disclaimer: "Operational timing only; clinical suitability is determined by authorized professionals.",
	};
}

export async function getOrganDashboardMetrics(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const organWhere: Prisma.OrganRecordWhereInput = institutionId ? { institutionId } : {};
	const offerWhere = institutionId ? { OR: [{ offeringCentreId: institutionId }, { receivingCentreId: institutionId }] } : {};
	const procurementWhere = institutionId ? { procurementCentreId: institutionId } : {};
	const donorWhere = institutionId ? { institutionId } : undefined;
	const recipientWhere = institutionId ? { institutionId, status: "ACTIVE" as const } : { status: "ACTIVE" as const };
	const [total, statusCounts, activeOffers, acceptedOffers, procurements, procurementVolume, preserving, pendingDonorReview, pendingRecipientReview, activeRecipientRequirements, donorRequests, recipientRequests, activeDonorRequests, activeRecipientRequests, backlogDonorRequests, backlogRecipientRequests, rejectedDonors, rejectedRecipients, recentEvents, recentAudit] = await Promise.all([
		database.organRecord.count({ where: organWhere }),
		database.organRecord.groupBy({ by: ["status"], where: organWhere, _count: { _all: true } }),
		database.organOffer.count({ where: { ...offerWhere, status: { in: ACTIVE_OFFER_STATUSES } } }),
		database.organOffer.count({ where: { ...offerWhere, status: OrganOfferStatus.ACCEPTED } }),
		database.organProcurement.count({ where: { ...procurementWhere, status: { in: [ProcurementStatus.SCHEDULED, ProcurementStatus.IN_PROGRESS] } } }),
		database.organProcurement.count({ where: procurementWhere }),
		database.organRecord.findMany({ where: { ...organWhere, status: OrganStatus.PRESERVING }, select: { id: true, organType: true, institutionId: true, preservationMethod: true, preservationStartTime: true } }),
		database.organDonor.count({ where: { ...donorWhere, consentStatus: ConsentStatus.PENDING } }),
		database.organRecipient.count({ where: { ...(institutionId ? { institutionId } : {}), status: OrganRecipientStatus.PENDING_REVIEW } }),
		database.organRecipient.count({ where: recipientWhere }),
		database.organDonor.count({ where: donorWhere }),
		database.organRecipient.count({ where: institutionId ? { institutionId } : {} }),
		database.organDonor.count({ where: { ...donorWhere, status: { in: [OrganDonorStatus.REGISTERED, OrganDonorStatus.ACTIVE] } } }),
		database.organRecipient.count({ where: { ...(institutionId ? { institutionId } : {}), status: { in: [OrganRecipientStatus.PENDING_REVIEW, OrganRecipientStatus.ACTIVE, OrganRecipientStatus.MATCHED] } } }),
		database.organDonor.count({ where: { ...donorWhere, status: OrganDonorStatus.REGISTERED } }),
		database.organRecipient.count({ where: { ...(institutionId ? { institutionId } : {}), status: OrganRecipientStatus.PENDING_REVIEW } }),
		database.organDonor.count({ where: { ...donorWhere, authorizationStatus: OrganAuthorizationStatus.REJECTED } }),
		database.organRecipient.count({ where: { ...(institutionId ? { institutionId } : {}), status: OrganRecipientStatus.REJECTED } }),
		database.organWorkflowEvent.findMany({ where: institutionId ? { institutionId } : {}, include: { organ: { select: { reference: true, organType: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
		database.auditLog.findMany({ where: institutionId ? { actorInstitutionId: institutionId, entityType: { in: ["OrganDonor", "OrganRecipient", "OrganRecord", "OrganConsent", "OrganMatch", "OrganOffer", "OrganProcurement"] } } : { entityType: { in: ["OrganDonor", "OrganRecipient", "OrganRecord", "OrganConsent", "OrganMatch", "OrganOffer", "OrganProcurement"] } }, orderBy: { createdAt: "desc" }, take: 5 }),
	]);
	const counts = Object.fromEntries(statusCounts.map(({ status, _count }) => [status, _count._all])) as Record<string, number>;
	const preservedWithTimers = await attachPreservationClocks(preserving.filter((row): row is typeof row & { preservationMethod: PreservationMethod } => Boolean(row.preservationMethod)));
	const recentActivity = [...recentEvents.map((event) => ({ id: event.id, action: event.eventType, createdAt: event.createdAt, reference: event.organ?.reference ?? null, organType: event.organ?.organType ?? null, actorId: event.actorId })), ...recentAudit.map((event) => ({ id: event.id, action: event.action, createdAt: event.createdAt, reference: typeof event.metadata === "object" && event.metadata !== null && "reference" in event.metadata ? String(event.metadata.reference) : null, organType: null, actorId: event.actorId }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 5);
	return {
		total,
		donorRequests,
		recipientRequests,
		activeRequests: activeDonorRequests + activeRecipientRequests,
		backlog: backlogDonorRequests + backlogRecipientRequests,
		activeWorkflows: (counts[OrganStatus.COMPLETED] ?? 0) + (counts[OrganStatus.CANCELLED] ?? 0) + (counts[OrganStatus.EXPIRED] ?? 0) + (counts[OrganStatus.UNAVAILABLE] ?? 0) < total ? total - ((counts[OrganStatus.COMPLETED] ?? 0) + (counts[OrganStatus.CANCELLED] ?? 0) + (counts[OrganStatus.EXPIRED] ?? 0) + (counts[OrganStatus.UNAVAILABLE] ?? 0)) : 0,
		available: counts[OrganStatus.AVAILABLE] ?? 0,
		matching: counts[OrganStatus.MATCHING] ?? 0,
		activeOffers,
		acceptedOffers,
		pendingDonorReview,
		pendingRecipientReview,
		activeRecipientRequirements,
		procurements,
		procurementVolume,
		preserving: counts[OrganStatus.PRESERVING] ?? 0,
		criticalPreservation: preservedWithTimers.filter((row) => row.preservation.status === PreservationStatus.CRITICAL || row.preservation.status === PreservationStatus.EXPIRED).length,
		completed: (counts[OrganStatus.COMPLETED] ?? 0) + (counts[OrganStatus.TRANSPLANTED] ?? 0),
		rejected: rejectedDonors + rejectedRecipients + (counts[OrganStatus.DISCARDED] ?? 0),
		cancelled: counts[OrganStatus.CANCELLED] ?? 0,
		expired: counts[OrganStatus.EXPIRED] ?? 0,
		recentActivity,
	};
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
export async function getOrganDetail(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, include: { donor: { select: { id: true, reference: true, donorType: true, consentStatus: true, authorizationStatus: true, status: true } }, institution: { select: { id: true, name: true } }, matches: { include: { recipient: { select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } }, offers: { orderBy: { createdAt: "desc" } }, procurements: { orderBy: { createdAt: "desc" } }, events: { orderBy: { createdAt: "asc" } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	const [withClock] = await attachPreservationClocks([organ]);
	return withClock;
}
