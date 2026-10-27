import { BloodComponent, BloodGroup, InstitutionStatus, InstitutionType } from "@prisma/client";
import { database } from "@lifelink/database";
import { geocodeLocation } from "../rag/live-context";
import { calculateDistance } from "./geospatial.service";

export type FacilityCategory = "blood" | "hospital" | "clinic" | "care" | "pharmacy" | "other" | "emergency" | "organ" | "all";
export type FacilitySource = "LIFELINK" | "OPENSTREETMAP";
export interface DiscoveredFacility {
  id: string;
  name: string;
  type: "BLOOD_BANK" | "HOSPITAL" | "ORGAN_CENTRE" | "EMERGENCY_DEPARTMENT" | "CLINIC" | "PHARMACY" | "OTHER_HEALTHCARE_FACILITY";
  address: string;
  latitude: number | null;
  longitude: number | null;
  phone: string | null;
  website: string | null;
  openingHours: string | null;
  photoUrl: string | null;
  /** Attribution for a freely licensed photo (Wikimedia Commons); null when no photo is shown. */
  photoCredit?: string | null;
  photoSourceUrl?: string | null;
  sourceUrl: string | null;
  retrievedAt: string;
  distanceKm: number | null;
  source: FacilitySource;
  verification: "REGISTERED_ACTIVE" | "EXTERNAL_LISTING";
  emergencyServiceStatus: "REGISTERED" | "LISTED" | "UNKNOWN";
  inventory: { status: "CONFIRMED" | "STALE" | "NOT_FOUND" | "UNAVAILABLE"; bloodGroup?: string; component?: string; units?: number; updatedAt?: string };
  directionsUrl: string | null;
}

type Place = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
type Coordinates = { latitude: number; longitude: number; displayName?: string };
type FacilityLookupIssue = "NOT_CONFIGURED" | "LOCATION_UNAVAILABLE" | "RATE_LIMITED" | "LOOKUP_FAILED";
const searchCache = new Map<string, { expiresAt: number; value: DiscoveredFacility[]; unavailableReason?: FacilityLookupIssue }>();

function overpassEndpoint() { return (process.env.OVERPASS_API_URL || "").trim(); }
export function isFacilityDiscoveryConfigured() { return Boolean(overpassEndpoint()); }
function validCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

async function resolveLocation(location: string): Promise<Coordinates | null> {
  return geocodeLocation(location);
}

function overpassQuery(category: FacilityCategory, latitude: number, longitude: number, radius: number) {
  const selectors: Record<FacilityCategory, string[]> = {
    blood: ['["amenity"="blood_donation"]', '["healthcare"="blood_donation"]', '["healthcare"="blood_bank"]'],
    hospital: ['["amenity"="hospital"]', '["healthcare"="hospital"]'],
    emergency: ['["amenity"="hospital"]', '["healthcare"="hospital"]', '["emergency"="yes"]["amenity"="hospital"]', '["healthcare"="emergency_department"]'],
    clinic: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["healthcare"="clinic"]', '["healthcare"="doctor"]'],
    care: ['["amenity"="clinic"]', '["amenity"="doctors"]', '["healthcare"="clinic"]', '["healthcare"="doctor"]', '["amenity"="hospital"]', '["healthcare"="hospital"]'],
    pharmacy: ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]'],
    other: ['["healthcare"]'],
    organ: ['["healthcare"="transplant"]', '["healthcare:speciality"~"transplant"]'],
    all: ['["amenity"="hospital"]', '["healthcare"="hospital"]', '["amenity"="clinic"]', '["amenity"="doctors"]', '["healthcare"="clinic"]', '["healthcare"="doctor"]', '["amenity"="pharmacy"]', '["healthcare"="pharmacy"]', '["amenity"="blood_donation"]', '["healthcare"="blood_donation"]', '["healthcare"="blood_bank"]', '["healthcare"="emergency_department"]', '["healthcare"]'],
  };
  const clauses = selectors[category].map((selector) => `node(around:${radius},${latitude},${longitude})${selector};way(around:${radius},${latitude},${longitude})${selector};relation(around:${radius},${latitude},${longitude})${selector};`).join("\n");
  return `[out:json][timeout:12];(${clauses});out center tags;`;
}

