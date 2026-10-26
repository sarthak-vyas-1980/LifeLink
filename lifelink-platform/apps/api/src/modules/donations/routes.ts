import { BloodComponent, BloodInventoryStatus, DonationStatus, NotificationStatus, NotificationType, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { BLOOD_GROUPS } from "@lifelink/shared";
import { database } from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { authorizeAction } from "../../middleware/rbac";
import { calculateDistance } from "../maps/geospatial.service";

const createSchema = z.object({ institutionId: z.string().uuid(), bloodGroup: z.enum(BLOOD_GROUPS), remarks: z.string().trim().max(300).optional() });
const statusSchema = z.object({ status: z.enum(["ACCEPTED", "REJECTED", "COMPLETED"]), expiryDate: z.coerce.date().optional(), verifiedBloodGroup: z.enum(BLOOD_GROUPS).optional() }).superRefine((value, context) => {
  if (value.status === "COMPLETED" && !value.expiryDate) context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiryDate"], message: "Enter the expiry date printed for the collected blood unit." });
  if (value.status === "COMPLETED" && !value.verifiedBloodGroup) context.addIssue({ code: z.ZodIssueCode.custom, path: ["verifiedBloodGroup"], message: "Confirm the blood group after institutional screening." });
});
const facilitiesQuery = z.object({ latitude: z.coerce.number().min(-90).max(90).optional(), longitude: z.coerce.number().min(-180).max(180).optional(), radiusKm: z.coerce.number().min(1).max(500).optional(), q: z.string().trim().max(100).optional() }).refine((query) => (query.latitude === undefined) === (query.longitude === undefined), "Enter both coordinates to search nearby facilities.");
const donorRoles = ["USER", "ADMINISTRATOR"] as const;
const reviewRoles = ["BLOOD_BANK_USER", "HOSPITAL_USER", "ADMINISTRATOR"] as const;

/** Records exactly one screened whole-blood unit when an institution completes a donation. */
export async function recordCompletedDonationInventory(tx: Pick<Prisma.TransactionClient, "bloodInventory" | "donationInventory">, input: {
  donationId: string;
  institutionId: string;
  verifiedBloodGroup: (typeof BLOOD_GROUPS)[number];
  expiryDate: Date;
}) {
  const inventory = await tx.bloodInventory.create({ data: {
    institutionId: input.institutionId,
    bloodGroup: input.verifiedBloodGroup as never,
    component: BloodComponent.WHOLE_BLOOD,
    unitsAvailable: 1,
    status: BloodInventoryStatus.AVAILABLE,
    expiryDate: input.expiryDate,
  } });
  await tx.donationInventory.create({ data: {
    donationId: input.donationId,
    bloodInventoryId: inventory.id,
    bloodGroup: input.verifiedBloodGroup as never,
    quantity: 1,
    expiryDate: input.expiryDate,
    status: BloodInventoryStatus.AVAILABLE,
  } });
  return inventory;
}

export function registerDonationRoutes(router = Router()) {
  router.use(authenticateRequest());
  router.get("/facilities", authorizeAction(...donorRoles), asyncRoute(async (req, res) => {
    const parsed = facilitiesQuery.safeParse(req.query);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Facility search filters are invalid.");
    const { latitude, longitude, radiusKm, q } = parsed.data;
    const institutions = await database.institution.findMany({
      where: { status: "ACTIVE", deletedAt: null, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { address: { contains: q, mode: "insensitive" as const } }] } : {}), AND: [{ OR: [
        { type: "BLOOD_BANK", bloodBankProfile: { isNot: null } },
        { type: "HOSPITAL", hospitalProfile: { is: { bloodService: { isNot: null } } } },
      ] }] },
      select: { id: true, name: true, type: true, address: true, contactNumber: true, latitude: true, longitude: true },
      orderBy: { name: "asc" },
    });
    const results = institutions.flatMap((institution) => {
      const hasCoordinates = latitude !== undefined && longitude !== undefined && institution.latitude !== null && institution.longitude !== null;
      const distanceKm = hasCoordinates ? Math.round(calculateDistance(latitude!, longitude!, institution.latitude!, institution.longitude!) * 10) / 10 : null;
      if (radiusKm !== undefined && (distanceKm === null || distanceKm > radiusKm)) return [];
      return [{ id: institution.id, name: institution.name, type: institution.type, address: institution.address, contactNumber: institution.contactNumber, distanceKm }];
    }).sort((first, second) => latitude !== undefined ? (first.distanceKm ?? Infinity) - (second.distanceKm ?? Infinity) : first.name.localeCompare(second.name));
    res.json({ institutions: results });
  }));
  router.get("/mine", authorizeAction(...donorRoles), asyncRoute(async (req, res) => {
    const actor = req.auth!;
    if (actor.principalType !== "USER" || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Use a personal account to view your donation interests.");
    const donations = await database.donation.findMany({ where: { donationType: "BLOOD", donorId: actor.userId }, include: {
      donor: { select: { id: true, name: true } },
      providerInstitution: { select: { id: true, name: true, address: true, contactNumber: true } },
    }, orderBy: { createdAt: "desc" } });
    res.json({ donations });
  }));
  router.get("/queue", authorizeAction(...reviewRoles), asyncRoute(async (req, res) => {
    const actor = req.auth!;
    if (actor.principalType === "INSTITUTION" && (!actor.capabilities?.blood || !actor.institutionId)) throw new ApiError(403, "INSTITUTION_CAPABILITY_REQUIRED", "This institution does not have blood services enabled.");
    const where: Prisma.DonationWhereInput = { donationType: "BLOOD" };
    if (actor.principalType === "INSTITUTION") where.providerInstitutionId = actor.institutionId;
    const donations = await database.donation.findMany({ where, include: {
      donor: { select: { id: true, name: true, phone: true } },
      providerInstitution: { select: { id: true, name: true, address: true, contactNumber: true } },
    }, orderBy: { createdAt: "desc" } });
    res.json({ donations });
  }));
  router.post("/", authorizeAction(...donorRoles), asyncRoute(async (req, res) => {
    const actor = req.auth!;
    if (actor.principalType !== "USER" || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Sign in with a personal account to register a blood donation interest.");
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Donation details are invalid.");
    const institution = await database.institution.findFirst({ where: { id: parsed.data.institutionId, status: "ACTIVE", deletedAt: null, OR: [
      { type: "BLOOD_BANK", bloodBankProfile: { isNot: null } },
      { type: "HOSPITAL", hospitalProfile: { is: { bloodService: { isNot: null } } } },
    ] }, select: { id: true, name: true } });
    if (!institution) throw new ApiError(400, "BLOOD_SERVICE_UNAVAILABLE", "Choose an active institution with a blood service.");
    const donation = await database.$transaction(async (tx) => {
      const record = await tx.donation.create({ data: { donorId: actor.userId!, providerInstitutionId: institution.id, donationType: "BLOOD", bloodGroup: parsed.data.bloodGroup as never, remarks: parsed.data.remarks || null }, include: { donor: { select: { id: true, name: true } }, providerInstitution: { select: { id: true, name: true, address: true, contactNumber: true } } } });
      const eventId = randomUUID();
      await tx.workflowEvent.create({ data: { id: eventId, eventType: "BLOOD_DONATION_INTEREST_CREATED", actorId: actor.userId!, payload: { donationId: record.id, institutionId: institution.id } } });
      const accounts = await tx.institutionAccount.findMany({ where: { institutionId: institution.id }, select: { institutionId: true } });
      if (accounts.length) await tx.notification.createMany({ data: accounts.map(({ institutionId }) => ({ institutionId, eventId, eventType: "BLOOD_DONATION_INTEREST_CREATED", title: "Blood donor interest received", message: "A user registered interest in donating blood. Review the donor in the Blood donation workspace.", payload: { donationId: record.id }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD })) });
      await tx.auditLog.create({ data: { actorId: actor.userId!, action: "BLOOD_DONATION_INTEREST_CREATED", entityType: "Donation", entityId: record.id, metadata: { institutionId: institution.id, bloodGroup: parsed.data.bloodGroup } } });
      return record;
    });
    res.status(201).json({ donation });
  }));
  router.post("/:donationId/cancel", authorizeAction(...donorRoles), asyncRoute(async (req, res) => {
    const actor = req.auth!;
    if (actor.principalType !== "USER" || !actor.userId) throw new ApiError(403, "PERSONAL_ACCOUNT_REQUIRED", "Only the donor can withdraw this donation interest.");
    if (!z.string().uuid().safeParse(req.params.donationId).success) throw new ApiError(400, "VALIDATION_FAILED", "Donation ID is invalid.");
    const donation = await database.donation.findFirst({ where: { id: String(req.params.donationId), donorId: actor.userId, donationType: "BLOOD" } });
    if (!donation) throw new ApiError(404, "DONATION_NOT_FOUND", "This blood donation record was not found.");
    if (donation.status !== "PENDING" && donation.status !== "ACCEPTED") throw new ApiError(409, "INVALID_DONATION_TRANSITION", "Only pending or accepted donation interests can be withdrawn.");
    const updated = await database.$transaction(async (tx) => {
      const record = await tx.donation.update({ where: { id: donation.id }, data: { status: DonationStatus.CANCELLED }, include: { donor: { select: { id: true, name: true } }, providerInstitution: { select: { id: true, name: true, address: true, contactNumber: true } } } });
      const eventId = randomUUID();
      await tx.workflowEvent.create({ data: { id: eventId, eventType: "BLOOD_DONATION_CANCELLED", actorId: actor.userId!, payload: { donationId: donation.id } } });
      if (donation.providerInstitutionId) {
        const accounts = await tx.institutionAccount.findMany({ where: { institutionId: donation.providerInstitutionId }, select: { institutionId: true } });
        if (accounts.length) await tx.notification.createMany({ data: accounts.map(({ institutionId }) => ({ institutionId, eventId, eventType: "BLOOD_DONATION_CANCELLED", title: "Blood donor interest withdrawn", message: "A user withdrew their blood donation interest.", payload: { donationId: donation.id }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD })) });
      }
      await tx.auditLog.create({ data: { actorId: actor.userId!, action: "BLOOD_DONATION_CANCELLED", entityType: "Donation", entityId: donation.id, metadata: {} } });
      return record;
    });
    res.json({ donation: updated });
  }));
  router.patch("/:donationId/status", authorizeAction(...reviewRoles), asyncRoute(async (req, res) => {
    const actor = req.auth!;
    if (actor.principalType === "INSTITUTION" && (!actor.capabilities?.blood || !actor.institutionId)) throw new ApiError(403, "INSTITUTION_CAPABILITY_REQUIRED", "This institution does not have blood services enabled.");
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, "VALIDATION_FAILED", parsed.error.issues[0]?.message ?? "Donation status is invalid.");
    if (!z.string().uuid().safeParse(req.params.donationId).success) throw new ApiError(400, "VALIDATION_FAILED", "Donation ID is invalid.");
    const donation = await database.donation.findFirst({ where: { id: String(req.params.donationId), donationType: "BLOOD", ...(actor.principalType === "INSTITUTION" ? { providerInstitutionId: actor.institutionId } : {}) } });
    if (!donation) throw new ApiError(404, "DONATION_NOT_FOUND", "This blood donation record was not found.");
    const allowed: Record<string, string[]> = { PENDING: ["ACCEPTED", "REJECTED"], ACCEPTED: ["COMPLETED"] };
    if (!allowed[donation.status]?.includes(parsed.data.status)) throw new ApiError(409, "INVALID_DONATION_TRANSITION", "This donation cannot move to that status.");
    if (parsed.data.status === "COMPLETED" && parsed.data.expiryDate!.toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10)) throw new ApiError(400, "INVALID_EXPIRY_DATE", "The blood unit expiry date cannot be in the past.");
    if (parsed.data.status === "COMPLETED" && (!donation.providerInstitutionId || !donation.bloodGroup)) throw new ApiError(409, "DONATION_INVENTORY_DATA_MISSING", "The donation must have an institution and verified blood group before it can be added to stock.");
    const updated = await database.$transaction(async (tx) => {
      const transition = await tx.donation.updateMany({ where: { id: donation.id, status: donation.status }, data: { status: parsed.data.status as DonationStatus } });
      if (transition.count !== 1) throw new ApiError(409, "INVALID_DONATION_TRANSITION", "This donation was already updated. Refresh the queue and try again.");
      let inventoryRecord: { id: string } | undefined;
      if (parsed.data.status === "COMPLETED") {
        inventoryRecord = await recordCompletedDonationInventory(tx, { donationId: donation.id, institutionId: donation.providerInstitutionId!, verifiedBloodGroup: parsed.data.verifiedBloodGroup!, expiryDate: parsed.data.expiryDate! });
      }
      const record = await tx.donation.findUniqueOrThrow({ where: { id: donation.id }, include: { donor: { select: { id: true, name: true, phone: true } }, providerInstitution: { select: { id: true, name: true, address: true, contactNumber: true } } } });
      const eventId = randomUUID();
      await tx.workflowEvent.create({ data: { id: eventId, eventType: `BLOOD_DONATION_${parsed.data.status}`, actorId: actor.userId, actorInstitutionId: actor.institutionId, payload: { donationId: donation.id, ...(inventoryRecord ? { inventoryId: inventoryRecord.id, unitsAdded: 1, component: BloodComponent.WHOLE_BLOOD } : {}) } } });
      await tx.notification.create({ data: { userId: donation.donorId, eventId, eventType: `BLOOD_DONATION_${parsed.data.status}`, title: `Blood donation ${parsed.data.status.toLowerCase()}`, message: parsed.data.status === "COMPLETED" ? "The institution confirmed your screened donation and recorded one whole blood unit." : `The institution ${parsed.data.status.toLowerCase()} your blood donation interest.`, payload: { donationId: donation.id }, type: NotificationType.IN_APP, status: NotificationStatus.UNREAD } });
      await tx.auditLog.create({ data: { actorId: actor.userId, actorInstitutionId: actor.institutionId, action: `BLOOD_DONATION_${parsed.data.status}`, entityType: "Donation", entityId: donation.id, metadata: inventoryRecord ? { inventoryId: inventoryRecord.id, unitsAdded: 1, component: BloodComponent.WHOLE_BLOOD, verifiedBloodGroup: parsed.data.verifiedBloodGroup, expiryDate: parsed.data.expiryDate!.toISOString() } : {} } });
      return { record, inventoryRecord };
    });
    res.json({ donation: updated.record, inventory: updated.inventoryRecord ?? null });
  }));
  return router;
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (req, res, next) => { Promise.resolve(handler(req, res, next)).catch(next); };
}
