// Compose the HTTP application without placing business rules in this file.
export function createApp() {
  // Register security, parsing, validation, routes, and error handling.
}

// Mount feature routers behind the API boundary.
export function registerRoutes() {
  // Keep route registration grouped by SRS feature and user role.
}

// Register shared middleware in request-processing order.
export function registerMiddleware() {
  // Authentication and RBAC must protect routes before handlers execute.
}
