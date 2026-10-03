// Check whether an actor may perform an operation for a resource.
export function authorizeAction() {
  // Enforce role, institution scope, and workflow-specific permissions.
}

// Check access to sensitive records before returning them.
export function authorizeResourceAccess() {
  // Apply least-privilege rules to donor, recipient, organ, and document data.
}

// Resolve the permitted audience for an event or notification.
export function resolveAuthorizedRecipients() {
  // Prevent restricted real-time events from crossing role boundaries.
}
