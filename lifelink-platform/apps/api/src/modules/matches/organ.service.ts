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

import { ACTIVE_OFFER_STATUSES, addEvent, assertInstitution } from '../organ-coordination/shared';

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
		if (candidates.length && organ.status === OrganStatus.AVAILABLE) await tx.organRecord.update({ where: { id: organId }, data: { status: OrganStatus.MATCHING } });
		await addEvent(tx, { organId, actor, institutionIds: candidates.map((candidate) => candidate.requirement.recipient.institutionId), eventType: "ORGAN_MATCH_GENERATED", fromStatus: organ.status, toStatus: candidates.length ? OrganStatus.MATCHING : organ.status, metadata: { candidateCount: candidates.length } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_MATCH_GENERATED", entityType: "OrganRecord", entityId: organId, metadata: { candidateCount: candidates.length } } });
	});
	const matches = await database.organMatch.findMany({ where: { organId }, include: { recipient: { select: { reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } });
	return { label: "Potential Coordination Matches", matches, clinicalDecision: false as const };
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
