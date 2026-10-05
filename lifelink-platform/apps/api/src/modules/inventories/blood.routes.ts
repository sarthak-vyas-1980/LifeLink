import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  createBloodInventory as persistBloodInventory,
  searchAvailableInventory,
  updateBloodInventoryForInstitution as persistBloodInventoryUpdate,
} from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import {
  authorizeAction,
  authorizeInstitutionCapability,
  authorizeInstitutionScope,
} from "../../middleware/rbac";
import {
  validateRequest,
  bloodInventorySchema,
  inventorySearchSchema,
  validateUuidParams,
} from "../../middleware/validation";
import { recordAuditEvent } from "../audit/service";
import { calculateDistance } from "../maps/geospatial.service";

const institutionRoles = [
  "BLOOD_BANK_USER",
  "HOSPITAL_USER",
  "ADMINISTRATOR",
] as const;

// Define authorized blood-inventory endpoints.
export function registerBloodInventoryRoutes(router = Router()) {
  router.post(
    "/",
    authenticateRequest(),
    authorizeAction(...institutionRoles),
    authorizeInstitutionCapability("blood"),
    validateRequest(bloodInventorySchema),
    authorizeInstitutionScope((request) => request.body.institutionId),
    asyncRoute(createBloodInventory),
  );
  router.patch(
    "/:inventoryId",
    authenticateRequest(),
    authorizeAction(...institutionRoles),
    authorizeInstitutionCapability("blood"),
    validateUuidParams("inventoryId"),
    validateRequest(bloodInventorySchema),
    authorizeInstitutionScope((request) => request.body.institutionId),
    asyncRoute(updateBloodInventory),
  );
  router.get("/search", authenticateRequest(), asyncRoute(searchBloodInventory));
  return router;
}

// Add a blood inventory record within the actor's institution scope.
export async function createBloodInventory(
  request: Request,
  response: Response,
) {
  const inventory = await persistBloodInventory({
    institution: { connect: { id: request.body.institutionId } },
    bloodGroup: request.body.bloodGroup,
    component: request.body.component,
    unitsAvailable: request.body.unitsAvailable,
    expiryDate: request.body.expiryDate,
  });

  await recordAuditEvent({
    actorId: request.auth?.userId,
    actorInstitutionId: request.auth?.institutionId,
    action: "BLOOD_INVENTORY_CREATED",
    entityType: "BloodInventory",
    entityId: inventory.id,
    metadata: { institutionId: inventory.institutionId },
  });
  response.status(201).json(serializeInventory(inventory));
}

// Update quantity or expiry information without accepting reserved-unit changes.
export async function updateBloodInventory(
  request: Request,
  response: Response,
) {
  const inventory = await persistBloodInventoryUpdate(
    String(request.params.inventoryId),
    request.body.institutionId,
    {
      bloodGroup: request.body.bloodGroup,
      component: request.body.component,
      unitsAvailable: request.body.unitsAvailable,
      expiryDate: request.body.expiryDate,
    },
  );

  await recordAuditEvent({
    actorId: request.auth?.userId,
    actorInstitutionId: request.auth?.institutionId,
    action: "BLOOD_INVENTORY_UPDATED",
    entityType: "BloodInventory",
    entityId: inventory.id,
    metadata: { institutionId: inventory.institutionId },
  });
  response.json(serializeInventory(inventory));
}

// Find eligible blood sources from current operational inventory.
export async function searchBloodInventory(
  request: Request,
  response: Response,
) {
  const parsed = inventorySearchSchema.safeParse(request.query);
  if (!parsed.success) {
    response.status(400).json({
      code: "VALIDATION_FAILED",
      message: "Inventory search filters are invalid.",
      traceId: request.traceId,
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
    return;
  }
  const criteria = parsed.data;
  const records = await searchAvailableInventory({
    bloodGroup: criteria.bloodGroup,
    component: criteria.component,
    quantity: criteria.quantity,
  });
  const candidates = records.flatMap((record) => {
    const hasCoordinates =
      criteria.latitude !== undefined && criteria.longitude !== undefined;
    const hasInstitutionCoordinates =
      record.institution.latitude !== null && record.institution.longitude !== null;
    const distanceKm =
      hasCoordinates && hasInstitutionCoordinates
        ? calculateDistance(
            criteria.latitude!,
            criteria.longitude!,
            record.institution.latitude!,
            record.institution.longitude!,
          )
        : undefined;
    if (
      criteria.radiusKm !== undefined &&
      (distanceKm === undefined || distanceKm > criteria.radiusKm)
    ) {
      return [];
    }
    return [{
      inventoryId: record.id,
      bloodGroup: record.bloodGroup,
      component: record.component,
      unitsAvailable: record.unitsAvailable,
      expiryDate: record.expiryDate,
      lastUpdated: record.lastUpdated,
      distanceKm,
      institution: {
        id: record.institution.id,
        name: record.institution.name,
        type: record.institution.type,
        address: record.institution.address,
        latitude: record.institution.latitude,
        longitude: record.institution.longitude,
      },
    }];
  });
  response.json({ candidates });
}

function serializeInventory(inventory: {
  id: string;
  institutionId: string;
  bloodGroup: unknown;
  component: unknown;
  unitsAvailable: number;
  expiryDate: Date | null;
  status: unknown;
  lastUpdated: Date;
}) {
  return {
    id: inventory.id,
    institutionId: inventory.institutionId,
    bloodGroup: inventory.bloodGroup,
    component: inventory.component,
    unitsAvailable: inventory.unitsAvailable,
    expiryDate: inventory.expiryDate,
    status: inventory.status,
    lastUpdated: inventory.lastUpdated,
  };
}

function asyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
