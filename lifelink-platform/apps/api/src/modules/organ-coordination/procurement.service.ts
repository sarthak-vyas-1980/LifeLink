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

import { addEvent, assertInstitution, findPreservationPolicy, requireInstitution } from './shared';
import { calculatePreservationClock } from '../inventories/organ-preservation.service';

export async function scheduleOrganTransplant(actor: AuthContext, organId: string, input: { scheduledAt: Date; responsibleReference?: string }) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, status: true, reference: true, donor: { select: { donorType: true } }, organType: true, preservationMethod: true, preservationStartTime: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (!new Set<OrganStatus>([OrganStatus.RETRIEVED, OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED]).has(organ.status)) throw new ApiError(409, "TRANSPLANT_NOT_READY", "Transplant scheduling is available after procurement or retrieval.");
	const acceptedOffer = await database.organOffer.findFirst({ where: { organId, status: OrganOfferStatus.ACCEPTED }, select: { id: true } });
	if (!acceptedOffer) throw new ApiError(409, "ACCEPTED_OFFER_REQUIRED", "The recipient must accept an offer before transplant scheduling.");
	if (organ.donor.donorType === "POSTHUMOUS_INTENT") {
		const policy = organ.preservationMethod ? await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId) : null;
		const clock = policy ? calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }) : null;
		const preservationWorkflowActive = new Set<OrganStatus>([OrganStatus.PRESERVING, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED]).has(organ.status);
		if (!preservationWorkflowActive || !clock || clock.status === PreservationStatus.EXPIRED || input.scheduledAt.getTime() > Date.now() + clock.remainingMs) throw new ApiError(409, "PRESERVATION_EXPIRED", "Schedule the posthumous transplant before the organ's configured preservation timeline ends.");
	}
	if (input.scheduledAt <= new Date()) throw new ApiError(400, "INVALID_SCHEDULED_TIME", "Transplant time must be in the future.");
	return database.$transaction(async (tx) => {
		const responsibleReference = input.responsibleReference?.trim() || null;
		const changed = await tx.organRecord.updateMany({ where: { id: organ.id, transplantScheduledAt: null, status: organ.status }, data: { transplantScheduledAt: input.scheduledAt, transplantResponsibleReference: responsibleReference } });
		if (!changed.count) throw new ApiError(409, "TRANSPLANT_ALREADY_SCHEDULED", "This organ already has a transplant schedule or its status has changed.");
		await addEvent(tx, { organId: organ.id, actor, eventType: "TRANSPLANT_SCHEDULED", fromStatus: organ.status, toStatus: organ.status, metadata: { scheduledAt: input.scheduledAt.toISOString(), responsibleReference } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "TRANSPLANT_SCHEDULED", entityType: "OrganRecord", entityId: organ.id, metadata: { scheduledAt: input.scheduledAt.toISOString() } } });
		return tx.organRecord.findUniqueOrThrow({ where: { id: organ.id } });
	});
}