function externalType(tags: Record<string, string>, category: FacilityCategory): DiscoveredFacility["type"] {
  if (tags.amenity === "blood_donation" || tags.healthcare === "blood_donation" || tags.healthcare === "blood_bank") return "BLOOD_BANK";
  if (tags.healthcare === "emergency_department") return "EMERGENCY_DEPARTMENT";
  if (tags.amenity === "hospital" || tags.healthcare === "hospital") return "HOSPITAL";
  if (tags.amenity === "clinic" || tags.amenity === "doctors" || tags.healthcare === "clinic" || tags.healthcare === "doctor") return "CLINIC";
  if (tags.amenity === "pharmacy" || tags.healthcare === "pharmacy") return "PHARMACY";
  if (tags.healthcare === "transplant" || tags["healthcare:speciality"]?.toLocaleLowerCase().includes("transplant")) return "ORGAN_CENTRE";
  return "OTHER_HEALTHCARE_FACILITY";
}

function safePhone(value?: string | null) {
  if (!value) return null;
  const phone = value.trim();
  if (!/^[+\d().\-\s]+$/.test(phone) || phone.replace(/\D/g, "").length < 7 || phone.replace(/\D/g, "").length > 15) return null;
  return phone;
}

function matchesCategory(type: DiscoveredFacility["type"], _tags: Record<string, string>, category: FacilityCategory) {
  if (category === "all") return true;
  if (category === "emergency") return type === "EMERGENCY_DEPARTMENT" || type === "HOSPITAL";
  if (category === "hospital") return type === "HOSPITAL" || type === "EMERGENCY_DEPARTMENT";
  if (category === "blood") return type === "BLOOD_BANK";
  if (category === "clinic") return type === "CLINIC";
  if (category === "care") return type === "CLINIC" || type === "HOSPITAL" || type === "EMERGENCY_DEPARTMENT";
  if (category === "pharmacy") return type === "PHARMACY";
  if (category === "organ") return type === "ORGAN_CENTRE";
  return type === "OTHER_HEALTHCARE_FACILITY";
}

function isPlaceRecord(value: unknown): value is Place {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (!(["node", "way", "relation"].includes(String(candidate.type)) && Number.isSafeInteger(candidate.id) && Number(candidate.id) > 0)) return false;
  if (candidate.tags === undefined) return true;
  return Boolean(candidate.tags && typeof candidate.tags === "object" && !Array.isArray(candidate.tags) && Object.values(candidate.tags as Record<string, unknown>).every((tag) => typeof tag === "string"));
}

function externalAddress(tags: Record<string, string>) {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  return [street, tags["addr:suburb"], tags["addr:city"], tags["addr:state"], tags["addr:postcode"]].filter(Boolean).join(", ") || tags["addr:full"] || "Address not listed";
}

function safeWebsite(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "http:" || url.protocol === "https:") ? url.toString() : null; }
  catch { return null; }
}

/**
 * Photos only from OpenStreetMap's Wikimedia Commons references, which are freely licensed and
 * credited. Arbitrary `image` URLs on other hosts are never hotlinked, and nothing is generated.
 */
