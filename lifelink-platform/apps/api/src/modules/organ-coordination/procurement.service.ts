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

import { addEvent, assertInstitution, requireInstitution } from './shared';

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
