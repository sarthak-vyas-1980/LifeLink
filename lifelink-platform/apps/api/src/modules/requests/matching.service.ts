import { BloodComponent, BloodGroup, RequestStatus } from "@prisma/client";
import {
  createMatch,
  findMatchesForRequest,
  findRequestById,
  searchAvailableInventory,
  saveRequestTransition,
} from "@lifelink/database";
import {
  calculateDistance,
  filterFacilitiesByRadius,
  rankNearbyFacilities,
} from "../maps/geospatial.service";

export interface BloodMatchCandidate {
  matchId?: string;
  inventoryId: string;
  institutionId: string;
  institutionName: string;
  unitsAvailable: number;
  expiryDate: Date | null;
  lastUpdated: Date;
  distanceKm?: number;
  freshnessMinutes: number;
  expiryProximityHours?: number;
  score: number;
  guaranteedFulfilment: false;
}

export interface BloodMatchingResult {
  status: "MATCHES_FOUND" | "NO_MATCH";
  candidates: BloodMatchCandidate[];
  retry: {
    canWidenRadius: boolean;
    suggestedRadiusKm?: number;
    reason?: string;
  };
}

function scoreCandidate(
  candidate: Omit<BloodMatchCandidate, "score" | "guaranteedFulfilment">,
  quantity: number,
  radiusKm?: number,
) {
  const distanceScore =
    candidate.distanceKm === undefined || radiusKm === undefined
      ? 1
      : Math.max(0, 1 - candidate.distanceKm / radiusKm);
  const stockScore = Math.min(candidate.unitsAvailable / quantity, 3) / 3;
  const freshnessScore = Math.max(0, 1 - candidate.freshnessMinutes / 1440);
  const expiryScore =
    candidate.expiryProximityHours === undefined
      ? 0.5
      : Math.max(0, Math.min(candidate.expiryProximityHours / 168, 1));

  return Number(
    (
      distanceScore * 0.35 +
      stockScore * 0.3 +
      freshnessScore * 0.2 +
      expiryScore * 0.15
    ).toFixed(4),
  );
}

// Rank candidate providers without presenting the result as guaranteed fulfilment.
export function rankMatches(candidates: BloodMatchCandidate[]) {
  return [...candidates].sort(
    (first, second) =>
      second.score - first.score ||
      (first.distanceKm ?? Infinity) - (second.distanceKm ?? Infinity),
  );
}

// Find live blood candidates using resource, quantity, location, freshness, and expiry filters.
export async function findBloodMatches(input: {
  requestId: string;
  bloodGroup: BloodGroup;
  component: BloodComponent;
  quantity: number;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
  freshnessMinutes?: number;
}): Promise<BloodMatchingResult> {
  const inventory = await searchAvailableInventory({
    bloodGroup: input.bloodGroup,
    component: input.component,
    quantity: input.quantity,
    freshnessMinutes: input.freshnessMinutes ?? 1440,
  });
  const now = Date.now();

  const candidates = inventory.map((record) => {
    const hasOrigin =
      input.latitude !== undefined && input.longitude !== undefined;
    const hasProviderLocation =
      record.institution.latitude !== null &&
      record.institution.longitude !== null;
    const distanceKm =
      hasOrigin && hasProviderLocation
        ? calculateDistance(
            input.latitude!,
            input.longitude!,
            record.institution.latitude!,
            record.institution.longitude!,
          )
        : undefined;
    const freshnessMinutes = Math.max(
      0,
      Math.round((now - record.lastUpdated.getTime()) / 60_000),
    );
    const expiryProximityHours = record.expiryDate
      ? Math.max(0, (record.expiryDate.getTime() - now) / 3_600_000)
      : undefined;
    const candidate = {
      inventoryId: record.id,
      institutionId: record.institutionId,
      institutionName: record.institution.name,
      unitsAvailable: record.unitsAvailable,
      expiryDate: record.expiryDate,
      lastUpdated: record.lastUpdated,
      distanceKm,
      freshnessMinutes,
      expiryProximityHours,
    };

    return {
      ...candidate,
      score: scoreCandidate(candidate, input.quantity, input.radiusKm),
      guaranteedFulfilment: false as const,
    };
  });

  const radiusCandidates = filterFacilitiesByRadius(candidates, input.radiusKm);
  const rankedCandidates = rankMatches(rankNearbyFacilities(radiusCandidates));
  const existingMatches = await findMatchesForRequest(input.requestId);
  const persistedCandidates: BloodMatchCandidate[] = [];

  for (const candidate of rankedCandidates) {
    const existing = existingMatches.find(
      (match) =>
        match.bloodInventoryId === candidate.inventoryId &&
        match.status === "PENDING",
    );
    const match =
      existing ??
      (await createMatch({
        request: { connect: { id: input.requestId } },
        providerInstitution: { connect: { id: candidate.institutionId } },
        bloodInventory: { connect: { id: candidate.inventoryId } },
        compatibilityScore: candidate.score,
      }));
    persistedCandidates.push({ ...candidate, matchId: match.id });
  }

  if (persistedCandidates.length === 0) {
    return {
      status: "NO_MATCH",
      candidates: [],
      retry: {
        canWidenRadius: input.radiusKm !== undefined,
        suggestedRadiusKm: input.radiusKm
          ? Math.min(input.radiusKm * 2, 500)
          : undefined,
        reason:
          "No current inventory candidate satisfies the requested filters.",
      },
    };
  }

  return {
    status: "MATCHES_FOUND",
    candidates: persistedCandidates,
    retry: { canWidenRadius: true },
  };
}

// Move an active search into a new auditable retry cycle after no match or rejection.
export async function reopenMatchingCycle(requestId: string, actorId?: string) {
  const request = await findRequestById(requestId);
  if (!request) {
    throw new Error("Request not found.");
  }

  return saveRequestTransition(
    requestId,
    request.status,
    RequestStatus.REOPENED,
    actorId,
  );
}

// Organ matching has a separate Phase 7 workflow and is intentionally not reused here.
export function findOrganMatches() {
  throw new Error(
    "Organ matching is implemented by the organ-coordination workflow.",
  );
}