export async function createOrganProcurement(actor: AuthContext, input: { organId: string; scheduledAt: Date; responsibleReference?: string; notes?: string }) {
	const organ = await database.organRecord.findUnique({ where: { id: input.organId }, select: { id: true, institutionId: true, status: true, donor: { select: { donorType: true } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	const deceasedPreRetrieval = organ.donor.donorType === "POSTHUMOUS_INTENT" && (organ.status === OrganStatus.ELIGIBLE_FOR_COORDINATION || organ.status === OrganStatus.AVAILABLE);
	if (organ.status !== OrganStatus.ACCEPTED && !deceasedPreRetrieval) throw new ApiError(409, "PROCUREMENT_NOT_ALLOWED", "Living donor retrieval follows recipient offer acceptance. Posthumous retrieval can be scheduled after organ assessment.");
	if (input.scheduledAt <= new Date()) throw new ApiError(400, "INVALID_SCHEDULED_TIME", "Procurement time must be in the future.");
	return database.$transaction(async (tx) => {
		const changed = await tx.organRecord.updateMany({ where: { id: organ.id, status: organ.status }, data: { status: OrganStatus.RETRIEVAL_SCHEDULED } });
		if (!changed.count) throw new ApiError(409, "PROCUREMENT_NOT_ALLOWED", "This organ already has a procurement schedule or is no longer awaiting procurement.");
		const procurement = await tx.organProcurement.create({ data: { organId: organ.id, procurementCentreId: organ.institutionId, scheduledAt: input.scheduledAt, responsibleReference: input.responsibleReference, notes: input.notes } });
		await addEvent(tx, { organId: organ.id, actor, eventType: "PROCUREMENT_SCHEDULED", fromStatus: organ.status, toStatus: OrganStatus.RETRIEVAL_SCHEDULED });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "PROCUREMENT_SCHEDULED", entityType: "OrganProcurement", entityId: procurement.id } });
		return procurement;
	});
}
export async function updateOrganProcurement(actor: AuthContext, procurementId: string, status: ProcurementStatus) {
	const record = await database.organProcurement.findUnique({ where: { id: procurementId }, include: { organ: { select: { id: true, donorId: true, institutionId: true, status: true, organType: true, donor: { select: { donorType: true } } } } } });
	if (!record) throw new ApiError(404, "PROCUREMENT_NOT_FOUND", "Procurement record not found.");
	await assertInstitution(actor, record.procurementCentreId);
	const allowed: Record<ProcurementStatus, ProcurementStatus[]> = { SCHEDULED: [ProcurementStatus.IN_PROGRESS, ProcurementStatus.CANCELLED], IN_PROGRESS: [ProcurementStatus.COMPLETED, ProcurementStatus.CANCELLED, ProcurementStatus.FAILED], COMPLETED: [], CANCELLED: [], FAILED: [] };
	if (!allowed[record.status].includes(status)) throw new ApiError(409, "INVALID_PROCUREMENT_TRANSITION", "The requested procurement transition is not allowed.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const posthumous = status === ProcurementStatus.COMPLETED && record.organ.donor.donorType === "POSTHUMOUS_INTENT";
		const preservationMethod = record.organ.organType === OrganType.CORNEA ? PreservationMethod.CORNEAL_STORAGE_MEDIUM : PreservationMethod.STATIC_COLD_STORAGE;
		const policies = posthumous ? await tx.organPreservationPolicy.findMany({ where: { organType: record.organ.organType, method: preservationMethod, active: true, OR: [{ institutionId: record.organ.institutionId }, { institutionId: null }] }, orderBy: { createdAt: "asc" } }) : [];
		const preservationPolicy = policies.find((policy) => policy.institutionId === record.organ.institutionId) ?? policies.find((policy) => policy.institutionId === null);
		if (posthumous && !preservationPolicy) throw new ApiError(409, "PRESERVATION_POLICY_REQUIRED", `Apply the database preservation policy migration before completing retrieval for ${record.organ.organType.toLowerCase()}.`);
		const updated = await tx.organProcurement.update({ where: { id: record.id }, data: { status, startedAt: status === ProcurementStatus.IN_PROGRESS ? now : undefined, completedAt: status === ProcurementStatus.COMPLETED ? now : undefined, retrievalTime: status === ProcurementStatus.COMPLETED ? now : undefined } });
		const organStatus = status === ProcurementStatus.IN_PROGRESS ? OrganStatus.RETRIEVAL_IN_PROGRESS : status === ProcurementStatus.COMPLETED ? posthumous && preservationPolicy ? OrganStatus.PRESERVING : OrganStatus.RETRIEVED : status === ProcurementStatus.CANCELLED || status === ProcurementStatus.FAILED ? OrganStatus.CANCELLED : undefined;
		if (organStatus) {
			await tx.organRecord.update({ where: { id: record.organ.id }, data: { status: organStatus, retrievalTime: status === ProcurementStatus.COMPLETED ? now : undefined, ...(posthumous && preservationPolicy ? { preservationMethod: preservationPolicy.method, preservationStartTime: now, coldIschemiaStart: now } : {}) } });
			if (posthumous && status === ProcurementStatus.COMPLETED) await tx.organDonor.updateMany({ where: { id: record.organ.donorId, status: { in: [OrganDonorStatus.REGISTERED, OrganDonorStatus.ACTIVE] } }, data: { status: OrganDonorStatus.FULFILLED } });
			await addEvent(tx, { organId: record.organ.id, actor, eventType: status === ProcurementStatus.IN_PROGRESS ? "PROCUREMENT_STARTED" : status === ProcurementStatus.COMPLETED ? "PROCUREMENT_COMPLETED" : "PROCUREMENT_CANCELLED", fromStatus: record.organ.status, toStatus: organStatus, metadata: posthumous && preservationPolicy ? { preservationMethod: preservationPolicy.method, preservationStartedAtRetrieval: true } : undefined });
		}
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: `PROCUREMENT_${status}`, entityType: "OrganProcurement", entityId: record.id } });
		return updated;
	});
}
export async function listOrganProcurements(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	return database.organProcurement.findMany({ where: institutionId ? { procurementCentreId: institutionId } : undefined, include: { organ: { select: { id: true, reference: true, organType: true, status: true, transplantScheduledAt: true } } }, orderBy: { scheduledAt: "desc" }, take: 100 });
}
