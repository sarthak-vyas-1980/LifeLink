import { Router, type Request, type RequestHandler, type Response } from "express";
import { OrganStatus, OrganType, PreservationMethod, ProcurementStatus } from "@prisma/client";
import { database } from "@lifelink/database";
import { ApiError } from "../../middleware/api-error";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import {
	organDonorUpdateSchema, organRecordSchema, organRecordUpdateSchema, organStatusSchema, organAuthorizationSchema, organConsentRecordSchema, recipientRequirementUpdateSchema, organRecipientReviewSchema, organRecipientListQuerySchema,
	organMatchingSchema, organListQuerySchema, organDonorListQuerySchema, organMatchReviewSchema, organOfferSchema, organOfferResponseSchema, organOfferStatusSchema,
	organProcurementSchema, procurementStatusSchema, preservationStartSchema,
	preservationPolicySchema, preservationPolicyLookupSchema, personalOrganDonorSchema, personalOrganRecipientSchema, personalOrganRecipientUpdateSchema, validateRequest, validateUuidParams,
} from "../../middleware/validation";
import {
	updateOrganDonor, recordDonorConsent, verifyDonorConsent, withdrawDonorConsent, authorizeOrganDonor, createOrganRecord, updateOrganRecord, transitionOrgan, listOrgans, getOrganDashboardMetrics,
	listOrganDonors, generateOrganMatches, startOrganPreservation, getOrganPreservation,
	listOrganRecipients, updateOrganRecipient, reviewOrganRecipient, reviewOrganMatch, getOrganMatch, createOrganOffer, listOrganOffers, updateOrganOfferStatus,
	respondToOrganOffer, createOrganProcurement, updateOrganProcurement, getOrganPreservationPolicy,
	listOrganProcurements, getOrganDetail, upsertOrganPreservationPolicy, listOrganAudit, listAllOrganAudit, getOrganDonor, getOrganRecipient, getOrganOffer,
	expireOrganOffers, checkOrganPreservationAlerts,
} from "./service";
import { cancelMyOrganRecipient, createMyOrganDonor, createMyOrganRecipient, getMyOrganDonor, listMyOrganRecipients, listOrganServiceInstitutions, updateMyOrganRecipient, withdrawMyOrganDonorConsent } from "./personal.service";

const coordinators = ["ORGAN_CENTRE_USER", "HOSPITAL_USER", "ADMINISTRATOR"] as const;
let offerExpiryTimer: ReturnType<typeof setInterval> | undefined;
let preservationAlertTimer: ReturnType<typeof setInterval> | undefined;

