// Validate request shape before it reaches a feature handler.
export function validateRequest() {
  // Reject incomplete, malformed, or unsafe payloads with clear field errors.
}

// Validate identifiers and query filters used by discovery workflows.
export function validateSearchCriteria() {
  // Check blood group, quantity, location, radius, priority, and pagination.
}

// Validate a state transition before changing an operational record.
export function validateWorkflowTransition() {
  // Keep request, offer, reservation, procurement, and transport states legal.
}
