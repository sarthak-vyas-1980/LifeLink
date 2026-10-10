import { InstitutionStatus, InstitutionType, OrganDonorStatus, OrganRecipientStatus, RequestStatus, RequestType } from "@prisma/client";
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
const requestAnalyticsQuery = z.object({
  range: z.enum(["7d", "30d", "90d", "365d"]).default("30d"),
  status: z.enum(["ALL", "OPEN", "COMPLETED", "CLOSED"]).default("ALL"),
  interval: z.enum(["DAY", "WEEK", "MONTH"]).default("DAY"),
});

export function registerInstitutionRoutes(router = Router()) {
  router.get("/me", authenticateRequest(), asyncRoute(getMyInstitution));
  router.get("/me/request-analytics", authenticateRequest(), asyncRoute(getMyRequestAnalytics));
  router.get("/", authenticateRequest(), asyncRoute(discoverInstitutions));
  return router;
}

export async function getMyRequestAnalytics(request: Request, response: Response) {
  const actor = request.auth!;
  if (actor.principalType !== "INSTITUTION" || !actor.institutionId) throw new ApiError(403, "INSTITUTION_ACCOUNT_REQUIRED", "Sign in with an institution account to view its analytics.");
  const parsed = requestAnalyticsQuery.safeParse(request.query);
  if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", "Request analytics filters are invalid.");

  const { range, status, interval } = parsed.data;
  const rangeDays = Number.parseInt(range, 10);
  const to = new Date();
  const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60 * 1000);
  const bloodStatuses = status === "OPEN"
    ? [RequestStatus.CREATED, RequestStatus.UNDER_REVIEW, RequestStatus.SEARCHING_MATCHING, RequestStatus.INSTITUTIONS_NOTIFIED, RequestStatus.OFFERS_RECEIVED, RequestStatus.OFFER_EVALUATION, RequestStatus.OFFER_ACCEPTED, RequestStatus.RESERVED, RequestStatus.IN_TRANSIT, RequestStatus.REOPENED]
    : status === "COMPLETED" ? [RequestStatus.FULFILLED]
      : status === "CLOSED" ? [RequestStatus.CANCELLED, RequestStatus.REJECTED, RequestStatus.EXPIRED] : undefined;
  const donorStatuses = status === "OPEN" ? [OrganDonorStatus.REGISTERED, OrganDonorStatus.ACTIVE]
    : status === "COMPLETED" ? [OrganDonorStatus.FULFILLED]
      : status === "CLOSED" ? [OrganDonorStatus.CLOSED] : undefined;
  const recipientStatuses = status === "OPEN" ? [OrganRecipientStatus.PENDING_REVIEW, OrganRecipientStatus.ACTIVE, OrganRecipientStatus.MATCHED]
    : status === "COMPLETED" ? [OrganRecipientStatus.CLOSED]
      : status === "CLOSED" ? [OrganRecipientStatus.REJECTED, OrganRecipientStatus.CANCELLED] : undefined;

  const [bloodRequests, donors, recipients] = await Promise.all([
    database.request.findMany({
      where: { requestType: RequestType.BLOOD, requestDate: { gte: from, lte: to }, OR: [{ createdByInstitutionId: actor.institutionId }, { matches: { some: { providerInstitutionId: actor.institutionId } } }], ...(bloodStatuses ? { status: { in: bloodStatuses } } : {}) },
      select: { requestDate: true, status: true },
    }),
    database.organDonor.findMany({ where: { institutionId: actor.institutionId, createdAt: { gte: from, lte: to }, ...(donorStatuses ? { status: { in: donorStatuses } } : {}) }, select: { createdAt: true, status: true } }),
    database.organRecipient.findMany({ where: { institutionId: actor.institutionId, createdAt: { gte: from, lte: to }, ...(recipientStatuses ? { status: { in: recipientStatuses } } : {}) }, select: { createdAt: true, status: true } }),
  ]);

  const bucketDate = (value: Date) => {
    const bucket = new Date(value);
    bucket.setUTCHours(0, 0, 0, 0);
    if (interval === "WEEK") bucket.setUTCDate(bucket.getUTCDate() - ((bucket.getUTCDay() + 6) % 7));
    if (interval === "MONTH") bucket.setUTCDate(1);
    return bucket;
  };
  const buckets = new Map<string, { bloodTotal: number; bloodFulfilled: number; organTotal: number; organFulfilled: number }>();
  const firstBucket = bucketDate(from);
  const lastBucket = bucketDate(to);
  const cursor = new Date(firstBucket);
  while (cursor <= lastBucket) {
    buckets.set(cursor.toISOString().slice(0, 10), { bloodTotal: 0, bloodFulfilled: 0, organTotal: 0, organFulfilled: 0 });
    if (interval === "DAY") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (interval === "WEEK") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const addCount = (createdAt: Date, key: "blood" | "organ", fulfilled: boolean) => {
    const bucketKey = bucketDate(createdAt).toISOString().slice(0, 10);
    const bucket = buckets.get(bucketKey);
    if (!bucket) return;
    bucket[`${key}Total`] += 1;
    if (fulfilled) bucket[`${key}Fulfilled`] += 1;
  };
  bloodRequests.forEach(({ requestDate, status: requestStatus }) => addCount(requestDate, "blood", requestStatus === RequestStatus.FULFILLED));
  donors.forEach(({ createdAt, status: donorStatus }) => addCount(createdAt, "organ", donorStatus === OrganDonorStatus.FULFILLED));
  recipients.forEach(({ createdAt, status: recipientStatus }) => addCount(createdAt, "organ", recipientStatus === OrganRecipientStatus.CLOSED));

  const rate = (fulfilled: number, total: number) => total ? Math.round(fulfilled * 100 / total) : null;
  response.json({ range, status, interval, from: from.toISOString(), to: to.toISOString(), series: [...buckets].map(([date, counts]) => ({ date, blood: rate(counts.bloodFulfilled, counts.bloodTotal), organ: rate(counts.organFulfilled, counts.organTotal) })) });
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
