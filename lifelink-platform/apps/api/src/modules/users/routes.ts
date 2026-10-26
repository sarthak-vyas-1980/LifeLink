import { OrganDonorStatus, OrganRecipientStatus, RequestStatus, RequestType } from "@prisma/client";
import { Router, type Request, type RequestHandler, type Response } from "express";
import { database, findUserById, saveUser } from "@lifelink/database";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { authenticateRequest } from "../../middleware/auth";
import { invalidateAuthenticatedSession } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
  profileUpdateSchema,
  emailChangeSchema,
  passwordChangeSchema,
  notificationPreferencesSchema,
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
  router.patch("/me/notification-preferences", authenticateRequest(), asyncRoute(updateUserNotificationPreferences));
  router.patch("/me/email", authenticateRequest(), asyncRoute(changeUserEmail));
  router.post("/me/password", authenticateRequest(), validateRequest(passwordChangeSchema), asyncRoute(changeUserPassword));
  router.delete("/me", authenticateRequest(), asyncRoute(softDeleteUserAccount));
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
    ? [RequestStatus.CREATED, RequestStatus.UNDER_REVIEW, RequestStatus.SEARCHING_MATCHING, RequestStatus.INSTITUTIONS_NOTIFIED, RequestStatus.OFFERS_RECEIVED, RequestStatus.OFFER_EVALUATION, RequestStatus.OFFER_ACCEPTED, RequestStatus.RESERVED, RequestStatus.REOPENED]
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
  bloodRequests.forEach(({ requestDate }) => addCount(requestDate, "blood", false));
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
    address,
    notificationPreferences,
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
    address,
    notificationPreferences,
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
    address: user.address,
    notificationPreferences: user.notificationPreferences,
    updatedAt: user.updatedAt,
  });
}

export async function updateUserNotificationPreferences(request: Request, response: Response) {
  const userId = request.auth?.principalType === "USER" ? request.auth.userId : undefined;
  if (!userId) { response.status(403).json({ code: "PERSONAL_ACCOUNT_REQUIRED", message: "Use a personal account to change these preferences." }); return; }
  const parsed = notificationPreferencesSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ code: "VALIDATION_FAILED", message: "Emergency notifications must remain enabled.", fieldErrors: parsed.error.flatten().fieldErrors }); return; }
  const preferences = parsed.data;
  await database.user.update({ where: { id: userId }, data: { notificationPreferences: preferences } });
  await recordAuditEvent({ actorId: userId, action: "USER_NOTIFICATION_PREFERENCES_UPDATED", entityType: "User", entityId: userId });
  response.json({ notificationPreferences: preferences });
}

export async function changeUserEmail(request: Request, response: Response) {
  const userId = request.auth?.principalType === "USER" ? request.auth.userId : undefined;
  if (!userId) { response.status(403).json({ code: "PERSONAL_ACCOUNT_REQUIRED", message: "Use a personal account to change this login email." }); return; }
  const parsed = emailChangeSchema.safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ code: "VALIDATION_FAILED", message: "Enter a valid email and your current password.", fieldErrors: parsed.error.flatten().fieldErrors }); return; }
  const user = await database.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true, deletedAt: true } });
  if (!user || user.deletedAt || !(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) { response.status(401).json({ code: "CURRENT_PASSWORD_INVALID", message: "Current password is incorrect." }); return; }
  const email = parsed.data.email.toLowerCase().trim();
  if (email !== user.email.toLowerCase()) {
    const existing = await database.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, NOT: { id: userId } }, select: { id: true } });
    if (existing) { response.status(409).json({ code: "EMAIL_IN_USE", message: "That email address is already linked to another account." }); return; }
  }
  await database.user.update({ where: { id: userId }, data: { email } });
  await recordAuditEvent({ actorId: userId, action: "USER_EMAIL_CHANGED", entityType: "User", entityId: userId });
  response.json({ email });
}

export async function changeUserPassword(request: Request, response: Response) {
  const userId = request.auth?.principalType === "USER" ? request.auth.userId : undefined;
  if (!userId) { response.status(403).json({ code: "PERSONAL_ACCOUNT_REQUIRED", message: "Use a personal account to change this password." }); return; }
  const user = await database.user.findUnique({ where: { id: userId }, select: { passwordHash: true, deletedAt: true } });
  if (!user || user.deletedAt || !(await bcrypt.compare(request.body.currentPassword, user.passwordHash))) { response.status(401).json({ code: "CURRENT_PASSWORD_INVALID", message: "Current password is incorrect." }); return; }
  const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  const changedAt = new Date();
  await database.user.update({ where: { id: userId }, data: { passwordHash: await bcrypt.hash(request.body.newPassword, 12), credentialsChangedAt: changedAt } });
  await recordAuditEvent({ actorId: userId, action: "USER_PASSWORD_CHANGED", entityType: "User", entityId: userId });
  if (token) invalidateAuthenticatedSession(token);
  response.json({ changed: true, signedOut: true });
}

export async function softDeleteUserAccount(request: Request, response: Response) {
  const userId = request.auth?.principalType === "USER" ? request.auth.userId : undefined;
  if (!userId) { response.status(403).json({ code: "PERSONAL_ACCOUNT_REQUIRED", message: "Use a personal account to close this account." }); return; }
  const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(request.body);
  if (!parsed.success) { response.status(400).json({ code: "PASSWORD_REQUIRED", message: "Enter your password to confirm account closure." }); return; }
  const user = await database.user.findUnique({ where: { id: userId }, select: { passwordHash: true, deletedAt: true } });
  if (!user || user.deletedAt || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) { response.status(401).json({ code: "PASSWORD_INVALID", message: "Password is incorrect." }); return; }
  await database.user.update({ where: { id: userId }, data: { deletedAt: new Date(), status: "INACTIVE", email: `deleted+${userId}@deleted.lifelink.invalid` } });
  await recordAuditEvent({ actorId: userId, action: "USER_ACCOUNT_SOFT_DELETED", entityType: "User", entityId: userId });
  const token = request.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token) invalidateAuthenticatedSession(token);
  response.json({ deleted: true, softDeleted: true, signedOut: true });
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
