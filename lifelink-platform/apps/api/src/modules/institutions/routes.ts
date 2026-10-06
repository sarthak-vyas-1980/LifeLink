import { InstitutionStatus, InstitutionType } from "@prisma/client";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { searchInstitutions } from "@lifelink/database";
import { database } from "@lifelink/database";
import { z } from "zod";
import { authenticateRequest } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { calculateDistance } from "../maps/geospatial.service";

const discoveryQuery = z.object({
  type: z.nativeEnum(InstitutionType).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(500).optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)) context.addIssue({ code: "custom", path: ["latitude"], message: "Both coordinates are required." });
  if (value.radiusKm !== undefined && value.latitude === undefined) context.addIssue({ code: "custom", path: ["radiusKm"], message: "Coordinates are required for radius filtering." });
});

export function registerInstitutionRoutes(router = Router()) {
  router.get("/me", authenticateRequest(), asyncRoute(getMyInstitution));
  router.get("/", authenticateRequest(), asyncRoute(discoverInstitutions));
  return router;
}

export async function getMyInstitution(request: Request, response: Response) {
  const actor = request.auth!;
  if (actor.principalType !== "INSTITUTION" || !actor.institutionId) throw new ApiError(403, "INSTITUTION_ACCOUNT_REQUIRED", "Sign in with an institution account to open this workspace.");
  const institution = await database.institution.findUnique({ where: { id: actor.institutionId }, select: { id: true, name: true, type: true, status: true, address: true, contactPerson: true, contactNumber: true, hospitalProfile: { select: { emergencySupport: true, bloodService: { select: { id: true } }, organService: { select: { id: true } } } }, organCentreProfile: { select: { id: true } }, bloodBankProfile: { select: { id: true } } } });
  if (!institution) throw new ApiError(404, "INSTITUTION_NOT_FOUND", "Institution account was not found.");
  response.json({ institution, capabilities: { blood: institution.type === "BLOOD_BANK" || Boolean(institution.hospitalProfile?.bloodService), organ: institution.type === "ORGAN_CENTRE" || Boolean(institution.hospitalProfile?.organService), emergency: Boolean(institution.hospitalProfile?.emergencySupport) } });
}

// Publish only active, public discovery fields; private contacts stay behind institution workflows.
export async function discoverInstitutions(request: Request, response: Response) {
  const parsed = discoveryQuery.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ code: "VALIDATION_FAILED", message: "Institution search filters are invalid.", traceId: request.traceId, fieldErrors: parsed.error.flatten().fieldErrors });
    return;
  }
  const criteria = parsed.data;
  const institutions = await searchInstitutions({ status: InstitutionStatus.ACTIVE, ...(criteria.type ? { type: criteria.type } : {}) }, 500);
  const results = institutions.flatMap((institution) => {
    const hasCoordinates = criteria.latitude !== undefined && criteria.longitude !== undefined && institution.latitude !== null && institution.longitude !== null;
    const distanceKm = hasCoordinates ? calculateDistance(criteria.latitude!, criteria.longitude!, institution.latitude!, institution.longitude!) : undefined;
    if (criteria.radiusKm !== undefined && (distanceKm === undefined || distanceKm > criteria.radiusKm)) return [];
    return [{ id: institution.id, name: institution.name, type: institution.type, address: institution.address, latitude: institution.latitude, longitude: institution.longitude, distanceKm }];
  }).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  response.json({ institutions: results });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => { Promise.resolve(handler(request, response, next)).catch(next); };
}
