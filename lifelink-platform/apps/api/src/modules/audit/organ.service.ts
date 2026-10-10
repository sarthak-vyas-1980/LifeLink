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

import { requireInstitution } from '../organ-coordination/shared';

export async function listOrganAudit(actor: AuthContext, organId: string) {
	const organ = await database.organRecord.findUnique({ where: { id: organId }, select: { id: true, institutionId: true } });
	if (!organ || actor.role !== "ADMINISTRATOR" && actor.institutionId !== organ.institutionId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
	const [events, donor, matches, offers, procurements] = await Promise.all([
		database.organWorkflowEvent.findMany({ where: { organId }, orderBy: { createdAt: "desc" }, take: 100 }),
		database.organDonor.findFirst({ where: { organs: { some: { id: organId } } }, select: { id: true } }),
		database.organMatch.findMany({ where: { organId }, select: { id: true } }),
		database.organOffer.findMany({ where: { organId }, select: { id: true } }),
		database.organProcurement.findMany({ where: { organId }, select: { id: true } }),
	]);
	const entityIds = [organId, ...(donor ? [donor.id] : []), ...matches.map(({ id }) => id), ...offers.map(({ id }) => id), ...procurements.map(({ id }) => id)];
	const audit = await database.auditLog.findMany({ where: { entityId: { in: entityIds } }, orderBy: { createdAt: "desc" }, take: 100 });
	return [...events, ...audit.map((row) => ({ id: `audit-${row.id}`, organId, eventType: row.action, fromStatus: null, toStatus: null, actorId: row.actorId, institutionId: row.actorInstitutionId, metadata: row.metadata, createdAt: row.createdAt, audit: true }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 150);
}
export async function listAllOrganAudit(actor: AuthContext) {
	const institutionId = actor.role === "ADMINISTRATOR" ? undefined : requireInstitution(actor);
	const where = institutionId ? { OR: [{ institutionId }, { organ: { institutionId } }] } : undefined;
	const events = await database.organWorkflowEvent.findMany({ where, include: { organ: { select: { reference: true, organType: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
	const visibleOrgans = institutionId ? await database.organRecord.findMany({ where: { institutionId }, select: { id: true, reference: true, organType: true } }) : [];
	const visibleDonors = institutionId ? await database.organDonor.findMany({ where: { institutionId }, select: { id: true } }) : [];
	const visibleRecipients = institutionId ? await database.organRecipient.findMany({ where: { institutionId }, select: { id: true } }) : [];
	const visibleOrganIds = visibleOrgans.map(({ id }) => id);
	const related = institutionId ? await Promise.all([
		database.organMatch.findMany({ where: { OR: [{ organId: { in: visibleOrganIds } }, { recipientId: { in: visibleRecipients.map(({ id }) => id) } }] }, select: { id: true, organId: true } }),
		database.organOffer.findMany({ where: { OR: [{ organId: { in: visibleOrganIds } }, { offeringCentreId: institutionId }, { receivingCentreId: institutionId }] }, select: { id: true, organId: true } }),
		database.organProcurement.findMany({ where: { OR: [{ organId: { in: visibleOrganIds } }, { procurementCentreId: institutionId }] }, select: { id: true, organId: true } }),
	]) : [[], [], []];
	const entityToOrgan = new Map<string, { reference: string; organType: string }>();
	for (const organ of visibleOrgans) entityToOrgan.set(organ.id, organ);
	const [relatedMatches, relatedOffers, relatedProcurements] = related;
	for (const row of [...relatedMatches, ...relatedOffers, ...relatedProcurements]) { const organ = visibleOrgans.find((item) => item.id === row.organId); if (organ) entityToOrgan.set(row.id, organ); }
	for (const donor of visibleDonors) {
		const organ = await database.organRecord.findFirst({ where: { donorId: donor.id, institutionId }, select: { id: true, reference: true, organType: true } });
		if (organ) entityToOrgan.set(donor.id, organ);
	}
	const auditWhere = institutionId ? { entityId: { in: [...entityToOrgan.keys()] } } : { entityType: { in: ["OrganDonor", "OrganConsent", "OrganRecord", "OrganRecipient", "OrganMatch", "OrganOffer", "OrganProcurement", "OrganPreservationPolicy"] } };
	const audits = await database.auditLog.findMany({ where: auditWhere, orderBy: { createdAt: "desc" }, take: 200 });
	return [...events, ...audits.map((row) => ({ id: `audit-${row.id}`, entityId: row.entityId, organId: null, eventType: row.action, fromStatus: null, toStatus: null, institutionId: row.actorInstitutionId, metadata: row.metadata, createdAt: row.createdAt, organ: entityToOrgan.get(row.entityId) ?? null, audit: true }))].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 200);
}
