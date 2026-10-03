// Read the current authenticated user and role context.
export function getCurrentSession() {
  // Keep session state aligned with backend authorization.
}

// Redirect a user to the permitted role-specific experience.
export function resolveRoleDestination() {
  // Never use client routing as the only authorization boundary.
}

// End the current session from the web client.
export async function signOut() {
  // Notify the API and clear local session state.
}
