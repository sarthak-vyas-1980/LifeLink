import type { ErrorRequestHandler } from "express";

interface SafeError {
  status: number;
  code: string;
  message: string;
}

// Convert known failures into safe, consistent API responses.
export const handleApiError: ErrorRequestHandler = (
  error,
  _request,
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
  });
};

// Map failures without exposing stacks, credentials, or protected record details.
export function mapRequestError(error: unknown): SafeError {
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
