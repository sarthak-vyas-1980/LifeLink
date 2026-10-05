import type { RequestHandler } from "express";
import type { AccessRole } from "@lifelink/shared";

function deny(
  response: Parameters<RequestHandler>[1],
  code: string,
  message: string,
  traceId?: string,
) {
  response
    .status(code === "AUTH_REQUIRED" ? 401 : 403)
    .json({ code, message, traceId });
}

// Enforce role permissions before a protected handler executes.
export function authorizeAction(...allowedRoles: AccessRole[]): RequestHandler {
  return (request, response, next) => {
    if (!request.auth) {
      deny(response, "AUTH_REQUIRED", "Authentication required.", request.traceId);
      return;
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(request.auth.role)) {
      deny(response, "FORBIDDEN", "You are not authorized for this operation.", request.traceId);
      return;
    }

    next();
  };
}

// Restrict institution-scoped writes to the actor's own institution.
export function authorizeInstitutionScope(
  getInstitutionId: (
    request: Parameters<RequestHandler>[0],
  ) => string | undefined,
): RequestHandler {
  return (request, response, next) => {
    if (!request.auth) {
      deny(response, "AUTH_REQUIRED", "Authentication required.", request.traceId);
      return;
    }

    const institutionId = getInstitutionId(request);
    const isAdministrator = request.auth.role === "ADMINISTRATOR";
    if (
      !isAdministrator &&
      (!institutionId || institutionId !== request.auth.institutionId)
    ) {
      deny(
        response,
        "INSTITUTION_SCOPE_FORBIDDEN",
        "Institution access is restricted.",
        request.traceId,
      );
      return;
    }

    next();
  };
}

export function authorizeInstitutionCapability(capability: "blood" | "organ"): RequestHandler {
  return (request, response, next) => {
    const actor = request.auth;
    if (!actor) {
      deny(response, "AUTH_REQUIRED", "Authentication required.", request.traceId);
      return;
    }
    if (actor.role === "ADMINISTRATOR") {
      next();
      return;
    }
    if (actor.principalType !== "INSTITUTION" || !actor.capabilities?.[capability]) {
      deny(response, "INSTITUTION_CAPABILITY_REQUIRED", `This institution does not have ${capability} services enabled.`, request.traceId);
      return;
    }
    next();
  };
}

// Check access to sensitive records before returning them.
export function authorizeResourceAccess(
  allowedRoles: AccessRole[],
  ownerId?: string,
  institutionId?: string,
) {
  return (
    request: Parameters<RequestHandler>[0],
    response: Parameters<RequestHandler>[1],
    next: Parameters<RequestHandler>[2],
  ) => {
    if (!request.auth) {
      deny(response, "AUTH_REQUIRED", "Authentication required.", request.traceId);
      return;
    }

    const roleAllowed =
      allowedRoles.length === 0 || allowedRoles.includes(request.auth.role);
    const ownerAllowed = !ownerId || ownerId === request.auth.userId;
    const institutionAllowed =
      !institutionId ||
      institutionId === request.auth.institutionId ||
      request.auth.role === "ADMINISTRATOR";
    if (!roleAllowed || !ownerAllowed || !institutionAllowed) {
      deny(
        response,
        "FORBIDDEN",
        "The requested resource is not available to this account.",
        request.traceId,
      );
      return;
    }

    next();
  };
}

// Resolve the permitted audience for a workflow event or notification.
export function resolveAuthorizedRecipients(
  recipients: Array<{ userId: string; institutionId?: string; role: AccessRole }>,
  eventInstitutionId?: string,
) {
  return recipients.filter(
    (recipient) =>
      recipient.role === "ADMINISTRATOR" ||
      !eventInstitutionId ||
      recipient.institutionId === eventInstitutionId,
  );
}
