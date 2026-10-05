import type { RequestHandler } from "express";
import { z, type ZodTypeAny } from "zod";
import {
  BLOOD_COMPONENTS,
  BLOOD_GROUPS,
  REQUEST_PRIORITIES,
  isAllowedTransition,
} from "@lifelink/shared";

const phoneNumberSchema = z.string().trim().min(7).max(30)
  .regex(/^\+?[0-9\s().-]+$/, "Enter a valid phone number.")
  .refine((value) => {
    const digits = value.replace(/\D/g, "").length;
    return digits >= 7 && digits <= 15;
  }, "Enter a valid phone number.");

const userRoles = ["USER", "ADMIN"] as const;

export const registrationSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().email().max(254),
  phone: phoneNumberSchema,
  password: z.string().min(6).max(128),
  accountType: z.enum(["USER", "INSTITUTION"]),
  role: z.enum(userRoles).optional(),
  institutionType: z.enum(["HOSPITAL", "BLOOD_BANK", "ORGAN_CENTRE"]).optional(),
  address: z.string().trim().min(3).max(300).optional(),
  contactPerson: z.string().trim().min(2).max(120).optional(),
  bloodServiceEnabled: z.boolean().optional(),
  organServiceEnabled: z.boolean().optional(),
}).superRefine((value, context) => {
  if (value.accountType === "USER" && !value.role) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["role"], message: "Choose User or Admin." });
  }
  if (value.accountType === "INSTITUTION" && (!value.institutionType || !value.address)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["institutionType"], message: "Enter the institution type and address." });
  }
  if (value.accountType === "INSTITUTION" && value.role) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["role"], message: "Institutions use their institution type, not a user account role." });
  }
});

export const loginSchema = z.object({
  email: z.string().email().max(254),
  phone: phoneNumberSchema,
  password: z.string().min(1).max(128),
  accountType: z.enum(["USER", "INSTITUTION"]),
});

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  phone: phoneNumberSchema.optional(),
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

const organTypes = ["KIDNEY", "LIVER", "HEART", "LUNG", "PANCREAS", "INTESTINE", "CORNEA", "BONE_MARROW", "OTHER"] as const;
const preservationMethods = ["STATIC_COLD_STORAGE", "HYPOTHERMIC_MACHINE_PERFUSION", "NORMOTHERMIC_MACHINE_PERFUSION", "CORNEAL_STORAGE_MEDIUM", "OTHER"] as const;
const bloodGroupValues = ["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"] as const;
const priorityValues = ["NORMAL", "URGENT", "EMERGENCY"] as const;

export const organDonorSchema = z.object({
	donorType: z.string().trim().min(2).max(60),
	consentType: z.string().trim().min(2).max(60),
	bloodGroup: z.enum(bloodGroupValues).optional(),
	documentReference: z.string().trim().max(500).optional(),
	institutionId: z.string().uuid().optional(),
});

export const organRecordSchema = z.object({
	donorId: z.string().uuid(),
	organType: z.enum(organTypes),
	bloodGroup: z.enum(bloodGroupValues).optional(),
	notes: z.string().trim().max(1000).optional(),
	institutionId: z.string().uuid().optional(),
});

export const organStatusSchema = z.object({ status: z.enum(["REGISTERED", "ASSESSMENT_PENDING", "ELIGIBLE_FOR_COORDINATION", "AVAILABLE", "MATCHING", "OFFERED", "ACCEPTED", "RETRIEVAL_SCHEDULED", "RETRIEVAL_IN_PROGRESS", "RETRIEVED", "PRESERVING", "IN_TRANSIT", "ARRIVED", "FINAL_ASSESSMENT", "ALLOCATED", "TRANSPLANTED", "COMPLETED", "UNAVAILABLE", "EXPIRED", "DISCARDED", "CANCELLED"]) });

export const recipientRequirementSchema = z.object({
	organType: z.enum(organTypes),
	bloodGroup: z.enum(bloodGroupValues).optional(),
	priority: z.enum(priorityValues).default("NORMAL"),
	latitude: z.number().min(-90).max(90).optional(),
	longitude: z.number().min(-180).max(180).optional(),
	maximumDistanceKm: z.number().positive().max(5000).optional(),
	urgency: z.string().trim().max(80).optional(),
	requiredBy: z.coerce.date().optional(),
	institutionId: z.string().uuid().optional(),
}).superRefine((value, context) => {
	if ((value.latitude === undefined) !== (value.longitude === undefined)) context.addIssue({ code: z.ZodIssueCode.custom, path: [value.latitude === undefined ? "latitude" : "longitude"], message: "Provide both coordinates or neither." });
});

export const organMatchingSchema = z.object({ radiusKm: z.number().positive().max(5000).optional() });
export const organMatchReviewSchema = z.object({ status: z.enum(["UNDER_REVIEW", "SHORTLISTED", "REJECTED"]) });
export const organOfferSchema = z.object({ matchId: z.string().uuid(), responseDeadline: z.coerce.date(), responseReason: z.string().trim().max(500).optional() });
export const organOfferResponseSchema = z.object({ action: z.enum(["ACCEPT", "REJECT"]), responseReason: z.string().trim().max(500).optional() });
export const organProcurementSchema = z.object({ organId: z.string().uuid(), scheduledAt: z.coerce.date(), responsibleReference: z.string().trim().max(120).optional(), notes: z.string().trim().max(1000).optional() });
export const procurementStatusSchema = z.object({ status: z.enum(["IN_PROGRESS", "COMPLETED", "CANCELLED", "FAILED"]) });
export const preservationStartSchema = z.object({ method: z.enum(preservationMethods), solution: z.string().trim().max(120).optional() });
export const preservationPolicySchema = z.object({ institutionId: z.string().uuid().optional(), organType: z.enum(organTypes), method: z.enum(preservationMethods), targetHours: z.number().positive().max(1000), warningHours: z.number().positive().max(1000), criticalHours: z.number().positive().max(1000), maximumHours: z.number().positive().max(1000), label: z.string().trim().min(4).max(100).default("DEMO / CONFIGURABLE - NOT A CLINICAL RULE").refine((label) => label.toUpperCase().includes("NOT A CLINICAL RULE"), "Keep the policy disclaimer in its label.") }).superRefine((value, context) => {
	if (!(value.maximumHours >= value.targetHours && value.targetHours >= value.warningHours && value.warningHours >= value.criticalHours)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximumHours"], message: "Set maximum >= target >= warning >= critical hours." });
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
