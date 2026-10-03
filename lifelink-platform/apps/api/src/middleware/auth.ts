// Resolve the authenticated actor from the incoming request/session.
export function authenticateRequest() {
  // Verify credentials and attach only the minimum safe identity context.
}

// Create a session or token after credential verification.
export function createAuthenticatedSession() {
  // Apply configured expiry, rotation, and invalidation rules.
}

// Invalidate the current authenticated session.
export function invalidateAuthenticatedSession() {
  // Revoke the session without exposing sensitive account details.
}