export function registerOrganCoordinationRoutes(router = Router()) {
	startOfferExpiryWorker();
	startPreservationAlertWorker();
	router.use(authenticateRequest());
	// Personal users can manage their own donor interest and recipient requirement.
	router.get("/me/organ-services", asyncRoute(async (_req, res) => res.json({ institutions: await listOrganServiceInstitutions() })));
	router.get("/me/donor", authorizeAction("USER"), asyncRoute(async (req, res) => res.json({ donor: await getMyOrganDonor(req.auth!) })));
	router.post("/me/donor", authorizeAction("USER"), validateRequest(personalOrganDonorSchema), asyncRoute(async (req, res) => res.status(201).json({ donor: await createMyOrganDonor(req.auth!, req.body) })));
	router.post("/me/donor/withdraw", authorizeAction("USER"), asyncRoute(async (req, res) => res.json(await withdrawMyOrganDonorConsent(req.auth!))));
	router.get("/me/recipients", authorizeAction("USER"), asyncRoute(async (req, res) => res.json({ recipients: await listMyOrganRecipients(req.auth!) })));
	router.post("/me/recipients", authorizeAction("USER"), validateRequest(personalOrganRecipientSchema), asyncRoute(async (req, res) => res.status(201).json({ recipient: await createMyOrganRecipient(req.auth!, req.body) })));
	router.patch("/me/recipients/:recipientId", authorizeAction("USER"), validateUuidParams("recipientId"), validateRequest(personalOrganRecipientUpdateSchema), asyncRoute(async (req, res) => res.json({ recipient: await updateMyOrganRecipient(req.auth!, String(req.params.recipientId), req.body) })));
	router.post("/me/recipients/:recipientId/cancel", authorizeAction("USER"), validateUuidParams("recipientId"), asyncRoute(async (req, res) => res.json(await cancelMyOrganRecipient(req.auth!, String(req.params.recipientId)))));
	router.get("/donors", authorizeAction(...coordinators), asyncRoute(async (req, res) => {
		const query = organDonorListQuerySchema.safeParse(req.query);
		if (!query.success) throw new ApiError(400, "VALIDATION_FAILED", "Donor filters are invalid.");
		res.json({ donors: await listOrganDonors(req.auth!, query.data) });
	}));
	router.get("/donors/:donorId", authorizeAction(...coordinators), validateUuidParams("donorId"), asyncRoute(async (req, res) => res.json(await getOrganDonor(req.auth!, String(req.params.donorId)))));
	router.patch("/donors/:donorId", authorizeAction(...coordinators), validateUuidParams("donorId"), validateRequest(organDonorUpdateSchema), asyncRoute(async (req, res) => res.json(await updateOrganDonor(req.auth!, String(req.params.donorId), req.body))));
	router.post("/donors/:donorId/consent/record", authorizeAction(...coordinators), validateUuidParams("donorId"), validateRequest(organConsentRecordSchema), asyncRoute(async (req, res) => res.json(await recordDonorConsent(req.auth!, String(req.params.donorId), req.body.documentReference))));
	router.post("/donors/:donorId/consent/verify", authorizeAction(...coordinators), validateUuidParams("donorId"), asyncRoute(async (req, res) => res.json(await verifyDonorConsent(req.auth!, String(req.params.donorId)))));
	router.post("/donors/:donorId/consent/withdraw", authorizeAction(...coordinators), validateUuidParams("donorId"), asyncRoute(async (req, res) => res.json(await withdrawDonorConsent(req.auth!, String(req.params.donorId)))));
	router.post("/donors/:donorId/authorization", authorizeAction(...coordinators), validateUuidParams("donorId"), validateRequest(organAuthorizationSchema), asyncRoute(async (req, res) => res.json(await authorizeOrganDonor(req.auth!, String(req.params.donorId), req.body.status))));
	router.get("/recipients", authorizeAction(...coordinators), asyncRoute(async (req, res) => { const query = organRecipientListQuerySchema.safeParse(req.query); if (!query.success) throw new ApiError(400, "VALIDATION_FAILED", "Recipient filters are invalid."); res.json({ recipients: await listOrganRecipients(req.auth!, query.data) }); }));
	router.get("/recipients/:recipientId", authorizeAction(...coordinators), validateUuidParams("recipientId"), asyncRoute(async (req, res) => res.json(await getOrganRecipient(req.auth!, String(req.params.recipientId)))));
	router.patch("/recipients/:recipientId", authorizeAction(...coordinators), validateUuidParams("recipientId"), validateRequest(recipientRequirementUpdateSchema), asyncRoute(async (req, res) => res.json(await updateOrganRecipient(req.auth!, String(req.params.recipientId), req.body))));
	router.post("/recipients/:recipientId/review", authorizeAction(...coordinators), validateUuidParams("recipientId"), validateRequest(organRecipientReviewSchema), asyncRoute(async (req, res) => res.json(await reviewOrganRecipient(req.auth!, String(req.params.recipientId), req.body.decision, req.body.reason))));
	router.get("/dashboard", authorizeAction(...coordinators), asyncRoute(async (req, res) => res.json(await getOrganDashboardMetrics(req.auth!))));
	router.get("/", authorizeAction(...coordinators), asyncRoute(async (req, res) => {
		const query = organListQuerySchema.safeParse(req.query);
		if (!query.success) throw new ApiError(400, "VALIDATION_FAILED", "Organ filters are invalid.");
		res.json(await listOrgans(req.auth!, query.data));
	}));
	router.post("/", authorizeAction(...coordinators), validateRequest(organRecordSchema), asyncRoute(async (req, res) => res.status(201).json(await createOrganRecord(req.auth!, req.body))));
	router.patch("/:organId([0-9a-fA-F-]{36})", authorizeAction(...coordinators), validateUuidParams("organId"), validateRequest(organRecordUpdateSchema), asyncRoute(async (req, res) => res.json(await updateOrganRecord(req.auth!, String(req.params.organId), req.body))));
	router.get("/:organId([0-9a-fA-F-]{36})", authorizeAction(...coordinators), validateUuidParams("organId"), asyncRoute(async (req, res) => res.json(await getOrganDetail(req.auth!, String(req.params.organId)))));
	router.patch("/:organId/status", authorizeAction(...coordinators), validateUuidParams("organId"), validateRequest(organStatusSchema), asyncRoute(async (req, res) => res.json(await transitionOrgan(req.auth!, String(req.params.organId), req.body.status as OrganStatus))));
	router.post("/:organId/matches", authorizeAction(...coordinators), validateUuidParams("organId"), validateRequest(organMatchingSchema), asyncRoute(async (req, res) => res.json(await generateOrganMatches(req.auth!, String(req.params.organId), req.body.radiusKm))));
	router.get("/matches/:matchId", authorizeAction(...coordinators), validateUuidParams("matchId"), asyncRoute(async (req, res) => res.json(await getOrganMatch(req.auth!, String(req.params.matchId)))));
	router.get("/:organId/matches", authorizeAction(...coordinators), validateUuidParams("organId"), asyncRoute(async (req, res) => {
		const organ = await database.organRecord.findUnique({ where: { id: String(req.params.organId) }, select: { id: true, institutionId: true } });
		if (!organ || req.auth!.role !== "ADMINISTRATOR" && req.auth!.institutionId !== organ.institutionId) throw new ApiError(404, "ORGAN_NOT_FOUND", "Organ record not found.");
		res.json({ label: "Potential Coordination Matches", matches: await database.organMatch.findMany({ where: { organId: organ.id }, include: { recipient: { select: { reference: true, organType: true, bloodGroup: true, priority: true, institution: { select: { name: true } } } } }, orderBy: { coordinationScore: "desc" } }) });
	}));
	router.patch("/matches/:matchId/review", authorizeAction(...coordinators), validateUuidParams("matchId"), validateRequest(organMatchReviewSchema), asyncRoute(async (req, res) => res.json(await reviewOrganMatch(req.auth!, String(req.params.matchId), req.body.status))));
	router.get("/offers", authorizeAction(...coordinators), asyncRoute(async (req, res) => res.json({ offers: await listOrganOffers(req.auth!) })));
	router.get("/offers/:offerId", authorizeAction(...coordinators), validateUuidParams("offerId"), asyncRoute(async (req, res) => res.json(await getOrganOffer(req.auth!, String(req.params.offerId)))));
	router.post("/offers", authorizeAction(...coordinators), validateRequest(organOfferSchema), asyncRoute(async (req, res) => res.status(201).json(await createOrganOffer(req.auth!, req.body))));
	router.patch("/offers/:offerId/status", authorizeAction(...coordinators), validateUuidParams("offerId"), validateRequest(organOfferStatusSchema), asyncRoute(async (req, res) => res.json(await updateOrganOfferStatus(req.auth!, String(req.params.offerId), req.body.status))));
	router.post("/offers/:offerId/respond", authorizeAction(...coordinators), validateUuidParams("offerId"), validateRequest(organOfferResponseSchema), asyncRoute(async (req, res) => res.json(await respondToOrganOffer(req.auth!, String(req.params.offerId), req.body.action, req.body.responseReason))));
	router.post("/procurements", authorizeAction(...coordinators), validateRequest(organProcurementSchema), asyncRoute(async (req, res) => res.status(201).json(await createOrganProcurement(req.auth!, req.body))));
	router.get("/procurements", authorizeAction(...coordinators), asyncRoute(async (req, res) => res.json({ procurements: await listOrganProcurements(req.auth!) })));
	router.patch("/procurements/:procurementId/status", authorizeAction(...coordinators), validateUuidParams("procurementId"), validateRequest(procurementStatusSchema), asyncRoute(async (req, res) => res.json(await updateOrganProcurement(req.auth!, String(req.params.procurementId), req.body.status as ProcurementStatus))));
	router.post("/:organId/preservation/start", authorizeAction(...coordinators), validateUuidParams("organId"), validateRequest(preservationStartSchema), asyncRoute(async (req, res) => res.json(await startOrganPreservation(req.auth!, String(req.params.organId), { method: req.body.method as PreservationMethod, solution: req.body.solution }))));
	router.get("/:organId/preservation", authorizeAction(...coordinators), validateUuidParams("organId"), asyncRoute(async (req, res) => res.json(await getOrganPreservation(req.auth!, String(req.params.organId)))));
	router.get("/preservation-policies", authorizeAction(...coordinators), asyncRoute(async (req, res) => {
		const query = preservationPolicyLookupSchema.safeParse(req.query);
		if (!query.success) throw new ApiError(400, "VALIDATION_FAILED", "Organ type and preservation method are required.");
		res.json(await getOrganPreservationPolicy(req.auth!, query.data.organType as OrganType, query.data.method as PreservationMethod));
	}));
	router.put("/preservation-policies", authorizeAction("ADMINISTRATOR"), validateRequest(preservationPolicySchema), asyncRoute(async (req, res) => res.json(await upsertOrganPreservationPolicy(req.auth!, req.body))));
	router.get("/audit", authorizeAction(...coordinators), asyncRoute(async (req, res) => res.json({ events: await listAllOrganAudit(req.auth!) })));
	router.get("/:organId/audit", authorizeAction(...coordinators), validateUuidParams("organId"), asyncRoute(async (req, res) => res.json({ events: await listOrganAudit(req.auth!, String(req.params.organId)) })));
	return router;
}

function startOfferExpiryWorker() {
	if (offerExpiryTimer) return;
	void expireOrganOffers().catch(() => console.error("LifeLink organ offer expiry failed."));
	offerExpiryTimer = setInterval(() => { void expireOrganOffers().catch(() => console.error("LifeLink organ offer expiry failed.")); }, 60_000);
	offerExpiryTimer.unref?.();
}

function startPreservationAlertWorker() {
	if (preservationAlertTimer) return;
	void checkOrganPreservationAlerts().catch(() => console.error("LifeLink organ preservation alert check failed."));
	preservationAlertTimer = setInterval(() => { void checkOrganPreservationAlerts().catch(() => console.error("LifeLink organ preservation alert check failed.")); }, 60_000);
	preservationAlertTimer.unref?.();
}

export function stopOrganCoordinationWorkers() {
	if (offerExpiryTimer) clearInterval(offerExpiryTimer);
	if (preservationAlertTimer) clearInterval(preservationAlertTimer);
	offerExpiryTimer = undefined;
	preservationAlertTimer = undefined;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler {
	return (request, response, next) => { void Promise.resolve(handler(request, response)).catch(next); };
}
