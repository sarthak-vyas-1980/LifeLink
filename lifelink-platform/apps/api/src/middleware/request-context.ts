import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
    }
  }
}

// Attach an opaque correlation ID without trusting a caller-supplied identifier.
export const requestContext: RequestHandler = (request, response, next) => {
  request.traceId = randomUUID();
  response.setHeader("x-request-id", request.traceId);
  next();
};
