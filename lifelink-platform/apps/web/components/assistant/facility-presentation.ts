import type { DiscoveredFacility } from "./conversation-types";

export type FacilitySort = "recommended" | "distance";
export interface FacilityFilters { type: string | null; withPhone: boolean; emergencyListed: boolean; registeredOnly: boolean }
export const NO_FILTERS: FacilityFilters = { type: null, withPhone: false, emergencyListed: false, registeredOnly: false };

const TYPE_LABEL: Record<string, { one: string; many: string }> = {
  HOSPITAL: { one: "Hospital", many: "Hospitals" },
  EMERGENCY_DEPARTMENT: { one: "Emergency department", many: "Emergency departments" },
  CLINIC: { one: "Clinic / doctor", many: "Clinics & doctors" },
  PHARMACY: { one: "Pharmacy", many: "Pharmacies" },
  BLOOD_BANK: { one: "Blood bank", many: "Blood banks" },
  ORGAN_CENTRE: { one: "Organ centre", many: "Organ centres" },
  OTHER_HEALTHCARE_FACILITY: { one: "Healthcare facility", many: "Other healthcare" },
};

export function facilityTypeLabel(type: string, plural = false): string {
  const label = TYPE_LABEL[type] ?? { one: "Healthcare facility", many: "Healthcare facilities" };
  return plural ? label.many : label.one;
}

const CATEGORY_HEADING: Record<string, string> = {
  pharmacy: "Pharmacies", hospital: "Hospitals", emergency: "Emergency-capable hospitals", clinic: "Clinics & doctors",
  care: "Clinics & hospitals", blood: "Blood banks", organ: "Organ-service facilities", other: "Healthcare facilities", all: "Healthcare facilities",
};

/** "Pharmacies near you", "Blood banks near Palasia, Indore", or the list's own title. */
export function facilityResultsHeading(input: { category?: string; title?: string; searchLocationType?: "DEVICE" | "MANUAL"; area?: string | null }): string {
  if (input.title) return input.title;
  const what = CATEGORY_HEADING[input.category ?? "all"] ?? "Healthcare facilities";
  if (input.searchLocationType === "DEVICE") return `${what} near you`;
  const area = input.area?.split(",").slice(0, 2).join(",").trim();
  return area ? `${what} near ${area}` : `Nearby ${what.toLowerCase()}`;
}

/** Facility photos only from Wikimedia Commons over HTTPS; everything else falls back to an icon. */
export function safeFacilityPhoto(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      (url.hostname === "commons.wikimedia.org" || url.hostname === "upload.wikimedia.org") ? url.toString() : null;
  } catch { return null; }
}

export function safeWebsite(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : null; }
  catch { return null; }
}

export function safeOpenStreetMapUrl(value: string | null | undefined): string | null {
  const safe = safeWebsite(value);
  if (!safe) return null;
  const host = new URL(safe).hostname;
  return host === "www.openstreetmap.org" || host === "openstreetmap.org" ? safe : null;
}

/** One entry per id; later duplicates are dropped so the list and the map never disagree. */
export function uniqueFacilities(facilities: DiscoveredFacility[]): DiscoveredFacility[] {
  const seen = new Set<string>();
  return facilities.filter((facility) => {
    if (!facility.id || seen.has(facility.id)) return false;
    seen.add(facility.id);
    return true;
  });
}

/** Which filters the data can honestly support; a filter is offered only when it would change the list. */
export function availableFilters(facilities: DiscoveredFacility[]) {
  const types = [...new Set(facilities.map((facility) => facility.type))];
  const withPhone = facilities.filter((facility) => Boolean(facility.phone)).length;
  const emergency = facilities.filter((facility) => facility.emergencyServiceStatus !== "UNKNOWN").length;
  const registered = facilities.filter((facility) => facility.source === "LIFELINK").length;
  return {
    types: types.length > 1 ? types : [],
    withPhone: withPhone > 0 && withPhone < facilities.length,
    emergencyListed: emergency > 0 && emergency < facilities.length,
    registeredOnly: registered > 0 && registered < facilities.length,
    distance: facilities.some((facility) => facility.distanceKm !== null),
  };
}

export function applyFacilityView(facilities: DiscoveredFacility[], sort: FacilitySort, filters: FacilityFilters): DiscoveredFacility[] {
  const filtered = facilities.filter((facility) =>
    (!filters.type || facility.type === filters.type) &&
    (!filters.withPhone || Boolean(facility.phone)) &&
    (!filters.emergencyListed || facility.emergencyServiceStatus !== "UNKNOWN") &&
    (!filters.registeredOnly || facility.source === "LIFELINK"));
  // "Recommended" keeps the server's ranking (care fit, capability, then distance).
  return sort === "distance"
    ? [...filtered].sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity))
    : filtered;
}

export function formatDistance(distanceKm: number | null): string | null {
  if (distanceKm === null || !Number.isFinite(distanceKm)) return null;
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`;
}
