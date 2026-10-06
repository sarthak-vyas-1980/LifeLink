import { randomUUID } from "node:crypto";
import { ConsentStatus, NotificationStatus, NotificationType, OrganAuthorizationStatus, OrganDonorStatus, OrganMatchStatus, OrganRecipientStatus, Prisma, RequestPriority } from "@prisma/client";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";

function requirePersonalUser(actor: AuthContext) {
	if (actor.principalType !== "USER" || actor.role !== "USER" || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Sign in with a personal LifeLink account to manage your own organ profile.");
	return actor.userId;
}

async function requireOrganInstitution(institutionId: string) {
	const institution = await database.institution.findUnique({ where: { id: institutionId }, select: { id: true, name: true, type: true, status: true, hospitalProfile: { select: { organService: { select: { id: true } } } } } });
	if (!institution || institution.status !== "ACTIVE" || institution.type !== "ORGAN_CENTRE" && !(institution.type === "HOSPITAL" && institution.hospitalProfile?.organService)) throw new ApiError(400, "ORGAN_SERVICE_UNAVAILABLE", "Choose an active institution that provides organ services.");
	return institution;
}

async function notifyOrganService(tx: Prisma.TransactionClient, actorId: string, institutionId: string, eventType: string, title: string, reference: string) {
	const eventId = randomUUID();
	await tx.workflowEvent.create({ data: { id: eventId, eventType, actorId, payload: { reference, institutionId } } });
	const accounts = await tx.institutionAccount.findMany({ where: { institutionId }, select: { institutionId: true } });
	const administrators = await tx.user.findMany({ where: { status: "ACTIVE", role: "ADMIN" }, select: { id: true } });
	await tx.notification.createMany({ data: [
		...accounts.map(({ institutionId: recipientInstitutionId }) => ({ institutionId: recipientInstitutionId })),
		...administrators.map(({ id }) => ({ userId: id })),
	].map((recipient) => ({ ...recipient, eventId, eventType, title, message: `A personal organ coordination submission (${reference}) is ready for professional review.`, payload: { reference }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD })), skipDuplicates: true });
}

export async function getMyOrganDonor(actor: AuthContext) {
	const userId = requirePersonalUser(actor);
	return database.organDonor.findUnique({ where: { userId }, select: { id: true, reference: true, donorType: true, bloodGroup: true, consentStatus: true, authorizationStatus: true, status: true, createdAt: true, updatedAt: true, institution: { select: { id: true, name: true } }, consents: { select: { status: true, consentType: true, recordedAt: true, verifiedAt: true, notes: true }, orderBy: { createdAt: "desc" } }, organs: { select: { reference: true, organType: true, status: true } } } });
}

export async function listOrganServiceInstitutions() {
	const institutions = await database.institution.findMany({ where: { status: "ACTIVE", type: { in: ["ORGAN_CENTRE", "HOSPITAL"] } }, select: { id: true, name: true, type: true, address: true, hospitalProfile: { select: { organService: { select: { id: true } } } } }, orderBy: [{ type: "asc" }, { name: "asc" }] });
	return institutions.filter((institution) => institution.type === "ORGAN_CENTRE" || Boolean(institution.hospitalProfile?.organService)).map(({ hospitalProfile: _profile, ...institution }) => institution);
}

export async function createMyOrganDonor(actor: AuthContext, input: { institutionId: string; donorType: "LIVING" | "POSTHUMOUS_INTENT"; organTypes: string[]; bloodGroup?: string }) {
	const userId = requirePersonalUser(actor);
	const institution = await requireOrganInstitution(input.institutionId);
	const existing = await database.organDonor.findUnique({ where: { userId }, select: { id: true } });
	if (existing) throw new ApiError(409, "DONOR_PROFILE_EXISTS", "Your donor interest is already registered. Open your profile to review or withdraw it.");
	return database.$transaction(async (tx) => {
		const donor = await tx.organDonor.create({ data: { reference: `DNR-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, userId, institutionId: institution.id, donorType: input.donorType, bloodGroup: input.bloodGroup as never, consentStatus: ConsentStatus.PENDING, authorizationStatus: OrganAuthorizationStatus.PENDING, status: OrganDonorStatus.REGISTERED, consents: { create: { status: ConsentStatus.PENDING, consentType: input.donorType, notes: `User expressed interest in: ${input.organTypes.join(", ")}. This is not verified consent; institutional review is required.`, recordedAt: new Date() } } }, select: { id: true, reference: true, donorType: true, bloodGroup: true, consentStatus: true, authorizationStatus: true, status: true, createdAt: true, institution: { select: { id: true, name: true } } } });
		await tx.auditLog.create({ data: { actorId: userId, action: "PERSONAL_ORGAN_DONOR_INTEREST_CREATED", entityType: "OrganDonor", entityId: donor.id, metadata: { reference: donor.reference, institutionId: institution.id } } });
		await notifyOrganService(tx, userId, institution.id, "PERSONAL_ORGAN_DONOR_INTEREST_CREATED", "Donor interest needs review", donor.reference);
		return donor;
	});
}

export async function withdrawMyOrganDonorConsent(actor: AuthContext) {
	const userId = requirePersonalUser(actor);
	const donor = await database.organDonor.findUnique({ where: { userId }, select: { id: true, reference: true, consentStatus: true } });
	if (!donor) throw new ApiError(404, "DONOR_PROFILE_NOT_FOUND", "No donor interest is registered for this account.");
	if (donor.consentStatus === ConsentStatus.WITHDRAWN) return { withdrawn: true };
	const withdrawableStatuses: ConsentStatus[] = [ConsentStatus.PENDING, ConsentStatus.RECORDED, ConsentStatus.VERIFIED];
	if (!withdrawableStatuses.includes(donor.consentStatus)) throw new ApiError(409, "CONSENT_NOT_WITHDRAWABLE", "This donor record cannot currently be withdrawn.");
	return database.$transaction(async (tx) => {
		await tx.organDonor.update({ where: { id: donor.id }, data: { consentStatus: ConsentStatus.WITHDRAWN, authorizationStatus: OrganAuthorizationStatus.WITHDRAWN, status: OrganDonorStatus.CLOSED } });
		await tx.organConsent.updateMany({ where: { donorId: donor.id, status: { in: [ConsentStatus.PENDING, ConsentStatus.RECORDED, ConsentStatus.VERIFIED] } }, data: { status: ConsentStatus.WITHDRAWN } });
		await tx.auditLog.create({ data: { actorId: userId, action: "PERSONAL_ORGAN_DONOR_INTEREST_WITHDRAWN", entityType: "OrganDonor", entityId: donor.id, metadata: { reference: donor.reference } } });
		return { withdrawn: true };
	});
}

export async function listMyOrganRecipients(actor: AuthContext) {
	const userId = requirePersonalUser(actor);
	return database.organRecipient.findMany({ where: { userId }, select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, institution: { select: { id: true, name: true } }, requirement: true, matches: { select: { status: true, coordinationScore: true, matchReasons: true, generatedAt: true, organ: { select: { reference: true, organType: true, status: true } } }, orderBy: { coordinationScore: "desc" } }, offers: { select: { reference: true, status: true, offeredAt: true, responseDeadline: true } } }, orderBy: { registrationDate: "desc" } });
}

export async function createMyOrganRecipient(actor: AuthContext, input: { institutionId: string; organType: string; bloodGroup?: string; priority?: RequestPriority; urgency?: string; requiredBy?: Date }) {
	const userId = requirePersonalUser(actor);
	const institution = await requireOrganInstitution(input.institutionId);
	return database.$transaction(async (tx) => {
		const recipient = await tx.organRecipient.create({ data: { reference: `RCPT-${new Date().getUTCFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`, userId, institutionId: institution.id, organType: input.organType as never, bloodGroup: input.bloodGroup as never, priority: input.priority ?? RequestPriority.NORMAL, status: OrganRecipientStatus.PENDING_REVIEW, requirement: { create: { organType: input.organType as never, bloodGroup: input.bloodGroup as never, priority: input.priority ?? RequestPriority.NORMAL, urgency: input.urgency, requiredBy: input.requiredBy } } }, select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, institution: { select: { id: true, name: true } }, requirement: true } });
		await tx.auditLog.create({ data: { actorId: userId, action: "PERSONAL_ORGAN_RECIPIENT_CREATED", entityType: "OrganRecipient", entityId: recipient.id, metadata: { reference: recipient.reference, institutionId: institution.id, organType: recipient.organType } } });
		await notifyOrganService(tx, userId, institution.id, "PERSONAL_ORGAN_RECIPIENT_CREATED", "Recipient requirement needs review", recipient.reference);
		return recipient;
	});
}

export async function updateMyOrganRecipient(actor: AuthContext, recipientId: string, input: { organType?: string; bloodGroup?: string | null; priority?: RequestPriority; urgency?: string | null; requiredBy?: Date | null }) {
	const userId = requirePersonalUser(actor);
	const recipient = await database.organRecipient.findFirst({ where: { id: recipientId, userId }, select: { id: true, reference: true, institutionId: true, organType: true, bloodGroup: true, priority: true } });
	if (!recipient) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient record not found.");
	if (input.organType || input.bloodGroup !== undefined || input.priority) {
		const activeOffers = await database.organOffer.count({ where: { recipientId, status: { in: ["SENT", "UNDER_REVIEW"] } } });
		if (activeOffers) throw new ApiError(409, "ACTIVE_OFFER_EXISTS", "Contact the receiving centre before changing requirements while an offer is active.");
	}
	return database.$transaction(async (tx) => {
		await tx.organRecipient.update({ where: { id: recipientId }, data: { organType: input.organType as never, bloodGroup: input.bloodGroup as never, priority: input.priority } });
		await tx.recipientRequirement.upsert({ where: { recipientId }, create: { recipientId, organType: (input.organType ?? recipient.organType) as never, bloodGroup: (input.bloodGroup === undefined ? recipient.bloodGroup : input.bloodGroup) as never, priority: input.priority ?? recipient.priority, urgency: input.urgency, requiredBy: input.requiredBy }, update: { organType: input.organType as never, bloodGroup: input.bloodGroup as never, priority: input.priority, urgency: input.urgency, requiredBy: input.requiredBy } });
		const affected = await tx.organMatch.findMany({ where: { recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } }, select: { id: true } });
		if (affected.length) await tx.organMatch.updateMany({ where: { id: { in: affected.map(({ id }) => id) } }, data: { status: OrganMatchStatus.CANCELLED } });
		await tx.auditLog.create({ data: { actorId: userId, action: "PERSONAL_ORGAN_RECIPIENT_UPDATED", entityType: "OrganRecipient", entityId: recipientId, metadata: { reference: recipient.reference, fields: Object.keys(input) } } });
		return tx.organRecipient.findUniqueOrThrow({ where: { id: recipientId }, select: { id: true, reference: true, organType: true, bloodGroup: true, priority: true, status: true, registrationDate: true, requirement: true } });
	});
}

export async function cancelMyOrganRecipient(actor: AuthContext, recipientId: string) {
	const userId = requirePersonalUser(actor);
	const recipient = await database.organRecipient.findFirst({ where: { id: recipientId, userId }, select: { id: true, reference: true, status: true } });
	if (!recipient) throw new ApiError(404, "RECIPIENT_NOT_FOUND", "Recipient request not found.");
	if (recipient.status !== OrganRecipientStatus.PENDING_REVIEW && recipient.status !== OrganRecipientStatus.ACTIVE) throw new ApiError(409, "RECIPIENT_NOT_CANCELLABLE", "Only pending or active recipient requests can be cancelled. Contact the receiving centre after a coordination offer is accepted.");
	if (await database.organOffer.count({ where: { recipientId, status: { in: ["SENT", "UNDER_REVIEW"] } } })) throw new ApiError(409, "ACTIVE_OFFER_EXISTS", "Ask the receiving centre to resolve active offers before cancelling this requirement.");
	return database.$transaction(async (tx) => {
		const changed = await tx.organRecipient.updateMany({ where: { id: recipientId, userId, status: recipient.status }, data: { status: OrganRecipientStatus.CANCELLED } });
		if (!changed.count) throw new ApiError(409, "RECIPIENT_NOT_CANCELLABLE", "This recipient request has already changed.");
		await tx.organMatch.updateMany({ where: { recipientId, status: { in: [OrganMatchStatus.GENERATED, OrganMatchStatus.UNDER_REVIEW, OrganMatchStatus.SHORTLISTED] } }, data: { status: OrganMatchStatus.CANCELLED } });
		await tx.workflowEvent.create({ data: { eventType: "ORGAN_RECIPIENT_CANCELLED_BY_USER", actorId: userId, payload: { reference: recipient.reference } } });
		await tx.auditLog.create({ data: { actorId: userId, action: "PERSONAL_ORGAN_RECIPIENT_CANCELLED", entityType: "OrganRecipient", entityId: recipientId, metadata: { reference: recipient.reference } } });
		return { cancelled: true };
	});
}
