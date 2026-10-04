// Package entry point for stable cross-layer domain definitions.
export * from "./api-contracts";
export * from "./enums";
export * from "./roles";
export * from "./workflow-status";

export function createSharedDomainContext() {
  return "lifelink-domain";
}
