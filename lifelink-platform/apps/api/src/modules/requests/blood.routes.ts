// Define the blood-request lifecycle endpoints.
export function registerBloodRequestRoutes() {
  // Expose creation, search, offer, reservation, dispatch, and closure actions.
}

// Create a request in the initial review state.
export function createBloodRequest() {
  // Validate requester, group, quantity, location, priority, and contact data.
}

// Move a request from review into searching/matching.
export function startBloodMatching() {
  // Call the matching service only after the request is valid and authorized.
}

// Accept, reject, or reopen an offer.
export function evaluateBloodOffer() {
  // Apply the state diagram and notify the relevant participants.
}

// Reserve, dispatch, receive, fulfil, cancel, or expire a request.
export function transitionBloodRequest() {
  // Update inventory, request state, events, and audit records transactionally.
}
