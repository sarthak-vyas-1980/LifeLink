import { Router, type Request, type RequestHandler, type Response } from "express";
import type { Prisma } from "@prisma/client";
import { database } from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";

// Return only audit events performed by the authenticated personal or institution account.
export function registerAuditRoutes(router = Router()) {
  router.get("/", authenticateRequest(), asyncRoute(async (request, response) => {
    const actor = request.auth!;
    const page = parsePositiveInteger(request.query.page, 1);
    const pageSize = parsePositiveInteger(request.query.pageSize, 10);
    if (!page || !pageSize || pageSize > 100) {
      response.status(400).json({ code: "INVALID_PAGINATION", message: "Page must be positive and page size must be from 1 to 100." });
      return;
    }

    const operational = request.query.scope === "operational" && actor.principalType === "INSTITUTION" && actor.institutionId;
    const where: Prisma.AuditLogWhereInput | null = operational
      ? await institutionOperationalAuditWhere(actor.institutionId!)
      : actor.principalType === "INSTITUTION" && actor.institutionId
        ? { actorInstitutionId: actor.institutionId, entityType: "Institution", entityId: actor.institutionId }
        : actor.userId
          ? { actorId: actor.userId }
          : null;
    if (!where) {
      response.json({ events: [], pagination: { page, pageSize, total: 0, totalPages: 0 } });
      return;
    }

    const [events, total] = await Promise.all([
      database.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, actorId: true, actorInstitutionId: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true },
      }),
      database.auditLog.count({ where }),
    ]);
    response.json({ events, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  }));
  return router;
}

async function institutionOperationalAuditWhere(institutionId: string): Promise<Prisma.AuditLogWhereInput> {
  const [inventory, requests, donors, recipients, organs, policies] = await Promise.all([
    database.bloodInventory.findMany({ where: { institutionId }, select: { id: true } }),
    database.request.findMany({ where: { OR: [{ createdByInstitutionId: institutionId }, { matches: { some: { providerInstitutionId: institutionId } } }] }, select: { id: true } }),
    database.organDonor.findMany({ where: { institutionId }, select: { id: true } }),
    database.organRecipient.findMany({ where: { institutionId }, select: { id: true } }),
    database.organRecord.findMany({ where: { OR: [{ institutionId }, { currentLocationId: institutionId }, { destinationCentreId: institutionId }] }, select: { id: true } }),
    database.organPreservationPolicy.findMany({ where: { institutionId }, select: { id: true } }),
  ]);
  const requestIds = requests.map(({ id }) => id);
  const organIds = organs.map(({ id }) => id);
  const donorIds = donors.map(({ id }) => id);
  const recipientIds = recipients.map(({ id }) => id);
  const inventoryIds = inventory.map(({ id }) => id);
  const [matches, consents, organMatches, offers, procurements] = await Promise.all([
    database.match.findMany({ where: { OR: [{ providerInstitutionId: institutionId }, { requestId: { in: requestIds } }, { bloodInventoryId: { in: inventoryIds } }] }, select: { id: true } }),
    database.organConsent.findMany({ where: { donorId: { in: donorIds } }, select: { id: true } }),
    database.organMatch.findMany({ where: { OR: [{ organId: { in: organIds } }, { recipientId: { in: recipientIds } }] }, select: { id: true } }),
    database.organOffer.findMany({ where: { OR: [{ offeringCentreId: institutionId }, { receivingCentreId: institutionId }, { organId: { in: organIds } }, { recipientId: { in: recipientIds } }] }, select: { id: true } }),
    database.organProcurement.findMany({ where: { OR: [{ procurementCentreId: institutionId }, { organId: { in: organIds } }] }, select: { id: true } }),
  ]);
  const entityIds = (rows: Array<{ id: string }>) => rows.map(({ id }) => id);
  const relatedRecords: Prisma.AuditLogWhereInput[] = [
    { entityType: "Institution", entityId: institutionId, OR: [{ actorInstitutionId: null }, { actorInstitutionId: { not: institutionId } }] },
  ];
  const addRelatedRecords = (entityType: string, ids: string[]) => {
    if (ids.length) relatedRecords.push({ entityType, entityId: { in: ids } });
  };
  addRelatedRecords("BloodInventory", inventoryIds);
  addRelatedRecords("Request", requestIds);
  addRelatedRecords("Match", entityIds(matches));
  addRelatedRecords("OrganDonor", donorIds);
  addRelatedRecords("OrganConsent", entityIds(consents));
  addRelatedRecords("OrganRecipient", recipientIds);
  addRelatedRecords("OrganRecord", organIds);
  addRelatedRecords("OrganMatch", entityIds(organMatches));
  addRelatedRecords("OrganOffer", entityIds(offers));
  addRelatedRecords("OrganProcurement", entityIds(procurements));
  addRelatedRecords("OrganPreservationPolicy", entityIds(policies));
  return {
    OR: [
      ...relatedRecords,
    ],
  };
}

function parsePositiveInteger(value: unknown, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler {
  return (request, response, next) => { void Promise.resolve(handler(request, response)).catch(next); };
}
