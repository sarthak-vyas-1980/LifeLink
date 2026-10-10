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

import { addEvent, assertInstitution, findPreservationPolicy, requireInstitution } from '../organ-coordination/shared';

export function calculatePreservationClock(input: { start: Date | null; maximumHours: number; warningHours: number; criticalHours: number; now?: Date }) {
	if (!input.start) return { status: PreservationStatus.NOT_STARTED, elapsedMs: 0, remainingMs: input.maximumHours * 3_600_000 };
	const elapsedMs = Math.max(0, (input.now ?? new Date()).getTime() - input.start.getTime());
	const remainingMs = input.maximumHours * 3_600_000 - elapsedMs;
	const status = remainingMs <= 0 ? PreservationStatus.EXPIRED : remainingMs <= input.criticalHours * 3_600_000 ? PreservationStatus.CRITICAL : remainingMs <= input.warningHours * 3_600_000 ? PreservationStatus.WARNING : PreservationStatus.NORMAL;
	return { status, elapsedMs, remainingMs: Math.max(0, remainingMs) };
}
export async function startOrganPreservation(actor: AuthContext, organId: string, input: { method: PreservationMethod; solution?: string }) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, status: true, organType: true, preservationStartTime: true, donor: { select: { donorType: true } } } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	await assertInstitution(actor, organ.institutionId);
	if (organ.donor.donorType !== "POSTHUMOUS_INTENT") throw new ApiError(409, "PRESERVATION_NOT_APPLICABLE", "The inventory preservation timer is only used for posthumous donor cases.");
	if (organ.status !== OrganStatus.RETRIEVED || organ.preservationStartTime) throw new ApiError(409, "PRESERVATION_NOT_ALLOWED", "Preservation can start once retrieval is recorded.");
	const policy = await findPreservationPolicy(organ.organType, input.method, organ.institutionId);
	if (!policy) throw new ApiError(409, "PRESERVATION_POLICY_REQUIRED", "An active configurable operational timing policy is required.");
	return database.$transaction(async (tx) => {
		const now = new Date();
		const started = await tx.organRecord.updateMany({ where: { id: organId, status: OrganStatus.RETRIEVED, preservationStartTime: null }, data: { status: OrganStatus.PRESERVING, preservationStartTime: now, coldIschemiaStart: now, preservationMethod: input.method, preservationSolution: input.solution } });
		if (!started.count) throw new ApiError(409, "PRESERVATION_NOT_ALLOWED", "Preservation has already started or the organ state changed.");
		const updated = await tx.organRecord.findUniqueOrThrow({ where: { id: organId } });
		await addEvent(tx, { organId, actor, eventType: "ORGAN_PRESERVATION_STARTED", fromStatus: organ.status, toStatus: OrganStatus.PRESERVING, metadata: { method: input.method, policyLabel: policy.label } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_PRESERVATION_STARTED", entityType: "OrganRecord", entityId: organId, metadata: { method: input.method, policyLabel: policy.label } } });
		return { organ: updated, policy: { method: policy.method, targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label }, clock: calculatePreservationClock({ start: now, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }) };
	});
}

export async function getOrganPreservationPolicy(actor: AuthContext, organType: OrganType, method: PreservationMethod) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const policy = institutionId ? await findPreservationPolicy(organType, method, institutionId) : await database.organPreservationPolicy.findFirst({ where: { organType, method, active: true, institutionId: null } });
	return { policy, disclaimer: "Operational timing configuration; not a clinical rule." };
}
export async function getOrganPreservation(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true, organType: true, preservationStartTime: true, preservationMethod: true } });
	if (!organ) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	if (!organ.preservationMethod) return { organ, policy: null, clock: { status: PreservationStatus.NOT_STARTED, elapsedMs: 0, remainingMs: 0 }, disclaimer: "Operational timing indicator; clinical suitability is determined by authorized professionals." };
	const policy = await findPreservationPolicy(organ.organType, organ.preservationMethod, organ.institutionId);
	if (!policy) return { organ, policy: null, clock: null, disclaimer: "Operational timing policy is not configured." };
	return { organ, policy: { targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label }, clock: calculatePreservationClock({ start: organ.preservationStartTime, maximumHours: policy.maximumHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours }), disclaimer: "Operational timing indicator; clinical suitability is determined by authorized professionals." };
}
export async function checkOrganPreservationAlerts(now = new Date()) {
	const activeStatuses = [OrganStatus.PRESERVING, OrganStatus.OFFERED, OrganStatus.ACCEPTED, OrganStatus.FINAL_ASSESSMENT, OrganStatus.ALLOCATED];
	const active = await database.organRecord.findMany({ where: { status: { in: activeStatuses }, preservationStartTime: { not: null }, preservationMethod: { not: null } }, select: { id: true, institutionId: true, organType: true, preservationMethod: true, preservationStartTime: true, reference: true, status: true } });
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
			const updated = clock.status === PreservationStatus.EXPIRED
				? await tx.organRecord.updateMany({ where: { id: organ.id, status: { in: activeStatuses } }, data: { status: OrganStatus.EXPIRED } })
				: { count: 0 };
			await addEvent(tx, { organId: organ.id, eventType, fromStatus: organ.status, toStatus: updated.count ? OrganStatus.EXPIRED : organ.status, metadata: { reference: organ.reference, preservationStatus: clock.status, remainingMs: clock.remainingMs, policyLabel: policy.label }, institutionIds: [organ.institutionId] });
			await tx.auditLog.create({ data: { action: eventType, entityType: "OrganRecord", entityId: organ.id, metadata: { preservationStatus: clock.status, policyLabel: policy.label } } });
			alertsCreated++;
		});
	}
	return alertsCreated;
}
export async function upsertOrganPreservationPolicy(actor: AuthContext, input: { institutionId?: string; organType: OrganType; method: PreservationMethod; targetHours: number; warningHours: number; criticalHours: number; maximumHours: number; label: string }) {
	return database.$transaction(async (tx) => {
		const prior = await tx.organPreservationPolicy.findFirst({ where: { institutionId: input.institutionId ?? null, organType: input.organType, method: input.method } });
		const policy = !prior ? await tx.organPreservationPolicy.create({ data: { ...input, institutionId: input.institutionId } }) : await tx.organPreservationPolicy.update({ where: { id: prior.id }, data: { targetHours: input.targetHours, warningHours: input.warningHours, criticalHours: input.criticalHours, maximumHours: input.maximumHours, label: input.label, active: true } });
		await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_PRESERVATION_POLICY_UPDATED", entityType: "OrganPreservationPolicy", entityId: policy.id, metadata: { organType: policy.organType, method: policy.method, targetHours: policy.targetHours, warningHours: policy.warningHours, criticalHours: policy.criticalHours, maximumHours: policy.maximumHours, label: policy.label } } });
		return policy;
	});
}
