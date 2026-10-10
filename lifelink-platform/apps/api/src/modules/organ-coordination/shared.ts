import { randomUUID } from "node:crypto";
import {
	ConsentStatus,
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
import { createOrganNotifications } from "../notifications/organ.service";

export const ACTIVE_OFFER_STATUSES: OrganOfferStatus[] = [OrganOfferStatus.SENT, OrganOfferStatus.UNDER_REVIEW];
const ORGAN_TRANSITIONS: Record<OrganStatus, OrganStatus[]> = {
	REGISTERED: [OrganStatus.ASSESSMENT_PENDING, OrganStatus.CANCELLED],
	ASSESSMENT_PENDING: [OrganStatus.ELIGIBLE_FOR_COORDINATION, OrganStatus.UNAVAILABLE],
	ELIGIBLE_FOR_COORDINATION: [OrganStatus.AVAILABLE, OrganStatus.MATCHING, OrganStatus.OFFERED, OrganStatus.UNAVAILABLE],
	AVAILABLE: [OrganStatus.MATCHING, OrganStatus.UNAVAILABLE, OrganStatus.CANCELLED],
	MATCHING: [OrganStatus.OFFERED, OrganStatus.AVAILABLE, OrganStatus.UNAVAILABLE],
	OFFERED: [OrganStatus.ACCEPTED, OrganStatus.AVAILABLE, OrganStatus.EXPIRED, OrganStatus.CANCELLED],
	ACCEPTED: [OrganStatus.RETRIEVAL_SCHEDULED, OrganStatus.CANCELLED],
	RETRIEVAL_SCHEDULED: [OrganStatus.RETRIEVAL_IN_PROGRESS, OrganStatus.CANCELLED],
	RETRIEVAL_IN_PROGRESS: [OrganStatus.RETRIEVED, OrganStatus.CANCELLED, OrganStatus.UNAVAILABLE],
	RETRIEVED: [OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT],
	PRESERVING: [OrganStatus.FINAL_ASSESSMENT, OrganStatus.UNAVAILABLE, OrganStatus.EXPIRED],
	FINAL_ASSESSMENT: [OrganStatus.ALLOCATED, OrganStatus.UNAVAILABLE],
	ALLOCATED: [OrganStatus.TRANSPLANTED],
	TRANSPLANTED: [OrganStatus.COMPLETED],
	COMPLETED: [], UNAVAILABLE: [OrganStatus.CANCELLED], EXPIRED: [], DISCARDED: [], CANCELLED: [],
};

export function isOrganTransitionAllowed(from: OrganStatus, to: OrganStatus) {
	return ORGAN_TRANSITIONS[from]?.includes(to) ?? false;
}

type Tx = Prisma.TransactionClient;
type OrganEvent = { organId: string; actor?: Pick<AuthContext, "userId" | "institutionId" | "capabilities">; eventType: string; fromStatus?: string; toStatus?: string; metadata?: Record<string, string | number | boolean | null>; institutionIds?: string[] };

export function requireInstitution(actor: AuthContext) {
	if (actor.role !== "ADMINISTRATOR" && (!actor.institutionId || (actor.role !== "ORGAN_CENTRE_USER" && !(actor.role === "HOSPITAL_USER" && actor.capabilities?.organ)))) {
		throw new ApiError(403, "ORGAN_CENTRE_REQUIRED", "Organ-centre access is required.");
	}
	return actor.institutionId;
}

export async function addEvent(tx: Tx, event: OrganEvent) {
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
	await createOrganNotifications(tx, { organId: event.organId, eventId, eventType: event.eventType, metadata: safeMetadata as Prisma.InputJsonObject, institutionIds });
}

export async function assertInstitution(actor: AuthContext, institutionId: string) {
	const institution = await database.institution.findUnique({ where: { id: institutionId }, select: { id: true, type: true, status: true, hospitalProfile: { select: { organService: { select: { id: true } } } } } });
	const hasOrganCapability = institution?.type === "ORGAN_CENTRE" || institution?.type === "HOSPITAL" && Boolean(institution.hospitalProfile?.organService);
	if (!institution || !hasOrganCapability || institution.status !== "ACTIVE" || actor.role !== "ADMINISTRATOR" && (actor.institutionId !== institutionId || actor.role === "HOSPITAL_USER" && !actor.capabilities?.organ || actor.role !== "HOSPITAL_USER" && actor.role !== "ORGAN_CENTRE_USER")) {
		throw new ApiError(404, "ORGAN_RESOURCE_NOT_FOUND", "Organ coordination record not found.");
	}
}

export async function findPreservationPolicy(organType: OrganType, method: PreservationMethod, institutionId: string) {
	const policies = await database.organPreservationPolicy.findMany({ where: { organType, method, active: true, OR: [{ institutionId }, { institutionId: null }] } });
	return policies.find((policy) => policy.institutionId === institutionId) ?? policies.find((policy) => policy.institutionId === null) ?? null;
}