export function commonsPhotoFromTags(tags: Record<string, string>): { photoUrl: string; photoCredit: string; photoSourceUrl: string } | null {
  const commons = tags.wikimedia_commons?.trim();
  if (commons && /^File:[^/\\#?]+\.(?:jpe?g|png|webp)$/i.test(commons)) {
    const file = commons.slice(5).replace(/ /g, "_");
    return {
      photoUrl: `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=480`,
      photoCredit: "Photo: Wikimedia Commons (see source for author and licence)",
      photoSourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
    };
  }
  const image = tags.image?.trim();
  if (image) {
    try {
      const url = new URL(image);
      if (url.protocol === "https:" && !url.username && !url.password && url.hostname === "upload.wikimedia.org" && /\.(?:jpe?g|png|webp)$/i.test(url.pathname)) {
        return { photoUrl: url.toString(), photoCredit: "Photo: Wikimedia Commons (see source for author and licence)", photoSourceUrl: url.toString() };
      }
    } catch { /* Malformed image tags are ignored. */ }
  }
  return null;
}

export function mapExternalPlace(place: Place, category: FacilityCategory, center: Coordinates): DiscoveredFacility | null {
  const tags = place.tags ?? {};
  if (!["node", "way", "relation"].includes(place.type) || !Number.isSafeInteger(place.id) || place.id <= 0) return null;
  const latitude = place.lat ?? place.center?.lat, longitude = place.lon ?? place.center?.lon;
  if (!tags.name || latitude === undefined || longitude === undefined || !validCoordinates(latitude, longitude)) return null;
  const distanceKm = Math.round(calculateDistance(center.latitude, center.longitude, latitude, longitude) * 10) / 10;
  const type = externalType(tags, category);
  if (!matchesCategory(type, tags, category)) return null;
  const photo = commonsPhotoFromTags(tags);
  return {
    id: `osm:${place.type}:${place.id}`, name: tags.name, type, address: externalAddress(tags), latitude, longitude,
    phone: safePhone(tags.phone || tags["contact:phone"]), website: safeWebsite(tags.website || tags["contact:website"]),
    openingHours: tags.opening_hours || null, photoUrl: photo?.photoUrl ?? null, photoCredit: photo?.photoCredit ?? null, photoSourceUrl: photo?.photoSourceUrl ?? null, sourceUrl: `https://www.openstreetmap.org/${place.type}/${place.id}`, retrievedAt: new Date().toISOString(), distanceKm, source: "OPENSTREETMAP", verification: "EXTERNAL_LISTING",
    emergencyServiceStatus: type === "EMERGENCY_DEPARTMENT" || tags.emergency === "yes" ? "LISTED" : "UNKNOWN",
    inventory: { status: "NOT_FOUND" },
    directionsUrl: `https://www.openstreetmap.org/directions?to=${latitude}%2C${longitude}`,
  };
}

export async function fetchOverpassPlaces(
  category: FacilityCategory,
  center: Coordinates,
  radiusKm: number,
  endpoint = overpassEndpoint(),
  fetcher: typeof fetch = fetch,
): Promise<{ places: Place[]; error?: FacilityLookupIssue }> {
  if (!endpoint) return { places: [], error: "NOT_CONFIGURED" };
  if (!center) return { places: [], error: "LOOKUP_FAILED" };
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", "user-agent": process.env.GEOCODING_USER_AGENT || "LifeLinkPlatform/1.0 (facility discovery)" },
      body: new URLSearchParams({ data: overpassQuery(category, center.latitude, center.longitude, Math.round(radiusKm * 1000)) }),
      signal: AbortSignal.timeout(14_000),
    });
    if (response.status === 429) return { places: [], error: "RATE_LIMITED" };
    if (!response.ok) return { places: [], error: "LOOKUP_FAILED" };
    const payload = await response.json() as { elements?: unknown };
    if (!Array.isArray(payload.elements)) return { places: [], error: "LOOKUP_FAILED" };
    const places = payload.elements.filter(isPlaceRecord);
    return { places, ...(places.length !== payload.elements.length ? { error: "LOOKUP_FAILED" as const } : {}) };
  } catch {
    return { places: [], error: "LOOKUP_FAILED" };
  }
}

function normalizeName(name: string) { return name.toLocaleLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim(); }

export function dedupeFacilities(internal: DiscoveredFacility[], external: DiscoveredFacility[], radiusKm: number): DiscoveredFacility[] {
  const deduped: DiscoveredFacility[] = [];
  const names = new Set<string>();
  for (const facility of [...internal, ...external]) {
    const name = normalizeName(facility.name);
    const match = deduped.find((item) => normalizeName(item.name) === name && (item.distanceKm === null || facility.distanceKm === null || Math.abs(item.distanceKm - facility.distanceKm) < 0.5));
    if (match) { names.add(name); continue; }
    if (facility.distanceKm !== null && facility.distanceKm > radiusKm) continue;
    if (facility.source === "OPENSTREETMAP" && names.has(name)) continue;
    deduped.push(facility);
  }
  return deduped.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity)).slice(0, 40);
}

