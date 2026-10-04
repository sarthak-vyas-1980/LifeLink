import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerBloodInventoryRoutes } from "./modules/inventories/blood.routes";
import { registerBloodRequestRoutes } from "./modules/requests/blood.routes";
import { registerNotificationRoutes } from "./modules/notifications/routes";
import { registerEmergencyRoutes } from "./modules/emergency/routes";
import { registerUserRoutes } from "./modules/users/routes";
import { registerInstitutionRoutes } from "./modules/institutions/routes";
import { handleApiError } from "./middleware/error-handler";
import { requestContext } from "./middleware/request-context";
import { ApiError } from "./middleware/api-error";

// Compose the HTTP application without placing business rules in this file.
export function createApp() {
  const app = express();
  registerMiddleware(app);
  registerRoutes(app);
  app.use((request, _response, next) =>
    next(new ApiError(404, "ROUTE_NOT_FOUND", "API route not found.")),
  );
  app.use(handleApiError);
  return app;
}

// Mount routes grouped by SRS feature and actor responsibility.
export function registerRoutes(app: Express) {
  app.use("/api/auth", registerAuthRoutes());
  app.use("/api/users", registerUserRoutes());
  app.use("/api/institutions", registerInstitutionRoutes());
  app.use("/api/inventory/blood", registerBloodInventoryRoutes());
  app.use("/api/requests/blood", registerBloodRequestRoutes());
  app.use("/api/emergency", registerEmergencyRoutes());
  app.use("/api/notifications", registerNotificationRoutes());
}

// Register security and parsing middleware before feature handlers.
export function registerMiddleware(app: Express) {
  app.disable("x-powered-by");
  app.use(requestContext);
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
}
