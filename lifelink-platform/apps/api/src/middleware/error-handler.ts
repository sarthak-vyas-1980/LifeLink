import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "./api-error";

interface SafeError {
  status: number;
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

// Convert known failures into safe, consistent API responses.
export const handleApiError: ErrorRequestHandler = (
  error,
  request,
  response,
  _next,
) => {
  const safeError = mapRequestError(error);
  if (safeError.status >= 500) {
    recordUnexpectedError(error);
  }

  response.status(safeError.status).json({
    code: safeError.code,
    message: safeError.message,
    traceId: request.traceId,
    ...(safeError.fieldErrors ? { fieldErrors: safeError.fieldErrors } : {}),
  });
};

// Map failures without exposing stacks, credentials, or protected record details.
export function mapRequestError(error: unknown): SafeError {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      fieldErrors: error.fieldErrors,
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      code: "VALIDATION_FAILED",
      message: "Request validation failed.",
      fieldErrors: error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (["P1000", "P1001", "P1002", "P1017"].includes(code)) {
      return { status: 503, code: "DATABASE_UNAVAILABLE", message: "The database is temporarily unavailable. Please try again shortly." };
    }
    if (code === "P2002") {
      return { status: 409, code: "RESOURCE_CONFLICT", message: "A record with those details already exists." };
    }
    if (code === "P2025") {
      return { status: 404, code: "NOT_FOUND", message: "Requested resource was not found." };
    }
    if (code === "P2003" || code === "P2000") {
      return { status: 400, code: "INVALID_REFERENCE", message: "A referenced value is invalid." };
    }
  }

  if (error instanceof Error && error.name === "PrismaClientInitializationError") {
    return { status: 503, code: "DATABASE_UNAVAILABLE", message: "The database is temporarily unavailable. Please try again shortly." };
  }

  if (
    error instanceof SyntaxError &&
    "status" in error &&
    (error as SyntaxError & { status?: number }).status === 400
  ) {
    return { status: 400, code: "INVALID_JSON", message: "Request body must contain valid JSON." };
  }

  if (error instanceof Error && error.message.includes("not authorized")) {
    return {
      status: 403,
      code: "FORBIDDEN",
      message: "Operation is not authorized.",
    };
  }

  if (error instanceof Error && error.message.includes("not found")) {
    return {
      status: 404,
      code: "NOT_FOUND",
      message: "Requested resource was not found.",
    };
  }

  if (error instanceof Error && error.message.includes("does not belong to the requesting institution")) {
    return { status: 404, code: "INVENTORY_NOT_FOUND", message: "Inventory record not found." };
  }

  if (error instanceof Error && error.message.includes("state changed")) {
    return { status: 409, code: "WORKFLOW_CONFLICT", message: "The record changed. Refresh and try again." };
  }

  return {
    status: 500,
    code: "INTERNAL_ERROR",
    message: "The operation could not be completed.",
  };
}

// Record only safe diagnostics; request bodies and credentials are never logged.
export function recordUnexpectedError(error: unknown) {
  console.error(
    "LifeLink API error",
    error instanceof Error ? error.name : "UnknownError",
  );
}