/** Rank care options by fit first, then capability, reachability, and useful details. */
export function rankFacilities(facilities: DiscoveredFacility[], category: FacilityCategory): DiscoveredFacility[] {
  const emergencyRank = (facility: DiscoveredFacility) => facility.emergencyServiceStatus === "REGISTERED" ? 0 : facility.emergencyServiceStatus === "LISTED" ? 1 : 2;
  const completeness = (facility: DiscoveredFacility) => Number(Boolean(facility.phone)) + Number(Boolean(facility.website)) + Number(Boolean(facility.openingHours)) + Number(Boolean(facility.address && facility.address !== "Address not listed"));
  return [...facilities].sort((a, b) => {
    if (category === "care") {
      const careFit = (facility: DiscoveredFacility) => facility.type === "CLINIC" ? 0 : facility.type === "EMERGENCY_DEPARTMENT" ? 1 : facility.type === "HOSPITAL" ? 2 : 3;
      const fitDifference = careFit(a) - careFit(b);
      if (fitDifference) return fitDifference;
      if (a.type !== "CLINIC" && b.type !== "CLINIC") {
        const capabilityDifference = emergencyRank(a) - emergencyRank(b);
        if (capabilityDifference) return capabilityDifference;
      }
    }
    if (category === "emergency" || category === "hospital") {
      const capabilityDifference = emergencyRank(a) - emergencyRank(b);
      if (capabilityDifference) return capabilityDifference;
    }
    const distanceDifference = (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);
    if (distanceDifference) return distanceDifference;
    const verificationDifference = Number(b.verification === "REGISTERED_ACTIVE") - Number(a.verification === "REGISTERED_ACTIVE");
    return verificationDifference || completeness(b) - completeness(a);
  });
}

