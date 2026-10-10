import { OrganDonorStatus, OrganRecipientStatus, RequestStatus, RequestType } from "@prisma/client";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { database, findUserById, saveUser } from "@lifelink/database";
import { z } from "zod";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  profileUpdateSchema,
  validateRequest,
  validateUuidParams,
} from "../../middleware/validation";
import { serializeDonorForActor } from "../../security/field-policy";
import { recordAuditEvent } from "../audit/service";

// Define profile and account-management endpoints for authenticated users.
export function registerUserRoutes(router = Router()) {
  router.get("/me", authenticateRequest(), asyncRoute(getUserProfile));
  router.get("/me/request-analytics", authenticateRequest(), asyncRoute(getMyRequestAnalytics));
  router.get(
    "/:userId",
    authenticateRequest(),
    validateUuidParams("userId"),
    asyncRoute(getUserProfile),
  );
  router.patch(
    "/me",
    authenticateRequest(),
    authorizeAction(),
    validateRequest(profileUpdateSchema),
    asyncRoute(updateUserProfile),
  );
  return router;
}

const requestAnalyticsQuery = z.object({
  range: z.enum(["7d", "30d", "90d", "365d"]).default("30d"),
  status: z.enum(["ALL", "OPEN", "COMPLETED", "CLOSED"]).default("ALL"),
  interval: z.enum(["DAY", "WEEK", "MONTH"]).default("DAY"),
});

async function getMyRequestAnalytics(request: Request, response: Response) {
  const actor = request.auth!;
  if (actor.principalType !== "USER" || !["USER", "ADMINISTRATOR"].includes(actor.role) || !actor.userId) {
    response.status(403).json({ code: "PERSONAL_ACCOUNT_REQUIRED", message: "Sign in with a personal account to view your request analytics." });
    return;
  }
  const parsed = requestAnalyticsQuery.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({ code: "VALIDATION_FAILED", message: "Request analytics filters are invalid." });
    return;
  }
  const { range, status, interval } = parsed.data;
  const to = new Date();
  const from = new Date(to.getTime() - Number.parseInt(range, 10) * 24 * 60 * 60 * 1000);
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
    database.request.findMany({ where: { requestType: RequestType.BLOOD, requestDate: { gte: from, lte: to }, OR: [{ createdById: actor.userId }, { recipients: { some: { userId: actor.userId } } }], ...(bloodStatuses ? { status: { in: bloodStatuses } } : {}) }, select: { requestDate: true, status: true } }),
    database.organDonor.findMany({ where: { userId: actor.userId, createdAt: { gte: from, lte: to }, ...(donorStatuses ? { status: { in: donorStatuses } } : {}) }, select: { createdAt: true, status: true } }),
    database.organRecipient.findMany({ where: { userId: actor.userId, createdAt: { gte: from, lte: to }, ...(recipientStatuses ? { status: { in: recipientStatuses } } : {}) }, select: { createdAt: true, status: true } }),
  ]);
  const bucketDate = (value: Date) => {
    const bucket = new Date(value);
    bucket.setUTCHours(0, 0, 0, 0);
    if (interval === "WEEK") bucket.setUTCDate(bucket.getUTCDate() - ((bucket.getUTCDay() + 6) % 7));
    if (interval === "MONTH") bucket.setUTCDate(1);
    return bucket;
  };
  const buckets = new Map<string, { bloodTotal: number; bloodFulfilled: number; organTotal: number; organFulfilled: number }>();
  const cursor = bucketDate(from);
  const lastBucket = bucketDate(to);
  while (cursor <= lastBucket) {
    buckets.set(cursor.toISOString().slice(0, 10), { bloodTotal: 0, bloodFulfilled: 0, organTotal: 0, organFulfilled: 0 });
    if (interval === "DAY") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else if (interval === "WEEK") cursor.setUTCDate(cursor.getUTCDate() + 7);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const addCount = (createdAt: Date, kind: "blood" | "organ", fulfilled: boolean) => {
    const bucket = buckets.get(bucketDate(createdAt).toISOString().slice(0, 10));
    if (!bucket) return;
    bucket[`${kind}Total`] += 1;
    if (fulfilled) bucket[`${kind}Fulfilled`] += 1;
  };
  bloodRequests.forEach(({ requestDate, status: requestStatus }) => addCount(requestDate, "blood", requestStatus === RequestStatus.FULFILLED));
  donors.forEach(({ createdAt, status: donorStatus }) => addCount(createdAt, "organ", donorStatus === OrganDonorStatus.FULFILLED));
  recipients.forEach(({ createdAt, status: recipientStatus }) => addCount(createdAt, "organ", recipientStatus === OrganRecipientStatus.CLOSED));
  const rate = (fulfilled: number, total: number) => total ? Math.round(fulfilled * 100 / total) : null;
  response.json({ range, status, interval, from: from.toISOString(), to: to.toISOString(), series: [...buckets].map(([date, counts]) => ({ date, blood: rate(counts.bloodFulfilled, counts.bloodTotal), organ: rate(counts.organFulfilled, counts.organTotal) })) });
}

// Read a profile only for its owner or an administrator.
export async function getUserProfile(request: Request, response: Response) {
  if (request.auth?.principalType !== "USER" || !request.auth.userId) {
    response.status(403).json({ code: "FORBIDDEN", message: "This profile belongs to a user account." });
    return;
  }
  const requestedId = request.params.userId
    ? String(request.params.userId)
    : request.auth.userId;
  if (
    !requestedId ||
    (requestedId !== request.auth?.userId &&
      request.auth?.role !== "ADMINISTRATOR")
  ) {
    response
      .status(403)
      .json({ code: "FORBIDDEN", message: "Profile access is restricted." });
    return;
  }

  const user = await findUserById(requestedId);
  if (!user) {
    response
      .status(404)
      .json({ code: "USER_NOT_FOUND", message: "User not found." });
    return;
  }

  const {
    id,
    name,
    email,
    phone,
    role,
    status,
    createdAt,
    updatedAt,
    donorProfile,
    recipientProfile,
  } = user;
  response.json({
    id,
    name,
    email,
    phone,
    role,
    status,
    createdAt,
    updatedAt,
    donorProfile: donorProfile
      ? serializeDonorForActor(donorProfile, request.auth)
      : null,
    recipientProfile,
  });
}

// Update only permitted self-service profile fields and audit the change.
export async function updateUserProfile(request: Request, response: Response) {
  const userId = request.auth?.userId;
  if (!userId) {
    response
      .status(401)
      .json({ code: "AUTH_REQUIRED", message: "Authentication required." });
    return;
  }

  const user = await saveUser(userId, request.body);
  await recordAuditEvent({
    actorId: userId,
    action: "USER_PROFILE_UPDATED",
    entityType: "User",
    entityId: userId,
    metadata: { fields: Object.keys(request.body) },
  });
  response.json({
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    updatedAt: user.updatedAt,
  });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
