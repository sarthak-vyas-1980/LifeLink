import type { RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";
import {
  BLOOD_COMPONENTS,
  BLOOD_GROUPS,
  REQUEST_PRIORITIES,
  isAllowedTransition,
} from "@lifelink/shared";

export const registrationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  phone: z.string().trim().min(7).max(30).optional(),
  password: z.string().min(12).max(128),
  role: z.enum([
    "HOSPITAL_USER",
    "BLOOD_BANK_USER",
    "ORGAN_CENTRE_USER",
    "DONOR_RECIPIENT",
  ]),
  institutionId: z.string().uuid().optional(),
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().min(7).max(30).optional(),
});

const bloodRequestFields = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  quantity: z.number().int().positive(),
  priority: z.enum(REQUEST_PRIORITIES.filter((priority) => priority !== "EMERGENCY") as ["NORMAL", "URGENT"]),
  location: z.string().trim().min(1).max(200),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().positive().max(500).optional(),
  contactNumber: z.string().trim().min(7).max(30),
});

export const bloodInventorySchema = z.object({
  institutionId: z.string().uuid(),
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  unitsAvailable: z.number().int().nonnegative(),
  expiryDate: z.coerce.date().optional(),
});

export const inventorySearchSchema = z.object({
  bloodGroup: z.enum(BLOOD_GROUPS),
  component: z.enum(BLOOD_COMPONENTS),
  quantity: z.coerce.number().int().positive(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(500).optional(),
}).superRefine((value, context) => {
  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLatitude ? "longitude" : "latitude"],
      message: "Both coordinates are required for a location search.",
    });
  }
  if (value.radiusKm !== undefined && !hasLatitude) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["radiusKm"],
      message: "A search radius requires coordinates.",
    });
  }
});

function validateRequestLocation(
  value: { latitude?: number; longitude?: number; radiusKm?: number },
  context: z.RefinementCtx,
) {
  const hasLatitude = value.latitude !== undefined;
  const hasLongitude = value.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasLatitude ? "longitude" : "latitude"],
      message: "Both coordinates are required for a location search.",
    });
  }
  if (value.radiusKm !== undefined && !hasLatitude) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["radiusKm"],
      message: "A search radius requires coordinates.",
    });
  }
}

export const bloodRequestSchema = bloodRequestFields.superRefine(
  validateRequestLocation,
);
export const emergencyBloodRequestSchema = bloodRequestFields
  .omit({ priority: true })
  .superRefine(validateRequestLocation);

export const bloodOfferResponseSchema = z.object({
  action: z.enum(["ACCEPT", "REJECT"]),
});

export const bloodOfferEvaluationSchema = z.object({
  action: z.enum(["ACCEPT", "REJECT"]),
});

// Validate request shape before it reaches a feature handler.
export function validateRequest(schema: ZodTypeAny): RequestHandler {
  return (request, response, next) => {
    const result = schema.safeParse(request.body);
    if (!result.success) {
      response.status(400).json({
        code: "VALIDATION_FAILED",
        message: "Request validation failed.",
        fieldErrors: result.error.flatten().fieldErrors,
      });
      return;
    }

    request.body = result.data;
    next();
  };
}

// Validate UUID path parameters before they are passed to Prisma.
export function validateUuidParams(...names: string[]): RequestHandler {
  const shape: Record<string, z.ZodString> = {};
  for (const name of names) shape[name] = z.string().uuid();
  const schema = z.object(shape);
  return (request, response, next) => {
    const result = schema.safeParse(request.params);
    if (!result.success) {
      response.status(400).json({
        code: "VALIDATION_FAILED",
        message: "Request validation failed.",
        fieldErrors: result.error.flatten().fieldErrors,
      });
      return;
    }
    next();
  };
}

// Validate identifiers and query filters used by discovery workflows.
export function validateSearchCriteria(): RequestHandler {
  return validateRequest(inventorySearchSchema);
}

// Validate a state transition before changing an operational record.
export function validateWorkflowTransition(): RequestHandler {
  return (request, response, next) => {
    const { from, to } = request.body as { from?: string; to?: string };
    if (!from || !to || !isAllowedTransition(from as never, to as never)) {
      response.status(409).json({
        code: "INVALID_WORKFLOW_TRANSITION",
        message: "The requested workflow transition is not allowed.",
      });
      return;
    }

    next();
  };
}