export async function searchDiscoveredFacilities(input: {
  location?: string; latitude?: number; longitude?: number; category: FacilityCategory; radiusKm: number; bloodGroup?: BloodGroup; component?: BloodComponent;
}): Promise<{ facilities: DiscoveredFacility[]; center: Coordinates | null; provider: "OPENSTREETMAP" | "UNAVAILABLE"; unavailableReason?: FacilityLookupIssue }> {
  let center: Coordinates | null = input.latitude !== undefined && input.longitude !== undefined
    ? { latitude: input.latitude, longitude: input.longitude }
    : input.location ? await resolveLocation(input.location).catch(() => null) : null;
  if (!center) return { facilities: [], center: null, provider: isFacilityDiscoveryConfigured() ? "OPENSTREETMAP" : "UNAVAILABLE", unavailableReason: "LOCATION_UNAVAILABLE" };

  const cacheKey = `${overpassEndpoint()}|${input.category}|${input.radiusKm}|${input.bloodGroup ?? ""}|${input.component ?? ""}|${center.latitude.toFixed(3)},${center.longitude.toFixed(3)}`;
  const cached = searchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return { facilities: cached.value, center, provider: isFacilityDiscoveryConfigured() ? "OPENSTREETMAP" : "UNAVAILABLE", ...(cached.unavailableReason ? { unavailableReason: cached.unavailableReason } : {}) };

  const external: DiscoveredFacility[] = [];
  const externalResponse = await fetchOverpassPlaces(input.category, center, input.radiusKm);
  for (const place of externalResponse.places) { const mapped = mapExternalPlace(place, input.category, center); if (mapped) external.push(mapped); }

  let internal: DiscoveredFacility[] = [];
  try {
    const typeQuery = input.category === "blood" ? [{ type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } }]
      : input.category === "organ" ? [{ type: InstitutionType.ORGAN_CENTRE }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { organService: { isNot: null } } } }]
      : input.category === "emergency" ? [{ type: InstitutionType.HOSPITAL }]
        : input.category === "hospital" || input.category === "care" ? [{ type: InstitutionType.HOSPITAL }]
        : [{ type: InstitutionType.HOSPITAL }, { type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.ORGAN_CENTRE }];
    const rows = input.category === "clinic" || input.category === "pharmacy" || input.category === "other" ? [] : await database.institution.findMany({ where: { status: InstitutionStatus.ACTIVE, deletedAt: null, OR: typeQuery }, select: { id: true, name: true, type: true, address: true, contactNumber: true, latitude: true, longitude: true, hospitalProfile: { select: { emergencySupport: true } } }, take: 500 });
    let inventoryStatus: "NOT_FOUND" | "UNAVAILABLE" = "NOT_FOUND";
    const inventoryByInstitution = new Map<string, { units: number; updatedAt: Date; group: BloodGroup; component: BloodComponent }>();
    if (input.bloodGroup && (input.category === "blood" || input.category === "all")) {
      try {
        const records = await database.bloodInventory.findMany({ where: { bloodGroup: input.bloodGroup, ...(input.component ? { component: input.component } : {}), status: "AVAILABLE", unitsAvailable: { gt: 0 }, OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }], institution: { status: InstitutionStatus.ACTIVE, deletedAt: null } }, orderBy: { lastUpdated: "desc" }, select: { institutionId: true, bloodGroup: true, component: true, unitsAvailable: true, lastUpdated: true }, take: 500 });
        for (const record of records) {
          if (Date.now() - record.lastUpdated.getTime() <= 24 * 60 * 60 * 1000) inventoryByInstitution.set(record.institutionId, { units: record.unitsAvailable, updatedAt: record.lastUpdated, group: record.bloodGroup, component: record.component });
          else if (!inventoryByInstitution.has(record.institutionId)) inventoryByInstitution.set(record.institutionId, { units: 0, updatedAt: record.lastUpdated, group: record.bloodGroup, component: record.component });
        }
      } catch { inventoryStatus = "UNAVAILABLE"; }
    }
    internal = rows.map((row) => {
      const distanceKm = row.latitude !== null && row.longitude !== null ? Math.round(calculateDistance(center!.latitude, center!.longitude, row.latitude, row.longitude) * 10) / 10 : null;
      const inventory = inventoryByInstitution.get(row.id);
      return {
        id: `lifelink:${row.id}`, name: row.name, type: row.type as DiscoveredFacility["type"], address: row.address,
        latitude: row.latitude, longitude: row.longitude, phone: safePhone(row.contactNumber), website: null, openingHours: null, photoUrl: null, sourceUrl: null, retrievedAt: new Date().toISOString(),
        distanceKm, source: "LIFELINK" as const, verification: "REGISTERED_ACTIVE" as const,
        emergencyServiceStatus: row.hospitalProfile?.emergencySupport ? "REGISTERED" as const : "UNKNOWN" as const,
        inventory: inventoryStatus === "UNAVAILABLE" ? { status: "UNAVAILABLE" as const } : inventory ? inventory.units > 0 ? { status: "CONFIRMED" as const, bloodGroup: inventory.group, component: inventory.component, units: inventory.units, updatedAt: inventory.updatedAt.toISOString() } : { status: "STALE" as const, bloodGroup: inventory.group, component: inventory.component, updatedAt: inventory.updatedAt.toISOString() } : { status: "NOT_FOUND" as const },
        directionsUrl: row.latitude !== null && row.longitude !== null ? `https://www.openstreetmap.org/directions?to=${row.latitude}%2C${row.longitude}` : null,
      };
    }).filter((facility) => facility.distanceKm !== null && facility.distanceKm <= input.radiusKm);
  } catch { internal = []; }

  const facilities = rankFacilities(dedupeFacilities(internal, external, input.radiusKm), input.category);
  searchCache.set(cacheKey, { value: facilities, expiresAt: Date.now() + 60_000, ...(externalResponse.error ? { unavailableReason: externalResponse.error } : {}) });
  return { facilities, center, provider: isFacilityDiscoveryConfigured() ? "OPENSTREETMAP" : "UNAVAILABLE", ...(externalResponse.error ? { unavailableReason: externalResponse.error } : {}) };
}

export function clearFacilityDiscoveryCacheForTests() { searchCache.clear(); }
export function buildOverpassQueryForTests(category: FacilityCategory, latitude: number, longitude: number, radius: number) { return overpassQuery(category, latitude, longitude, radius); }
