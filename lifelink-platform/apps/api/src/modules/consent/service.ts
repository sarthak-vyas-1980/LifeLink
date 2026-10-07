import { randomUUID } from "node:crypto";
import { ConsentStatus, NotificationStatus, NotificationType, OrganDonorStatus } from "@prisma/client";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { assertInstitution } from "../organ-coordination/shared";

export async function requestOrganDonorConsent(actor: AuthContext, donorId: string) {
  const donor = await database.organDonor.findUnique({ where: { id: donorId }, select: { id: true, reference: true, userId: true, institutionId: true, consentStatus: true, consents: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true, requestedAt: true } } } });
  if (!donor) throw new ApiError(404, "DONOR_NOT_FOUND", "Donor record not found.");
  await assertInstitution(actor, donor.institutionId);
  if (!donor.userId) throw new ApiError(409, "USER_CONSENT_UNAVAILABLE", "This institution-managed donor has no personal account for user consent.");
  const consent = donor.consents[0];
  if (!consent || consent.status !== ConsentStatus.PENDING || consent.requestedAt) throw new ApiError(409, "CONSENT_NOT_REQUESTABLE", "Consent can only be requested once while the donor interest is pending.");
  return database.$transaction(async (tx) => {
    const now = new Date();
    const changed = await tx.organConsent.updateMany({ where: { id: consent.id, status: ConsentStatus.PENDING, requestedAt: null }, data: { requestedAt: now, authorizedById: actor.userId } });
    if (!changed.count) throw new ApiError(409, "CONSENT_NOT_REQUESTABLE", "This consent request has already been sent.");
    const eventId = randomUUID();
    await tx.workflowEvent.create({ data: { id: eventId, eventType: "ORGAN_CONSENT_REQUESTED", actorId: actor.userId, actorInstitutionId: actor.institutionId, payload: { donorId, reference: donor.reference } } });
    await tx.notification.create({ data: { userId: donor.userId!, eventId, eventType: "ORGAN_CONSENT_REQUESTED", title: "Consent review requested", message: "An organ service asks you to review and respond to a consent request.", payload: { donorId, reference: donor.reference }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD } });
    await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: "ORGAN_CONSENT_REQUESTED", entityType: "OrganConsent", entityId: consent.id, metadata: { donorReference: donor.reference } } });
    return { requested: true, requestedAt: now };
  });
}

export async function listMyOrganConsents(actor: AuthContext) {
  if (actor.principalType !== "USER" || !["USER", "ADMINISTRATOR"].includes(actor.role) || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Sign in with a personal account to review consent.");
  return database.organConsent.findMany({ where: { donor: { userId: actor.userId }, requestedAt: { not: null } }, select: { id: true, status: true, consentType: true, requestedAt: true, respondedAt: true, donor: { select: { id: true, reference: true, organType: true, institution: { select: { id: true, name: true } } } } }, orderBy: { requestedAt: "desc" } });
}

export async function respondToOrganConsent(actor: AuthContext, consentId: string, decision: "ACCEPT" | "DECLINE") {
  if (actor.principalType !== "USER" || !["USER", "ADMINISTRATOR"].includes(actor.role) || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Only the account holder can respond to this consent request.");
  const consent = await database.organConsent.findFirst({ where: { id: consentId, donor: { userId: actor.userId } }, select: { id: true, donorId: true, status: true, requestedAt: true, donor: { select: { reference: true, institutionId: true, userId: true } } } });
  if (!consent || !consent.requestedAt) throw new ApiError(404, "CONSENT_NOT_FOUND", "Consent request not found.");
  if (consent.status !== ConsentStatus.PENDING) throw new ApiError(409, "CONSENT_ALREADY_ANSWERED", "This consent request has already been answered.");
  const status = decision === "ACCEPT" ? ConsentStatus.ACCEPTED : ConsentStatus.DECLINED;
  return database.$transaction(async (tx) => {
    const changed = await tx.organConsent.updateMany({ where: { id: consent.id, status: ConsentStatus.PENDING }, data: { status, recordedAt: new Date(), respondedAt: new Date(), respondedById: actor.userId } });
    if (!changed.count) throw new ApiError(409, "CONSENT_ALREADY_ANSWERED", "This consent request has already been answered.");
    const now = new Date();
    await tx.organDonor.update({ where: { id: consent.donorId }, data: { consentStatus: status, ...(decision === "ACCEPT" ? { consentDate: now } : { authorizationStatus: "REJECTED", status: OrganDonorStatus.CLOSED }) } });
    const eventId = randomUUID();
    const eventType = decision === "ACCEPT" ? "ORGAN_CONSENT_ACCEPTED" : "ORGAN_CONSENT_DECLINED";
    await tx.workflowEvent.create({ data: { id: eventId, eventType, actorId: actor.userId, actorInstitutionId: null, payload: { donorReference: consent.donor.reference } } });
    const accounts = await tx.institutionAccount.findMany({ where: { institutionId: consent.donor.institutionId }, select: { institutionId: true } });
    if (accounts.length) await tx.notification.createMany({ data: accounts.map(({ institutionId }) => ({ institutionId, eventId, eventType, title: decision === "ACCEPT" ? "Consent accepted by user" : "Consent declined by user", message: `The donor responded to consent request ${consent.donor.reference}.`, payload: { donorReference: consent.donor.reference, decision }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD })) });
    await tx.auditLog.create({ data: { actorId: actor.userId, action: eventType, entityType: "OrganConsent", entityId: consent.id, metadata: { donorReference: consent.donor.reference, decision } } });
    return { consentId, status, respondedAt: now };
  });
}
