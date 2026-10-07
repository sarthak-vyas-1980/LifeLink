import { InstitutionStatus } from "@prisma/client";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { database } from "@lifelink/database";
import { ApiError } from "../../middleware/api-error";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import { validateUuidParams } from "../../middleware/validation";
import { getOrganDashboardMetrics } from "../inventories/organ.service";

export function registerAdminRoutes(router = Router()) {
  router.use(authenticateRequest(), authorizeAction("ADMINISTRATOR"));
  router.get("/audit", asyncRoute(async (req, res) => {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(10, Number.parseInt(String(req.query.pageSize ?? "50"), 10) || 50));
    const where = { entityType: { in: ["Institution", "OrganDonor", "OrganRecipient", "OrganRecord", "OrganConsent", "OrganMatch", "OrganOffer", "OrganProcurement"] } };
    const [events, total] = await Promise.all([
      database.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, select: { id: true, actorId: true, actorInstitutionId: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true } }),
      database.auditLog.count({ where }),
    ]);
    res.json({ events, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
  }));
  router.get("/overview", asyncRoute(async (req, res) => {
    const [institutions, institutionStatus, organMetrics, donorCounts, donorAuthorizations, recipientCounts, organStatuses, offers, procurements, activity] = await Promise.all([
      database.institution.findMany({ select: { id: true, name: true, type: true, status: true, address: true, createdAt: true, _count: { select: { organRecords: true, organDonors: true, organRecipients: true, organWorkflowEvents: true, offeringOrganOffers: true, receivingOrganOffers: true, organProcurements: true } } }, orderBy: { createdAt: "desc" }, take: 500 }),
      database.institution.groupBy({ by: ["status"], _count: { _all: true } }),
      getOrganDashboardMetrics(req.auth!),
      database.organDonor.groupBy({ by: ["institutionId", "status"], _count: { _all: true } }),
      database.organDonor.groupBy({ by: ["institutionId", "authorizationStatus"], _count: { _all: true } }),
      database.organRecipient.groupBy({ by: ["institutionId", "status"], _count: { _all: true } }),
      database.organRecord.groupBy({ by: ["institutionId", "status"], _count: { _all: true } }),
      database.organOffer.groupBy({ by: ["offeringCentreId", "status"], _count: { _all: true } }),
      database.organProcurement.groupBy({ by: ["procurementCentreId", "status"], _count: { _all: true } }),
      database.auditLog.findMany({ where: { entityType: { in: ["Institution", "OrganDonor", "OrganRecipient", "OrganRecord", "OrganConsent", "OrganMatch", "OrganOffer", "OrganProcurement"] } }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, actorId: true, actorInstitutionId: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true } }),
    ]);
    const counts = (rows: Array<{ institutionId?: string; offeringCentreId?: string; procurementCentreId?: string; status: string; _count: { _all: number } }>, id: string, field: "institutionId" | "offeringCentreId" | "procurementCentreId") => rows.filter((row) => row[field] === id).reduce<Record<string, number>>((result, row) => { result[row.status] = row._count._all; return result; }, {});
    res.json({ institutions: institutions.map((institution) => {
      const donors = counts(donorCounts, institution.id, "institutionId"); const authorizations = counts(donorAuthorizations.map(({ authorizationStatus, ...row }) => ({ ...row, status: authorizationStatus })), institution.id, "institutionId"); const recipients = counts(recipientCounts, institution.id, "institutionId"); const organs = counts(organStatuses, institution.id, "institutionId"); const institutionOffers = counts(offers, institution.id, "offeringCentreId"); const institutionProcurements = counts(procurements, institution.id, "procurementCentreId");
      const totalRequests = institution._count.organDonors + institution._count.organRecipients; const completed = (organs.COMPLETED ?? 0) + (organs.TRANSPLANTED ?? 0); const organCount = institution._count.organRecords;
      return { ...institution, analytics: { donorRequests: institution._count.organDonors, recipientRequests: institution._count.organRecipients, handledRequests: totalRequests, activeRequests: (donors.REGISTERED ?? 0) + (donors.ACTIVE ?? 0) + (recipients.PENDING_REVIEW ?? 0) + (recipients.ACTIVE ?? 0) + (recipients.MATCHED ?? 0), completed, cancelled: (recipients.CANCELLED ?? 0) + (organs.CANCELLED ?? 0), expired: (organs.EXPIRED ?? 0), rejected: (authorizations.REJECTED ?? 0) + (recipients.REJECTED ?? 0), matchingVolume: organs.MATCHING ?? 0, offerVolume: Object.values(institutionOffers).reduce((a, b) => a + b, 0), acceptedOffers: institutionOffers.ACCEPTED ?? 0, procurementVolume: Object.values(institutionProcurements).reduce((a, b) => a + b, 0), completionRate: organCount ? Math.round(completed * 100 / organCount) : 0, backlog: (donors.REGISTERED ?? 0) + (recipients.PENDING_REVIEW ?? 0), recentActivityCount: institution._count.organWorkflowEvents } };
    }), institutionStatus: Object.fromEntries(institutionStatus.map(({ status, _count }) => [status, _count._all])), organMetrics, activity });
  }));
  router.patch("/institutions/:institutionId/status", validateUuidParams("institutionId"), asyncRoute(async (req, res) => {
    const status = req.body?.status;
    if (!Object.values(InstitutionStatus).includes(status)) throw new ApiError(400, "VALIDATION_FAILED", "A valid institution status is required.");
    const institution = await database.institution.findUnique({ where: { id: String(req.params.institutionId) }, select: { id: true, status: true } });
    if (!institution) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution not found.");
    const updated = await database.$transaction(async (tx) => {
      const changed = await tx.institution.update({ where: { id: institution.id }, data: { status }, select: { id: true, name: true, status: true } });
      await tx.auditLog.create({ data: { actorId: req.auth!.userId, action: "INSTITUTION_STATUS_CHANGED", entityType: "Institution", entityId: institution.id, metadata: { fromStatus: institution.status, toStatus: status } } });
      return changed;
    });
    res.json(updated);
  }));
  return router;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler {
  return (request, response, next) => { void Promise.resolve(handler(request, response)).catch(next); };
}
