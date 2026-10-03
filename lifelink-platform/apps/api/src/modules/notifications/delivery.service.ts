// Build an event for a significant workflow state change.
export function createWorkflowEvent() {
  // Include safe identifiers, state, actor, and correlation metadata.
}

// Resolve authorized recipients for an event.
export function selectNotificationRecipients() {
  // Respect role, institution, request, donor, and organ-data permissions.
}

// Deliver an in-app, Socket.IO, e-mail, or SMS notification.
export function deliverNotification() {
  // Record delivery status and handle provider failure without false success.
}
