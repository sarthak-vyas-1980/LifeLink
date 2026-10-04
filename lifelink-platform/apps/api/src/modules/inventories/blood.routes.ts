import { Router, type Request, type Response } from "express";
import {
  createBloodInventory as persistBloodInventory,
  searchAvailableInventory,
  updateBloodInventoryForInstitution as persistBloodInventoryUpdate,
} from "@lifelink/database";
import { authenticateRequest } from "../../middleware/auth";
import {
  authorizeAction,
  authorizeInstitutionScope,
} from "../../middleware/rbac";
import {
  validateRequest,
  bloodInventorySchema,
} from "../../middleware/validation";
import { recordAuditEvent } from "../audit/service";

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
    validateRequest(bloodInventorySchema),
    authorizeInstitutionScope((request) => request.body.institutionId),
    createBloodInventory,
  );
  router.patch(
    "/:inventoryId",
    authenticateRequest(),
    authorizeAction(...institutionRoles),
    validateRequest(bloodInventorySchema),
    authorizeInstitutionScope((request) => request.body.institutionId),
    updateBloodInventory,
  );
  router.get("/search", authenticateRequest(), searchBloodInventory);
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
    action: "BLOOD_INVENTORY_CREATED",
    entityType: "BloodInventory",
    entityId: inventory.id,
    metadata: { institutionId: inventory.institutionId },
  });
  response.status(201).json(inventory);
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
    action: "BLOOD_INVENTORY_UPDATED",
    entityType: "BloodInventory",
    entityId: inventory.id,
    metadata: { institutionId: inventory.institutionId },
  });
  response.json(inventory);
}

// Find eligible blood sources from current operational inventory.
export async function searchBloodInventory(
  request: Request,
  response: Response,
) {
  const inventory = await searchAvailableInventory({
    bloodGroup: request.query.bloodGroup as never,
    component: request.query.component as never,
    quantity: Number(request.query.quantity),
  });
  response.json(inventory);
}
