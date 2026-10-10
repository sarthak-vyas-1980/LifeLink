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

import { ACTIVE_OFFER_STATUSES, addEvent, assertInstitution, findPreservationPolicy, requireInstitution } from '../organ-coordination/shared';
import { calculatePreservationClock } from "../inventories/organ-preservation.service";

async function isAvailableForCoordination(organ: { status: OrganStatus; donor?: { donorType: string } | null; organType?: OrganType; institutionId?: string; preservationMethod?: PreservationMethod | null; preservationStartTime?: Date | null }) {
	if (organ.status === OrganStatus.PRESERVING) {
		if (organ.donor?.donorType !== "POSTHUMOUS_INTENT" || !organ.organType || !organ.institutionId || !organ.preservationMethod || !organ.preservationStartTime) return false;
		const policy = await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId);
		return Boolean(policy && calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }).status !== PreservationStatus.EXPIRED);
	}
	if (organ.donor?.donorType === "POSTHUMOUS_INTENT") return false;
	return organ.status === OrganStatus.ELIGIBLE_FOR_COORDINATION || organ.status === OrganStatus.AVAILABLE || organ.status === OrganStatus.MATCHING;
}

export async function generateOrganMatches(actor: AuthContext, organId: string, radiusKm?: number) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, include: { institution: { select: { latitude: true, longitude: true } }, donor: { select: { donorType: true } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (!(await isAvailableForCoordination(organ))) throw new ApiError(409, "ORGAN_NOT_AVAILABLE", "This organ is not available for matching. Posthumous cases must be retrieved and have an active preservation timer; living donor cases must be eligible and authorized.");
	const requirements = await database.recipientRequirement.findMany({ where: { organType: organ.organType, recipient: { status: "ACTIVE" } }, include: { recipient: { include: { institution: { select: { id: true, name: true, latitude: true, longitude: true } } } } } });
	const candidates = requirements.flatMap((requirement) => {
		if (requirement.bloodGroup && organ.bloodGroup && requirement.bloodGroup !== organ.bloodGroup) return [];
		const hasCoordinates = organ.institution.latitude !== null && organ.institution.longitude !== null && requirement.latitude !== null && requirement.longitude !== null;
		const distanceKm = hasCoordinates ? calculateDistance(organ.institution.latitude!, organ.institution.longitude!, requirement.latitude!, requirement.longitude!) : undefined;
		if (radiusKm !== undefined && (distanceKm === undefined || distanceKm > radiusKm)) return [];
		if (requirement.maximumDistanceKm !== null && distanceKm !== undefined && distanceKm > requirement.maximumDistanceKm) return [];
		const priorityScore = requirement.priority === RequestPriority.EMERGENCY ? 40 : requirement.priority === RequestPriority.URGENT ? 25 : 10;
		const distanceScore = distanceKm === undefined ? 0 : Math.max(0, 30 - Math.min(distanceKm, 300) / 10);
		const daysUntilRequired = requirement.requiredBy ? (requirement.requiredBy.getTime() - Date.now()) / 86_400_000 : undefined;
		const dueScore = daysUntilRequired === undefined ? 0 : daysUntilRequired <= 1 ? 20 : daysUntilRequired <= 7 ? 12 : daysUntilRequired <= 30 ? 5 : 0;
		const reasons = ["organ type matches the active recipient requirement", ...(requirement.bloodGroup && organ.bloodGroup ? ["blood group matches the configured filter"] : []), ...(distanceKm === undefined ? [] : ["location is within the configured search range"]), `coordination priority: ${requirement.priority.toLowerCase()}`, ...(daysUntilRequired === undefined ? [] : [daysUntilRequired < 0 ? "required-by date has passed" : "required-by date proximity considered"]), ...(requirement.urgency ? ["configured urgency note present"] : [])];
		return [{ requirement, distanceKm, score: Math.round((priorityScore + distanceScore + dueScore) * 100) / 100, reasons }];
	}).sort((a, b) => b.score - a.score);
	await database.$transaction(async (tx) => {
		const saved = [];
		for (const candidate of candidates) {
			const prior = await tx.organMatch.findFirst({ where: { organId, recipientId: candidate.requirement.recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } } });
			if (prior) { saved.push({ ...prior, distanceKm: candidate.distanceKm }); continue; }
			saved.push(await tx.organMatch.create({ data: { organId, recipientId: candidate.requirement.recipientId, coordinationScore: candidate.score, matchReasons: candidate.reasons, criteriaSnapshot: { organType: organ.organType, bloodGroupFilterApplied: Boolean(candidate.requirement.bloodGroup && organ.bloodGroup), distanceKm: candidate.distanceKm ?? null, priority: candidate.requirement.priority, radiusKm: radiusKm ?? null } } }));
		}
		const preservePosthumousStock = organ.donor?.donorType === "POSTHUMOUS_INTENT";
		const nextStatus = candidates.length && organ.status !== OrganStatus.MATCHING && !preservePosthumousStock ? OrganStatus.MATCHING : organ.status;
		if (nextStatus !== organ.status) await tx.organRecord.update({ where: { id: organId }, data: { status: nextStatus } });
		await addEvent(tx, { organId, actor, institutionIds: candidates.map((candidate) => candidate.requirement.recipient.institutionId), eventType: "ORGAN_MATCH_GENERATED", fromStatus: organ.status, toStatus: nextStatus, metadata: { candidateCount: candidates.length } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_MATCH_GENERATED", entityType: "OrganRecord", entityId: organId, metadata: { candidateCount: candidates.length } } });
	});
	const matches = await database.organMatch.findMany({ where: { organId }, include: { recipient: { select: { reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } });
	return { label: "Potential Coordination Matches", matches, clinicalDecision: false as const };
}

export async function generateRecipientMatches(actor: AuthContext, recipientId: string, radiusKm?: number) {
	const recipient = await database.organRecipient.findUnique({
		where: { id: recipientId },
		include: { institution: { select: { latitude: true, longitude: true } }, requirement: true },
	});
	if (!recipient || actor.role !== "ADMINISTRATOR" && actor.institutionId !== recipient.institutionId) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient request not found.");
	if (recipient.status !== "ACTIVE") throw new ApiError(409, "RECIPIENT_NOT_ACTIVE", "Approve the recipient request before searching inventory.");
	await assertInstitution(actor, recipient.institutionId);
	const requirement = recipient.requirement;
	const organs = await database.organRecord.findMany({
		where: { organType: recipient.organType, status: { in: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.AVAILABLE, OrganStatus.MATCHING, OrganStatus.PRESERVING] } },
		include: { institution: { select: { id: true, name: true, latitude: true, longitude: true } }, donor: { select: { donorType: true } } },
	});
	const eligibleOrgans = await Promise.all(organs.map(async (organ) => (await isAvailableForCoordination(organ)) ? organ : null));
	const candidates = eligibleOrgans.flatMap((organ) => {
		if (!organ) return [];
		if (recipient.bloodGroup && organ.bloodGroup && recipient.bloodGroup !== organ.bloodGroup) return [];
		const hasCoordinates = organ.institution.latitude !== null && organ.institution.longitude !== null && requirement?.latitude != null && requirement.longitude != null;
		const distanceKm = hasCoordinates ? calculateDistance(organ.institution.latitude!, organ.institution.longitude!, requirement!.latitude!, requirement!.longitude!) : undefined;
		if (radiusKm !== undefined && (distanceKm === undefined || distanceKm > radiusKm)) return [];
		if (requirement?.maximumDistanceKm != null && distanceKm !== undefined && distanceKm > requirement.maximumDistanceKm) return [];
		const priority = requirement?.priority ?? recipient.priority;
		const priorityScore = priority === RequestPriority.EMERGENCY ? 40 : priority === RequestPriority.URGENT ? 25 : 10;
		const distanceScore = distanceKm === undefined ? 0 : Math.max(0, 30 - Math.min(distanceKm, 300) / 10);
		const daysUntilRequired = requirement?.requiredBy ? (requirement.requiredBy.getTime() - Date.now()) / 86_400_000 : undefined;
		const dueScore = daysUntilRequired === undefined ? 0 : daysUntilRequired <= 1 ? 20 : daysUntilRequired <= 7 ? 12 : daysUntilRequired <= 30 ? 5 : 0;
		const reasons = ["organ type matches the active recipient requirement", ...(recipient.bloodGroup && organ.bloodGroup ? ["blood group matches the configured filter"] : []), ...(distanceKm === undefined ? [] : ["location is within the configured search range"]), `coordination priority: ${priority.toLowerCase()}`, ...(daysUntilRequired === undefined ? [] : [daysUntilRequired < 0 ? "required-by date has passed" : "required-by date proximity considered"]), ...(requirement?.urgency ? ["configured urgency note present"] : [])];
		return [{ organ, distanceKm, score: Math.round((priorityScore + distanceScore + dueScore) * 100) / 100, reasons }];
	}).sort((a, b) => Number(a.organ.donor?.donorType !== "POSTHUMOUS_INTENT") - Number(b.organ.donor?.donorType !== "POSTHUMOUS_INTENT") || b.score - a.score);
	const stockCandidates = candidates.filter((candidate) => candidate.organ.donor?.donorType === "POSTHUMOUS_INTENT");
	const matchingCandidates = stockCandidates.length ? stockCandidates : candidates;
	await database.$transaction(async (tx) => {
		for (const candidate of matchingCandidates) {
			const prior = await tx.organMatch.findFirst({ where: { organId: candidate.organ.id, recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } } });
			if (!prior) await tx.organMatch.create({ data: { organId: candidate.organ.id, recipientId, coordinationScore: candidate.score, matchReasons: candidate.reasons, criteriaSnapshot: { organType: recipient.organType, bloodGroupFilterApplied: Boolean(recipient.bloodGroup && candidate.organ.bloodGroup), distanceKm: candidate.distanceKm ?? null, priority: requirement?.priority ?? recipient.priority, radiusKm: radiusKm ?? null } } });
		}
		for (const organId of new Set(matchingCandidates.map(({ organ }) => organ.id))) {
			const organ = matchingCandidates.find((candidate) => candidate.organ.id === organId)!.organ;
			await addEvent(tx, { organId, actor, institutionIds: [organ.institutionId], eventType: "ORGAN_MATCH_GENERATED", metadata: { recipientReference: recipient.reference, recipientId, candidateCount: 1 } });
		}
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_MATCH_GENERATED", entityType: "OrganRecipient", entityId: recipientId, metadata: { recipientReference: recipient.reference, candidateCount: matchingCandidates.length } } });
	});
	const matches = await database.organMatch.findMany({ where: { recipientId, organId: { in: matchingCandidates.map(({ organ }) => organ.id) }, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } }, include: { organ: { select: { id: true, reference: true, organType: true, bloodGroup: true, status: true, institutionId: true, institution: { select: { name: true } } } }, recipient: { select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, institutionId: true, institution: { select: { name: true } } } } }, orderBy: [{ coordinationScore: "desc" }, { generatedAt: "desc" }] });
	return { label: "Potential Coordination Matches", matches: matches.map((match) => ({ ...match, canCoordinate: actor.role === "ADMINISTRATOR" || actor.institutionId === match.organ.institutionId })), clinicalDecision: false as const };
}

