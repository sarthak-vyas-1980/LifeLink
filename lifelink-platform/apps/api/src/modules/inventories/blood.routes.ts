// Define authorized blood-inventory endpoints.
export function registerBloodInventoryRoutes() {
  // Protect mutations with institution scope and quantity validation.
}

// Add a blood inventory record.
export function createBloodInventory() {
  // Validate group, component, quantity, dates, and availability status.
}

// Update quantity or status without allowing negative stock.
export function updateBloodInventory() {
  // Write the change transactionally and record its timestamp and actor.
}

// Find eligible blood sources for a request.
export function searchBloodInventory() {
  // Rank by compatibility criteria, distance, freshness, expiry, and stock.
}

// Reserve or consume units as part of an authorized workflow.
export function changeBloodAvailability() {
  // Prevent races and publish the resulting operational status event.
}
