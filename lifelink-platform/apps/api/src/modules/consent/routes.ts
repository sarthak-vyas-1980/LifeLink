import { Router, type Request, type RequestHandler, type Response } from "express";
import { authenticateRequest } from "../../middleware/auth";
import { authorizeAction } from "../../middleware/rbac";
import { validateUuidParams } from "../../middleware/validation";
import { listMyOrganConsents, requestOrganDonorConsent, respondToOrganConsent } from "./service";
import { ApiError } from "../../middleware/api-error";

export function registerConsentRoutes(router = Router()) {
  router.use(authenticateRequest());
  router.post("/:donorId/request", authorizeAction("ORGAN_CENTRE_USER", "HOSPITAL_USER", "ADMINISTRATOR"), validateUuidParams("donorId"), asyncRoute(async (req, res) => res.json(await requestOrganDonorConsent(req.auth!, String(req.params.donorId)))));
  router.get("/me", authorizeAction("USER", "ADMINISTRATOR"), asyncRoute(async (req, res) => res.json({ consents: await listMyOrganConsents(req.auth!) })));
  router.post("/:consentId/respond", authorizeAction("USER", "ADMINISTRATOR"), validateUuidParams("consentId"), asyncRoute(async (req, res) => {
    const action = req.body?.action;
    if (action !== "ACCEPT" && action !== "DECLINE") throw new ApiError(400, "VALIDATION_FAILED", "Consent response action must be ACCEPT or DECLINE.");
    res.json(await respondToOrganConsent(req.auth!, String(req.params.consentId), action));
  }));
  return router;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<unknown>): RequestHandler {
  return (request, response, next) => { void Promise.resolve(handler(request, response)).catch(next); };
}