export async function listOrganMatches(actor: AuthContext, filters: { q?: string; status?: OrganMatchStatus; organType?: OrganType; bloodGroup?: string } = {}) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const matches = await database.organMatch.findMany({
		where: {
			AND: [
				institutionId ? { OR: [{ organ: { institutionId } }, { recipient: { institutionId } }] } : {},
				filters.status ? { status: filters.status } : {},
				filters.organType ? { organ: { organType: filters.organType } } : {},
				filters.bloodGroup ? { OR: [{ organ: { bloodGroup: filters.bloodGroup as never } }, { recipient: { bloodGroup: filters.bloodGroup as never } }] } : {},
				filters.q ? { OR: [{ organ: { reference: { contains: filters.q, mode: "insensitive" } } }, { recipient: { reference: { contains: filters.q, mode: "insensitive" } } }] } : {},
			],
		},
		include: {
			organ: { select: { id: true, reference: true, organType: true, bloodGroup: true, status: true, institutionId: true, institution: { select: { name: true } } } },
			recipient: { select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, status: true, institutionId: true, institution: { select: { name: true } } } },
		},
		orderBy: [{ updatedAt: "desc" }, { coordinationScore: "desc" }],
	});
	return matches.map((match) => ({ ...match, canCoordinate: actor.role === "ADMINISTRATOR" || actor.institutionId === match.organ.institutionId }));
}
export async function reviewOrganMatch(actor: AuthContext, matchId: string, status: "UNDER_REVIEW" | "SHORTLISTED" | "REJECTED") {
	const match = await database.organMatch.findUnique({ where: { id: matchId }, include: { organ: { select: { institutionId: true } } } });
	if (!match) throw new ApiError(404, "ORGAN_MATCH_NOT_FOUND", "Potential coordination match not found.");
	await assertInstitution(actor, match.organ.institutionId);
	const allowed: Record<OrganMatchStatus, OrganMatchStatus[]> = {
		GENERATED: [OrganMatchStatus.UNDER_REVIEW],
		UNDER_REVIEW: [OrganMatchStatus.SHORTLISTED, OrganMatchStatus.REJECTED],
		SHORTLISTED: [OrganMatchStatus.REJECTED],
		REJECTED: [], CONVERTED_TO_OFFER: [], EXPIRED: [], CANCELLED: [],
	};
	if (!allowed[match.status].includes(status)) throw new ApiError(409, "MATCH_NOT_REVIEWABLE", "The requested potential match review transition is not allowed.");
	return database.$transaction(async (tx) => {
		const updated = await tx.organMatch.update({ where: { id: match.id }, data: { status, reviewedAt: new Date(), reviewedById: actor.userId } });
		await addEvent(tx, { organId: match.organId, actor, eventType: status === OrganMatchStatus.SHORTLISTED ? "MATCH_SHORTLISTED" : status === OrganMatchStatus.REJECTED ? "MATCH_REJECTED" : "MATCH_REVIEWED", metadata: { status, recipientId: match.recipientId } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: status === OrganMatchStatus.SHORTLISTED ? "MATCH_SHORTLISTED" : status === OrganMatchStatus.REJECTED ? "MATCH_REJECTED" : "MATCH_REVIEWED", entityType: "OrganMatch", entityId: match.id, metadata: { status } } });
		return updated;
	});
}

export async function getOrganMatch(actor: AuthContext, matchId: string) {
	const match = await database.organMatch.findUnique({ where: { id: matchId }, include: { organ: { select: { id: true, reference: true, organType: true, bloodGroup: true, status: true, institutionId: true, institution: { select: { name: true } } } }, recipient: { select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, status: true, institutionId: true, institution: { select: { name: true } }, requirement: true } } } });
	if (!match || actor.role !== "ADMINISTRATOR" && actor.institutionId !== match.organ.institutionId && actor.institutionId !== match.recipient.institutionId) throw new ApiError(404, "ORGAN_MATCH_NOT_FOUND", "Potential coordination match not found.");
	return { ...match, label: "Potential Coordination Match", professionalReviewRequired: true, clinicalDecision: false as const };
}
