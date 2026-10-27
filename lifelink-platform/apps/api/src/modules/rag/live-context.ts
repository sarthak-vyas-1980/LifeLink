import {
  BloodComponent,
  BloodGroup,
  BloodInventoryStatus,
  InstitutionStatus,
  InstitutionType,
  RequestType,
} from "@prisma/client";
import { database } from "@lifelink/database";
import type { AuthContext } from "../../middleware/auth";
import { ApiError } from "../../middleware/api-error";
import { calculateDistance } from "../maps/geospatial.service";
import type { QueryIntent } from "@lifelink/rag";

export type Coordinates = { latitude: number; longitude: number; displayName?: string } | null;
type LiveOutcome = {
  answer: string;
  intent: QueryIntent;
  liveDataUsed: boolean;
  handoff?: { label: string; href: string; reason: string };
  data?: Record<string, unknown>;
  needsClarification?: boolean;
};

export interface UrgentBloodDetails {
  bloodGroup?: BloodGroup;
  component?: BloodComponent;
  units?: number;
  location?: string;
}

export interface UrgentBloodFacility {
  id: string;
  name: string;
  address: string;
  contactNumber: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface UrgentBloodInventory {
  institutionId: string;
  bloodGroup: BloodGroup;
  component: BloodComponent;
  unitsAvailable: number;
  lastUpdated: Date;
}

const locationCache = new Map<string, { value: Coordinates; expiresAt: number }>();
let geocodeQueue: Promise<void> = Promise.resolve();
let nextGeocodeAt = 0;

function extractLocationParts(query: string): string[] {
  const parts = query.split(/[,;.!?\n]+/).map((part) => part.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (const part of parts) {
    const match = part.match(/\b(?:close to|near|around|located in|live in|living in|based in|in|at)\s+(.+)$/i);
    if (!match) continue;
    let place = match[1]
      .replace(/\b(?:can you|could you|please|find|search|show|check|look up|recommend|tell me|where|what|how)\b.*$/i, "")
      .replace(/\b(?:please|nearby|nearest|closest)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.-]+|[\s,.-]+$/g, "")
      .trim();
    if (place.length >= 2 && place.length <= 80 && !/^(?:the|a|an|some)$/i.test(place)) {
      if (!candidates.some((existing) => existing.toLocaleLowerCase() === place.toLocaleLowerCase())) {
        candidates.push(place);
      }
    }
  }
  // More specific locality first, followed by its city/region.
  return candidates.reverse().slice(0, 3);
}

export function extractLocationQuery(query: string): string | null {
  const homeNearLocality = query.match(/\b(?:live in|living in|based in)\s+([^,;.!?\n]+)\s*,\s*near\s+([^,;.!?\n]+)/i);
  if (homeNearLocality) {
    const city = homeNearLocality[1].trim();
    const locality = homeNearLocality[2].trim()
      .replace(/\b(?:can you|could you|please|find|search|show|check|look up|recommend|tell me|where|what|how)\b.*$/i, "")
      .trim();
    if (city.length >= 2 && city.length <= 80 && locality.length >= 2 && locality.length <= 80) {
      return `${locality}, ${city}, India`;
    }
  }
  // Preserve the common "near <locality>, <city>" form before punctuation
  // splitting would otherwise discard the bare city segment.
  const localityCity = query.match(/\b(?:near|around|close to|live in|living in|based in)\s+([^,;.!?\n]+)\s*,\s*([^,;.!?\n]+)/i);
  if (localityCity) {
    const locality = localityCity[1].replace(/^\s*(?:the|a|an)\s+/i, "").trim();
    const city = localityCity[2]
      .replace(/\b(?:can you|could you|please|find|search|show|check|look up|recommend|tell me|where|what|how)\b.*$/i, "")
      .replace(/\b(?:and i|and we|i urgently|we urgently|i need|we need|my father|my mother|the patient)\b.*$/i, "")
      .replace(/^\s*(?:the|a|an)\s+/i, "")
      .trim();
    if (locality.length >= 2 && locality.length <= 80 && city.length >= 2 && city.length <= 80) {
      return `${locality}, ${city}, India`;
    }
  }
  const parts = extractLocationParts(query);
  if (!parts.length) return null;
  return `${parts.join(", ")}, India`;
}

export async function geocodeLocation(location: string): Promise<Coordinates> {
  const cacheKey = location.toLocaleLowerCase().trim();
  const cached = locationCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const task = geocodeQueue.then(async () => {
    const delay = Math.max(0, nextGeocodeAt - Date.now());
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    nextGeocodeAt = Date.now() + 1_100;

    const endpoint = (process.env.GEOCODING_ENDPOINT || "https://nominatim.openstreetmap.org/search").replace(/\/+$/, "");
    const url = new URL(endpoint);
    url.searchParams.set("q", location);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("countrycodes", "in");
    const response = await fetch(url, {
      headers: {
        "User-Agent": process.env.GEOCODING_USER_AGENT || "LifeLinkPlatform/1.0 (location-aware assistant)",
      },
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const rows = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string; type?: string; addresstype?: string }>;
    const row = rows[0];
    if (!row || row.type === "country" || row.addresstype === "country") return null;
    const latitude = Number(row.lat);
    const longitude = Number(row.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude, displayName: row.display_name };
  });
  geocodeQueue = task.then(() => undefined, () => undefined);

  let value: Coordinates = null;
  try {
    value = await task;
  } catch {
    value = null;
  }
  locationCache.set(cacheKey, { value, expiresAt: Date.now() + (value ? 10 : 1) * 60_000 });
  return value;
}

function radiusFromQuery(query: string, nearby: boolean): number | undefined {
  const explicit = query.match(/\bwithin\s+(\d{1,3})\s*(?:km|kilomet(?:er|re)s?)\b/i);
  if (explicit) {
    const value = Number(explicit[1]);
    if (value >= 1 && value <= 500) return value;
  }
  return nearby ? 25 : undefined;
}

function parseBloodGroup(query: string): BloodGroup | null {
  const value = query.toLocaleLowerCase()
    .replace(/[+＋]/g, " positive ")
    .replace(/[−–-]/g, " negative ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ");
  const groups: Array<[RegExp, BloodGroup]> = [
    [/\bab\s+positive\b/i, BloodGroup.AB_POSITIVE],
    [/\bab\s+negative\b/i, BloodGroup.AB_NEGATIVE],
    [/\ba\s+positive\b/i, BloodGroup.A_POSITIVE],
    [/\ba\s+negative\b/i, BloodGroup.A_NEGATIVE],
    [/\bb\s+positive\b/i, BloodGroup.B_POSITIVE],
    [/\bb\s+negative\b/i, BloodGroup.B_NEGATIVE],
    [/\bo\s+positive\b/i, BloodGroup.O_POSITIVE],
    [/\bo\s+negative\b/i, BloodGroup.O_NEGATIVE],
  ];
  for (const [pattern, group] of groups) if (pattern.test(value)) return group;
  return null;
}

function parseRequestedUnits(query: string, allowBareAnswer = false): number | undefined {
  const digits = query.match(/\b(\d{1,3})\s*(?:units?|bags?)\b/i);
  if (digits) return Number(digits[1]);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const written = query.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:units?|bags?)\b/i);
  if (written) return words[written[1].toLowerCase()];
  if (allowBareAnswer) {
    const bare = query.trim().match(/(?:^|\s)(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i)?.[1];
    if (bare) return Number(bare) || words[bare.toLowerCase()];
  }
  return undefined;
}

export function extractUrgentBloodDetails(message: string, history: Array<{ role: "user" | "assistant"; content: string }> = []): UrgentBloodDetails {
  const userTurns = [...history.filter((turn) => turn.role === "user").map((turn) => turn.content), message];
  const userContext = userTurns.join("\n");
  const lastUser = userTurns.at(-1) ?? message;
  const lastAssistant = [...history].reverse().find((turn) => turn.role === "assistant")?.content ?? "";
  let location = extractLocationQuery(userContext) ?? undefined;
  if (!location && /\b(?:city|locality|landmark|where do you|where should|which area)\b/i.test(lastAssistant)) {
    const locationAnswer = lastUser
      .replace(/\b(?:ab|a|b|o)\s*(?:\+|plus|positive|−|-|negative)(?=\s|$)/gi, " ")
      .replace(/\b(?:whole blood|red blood cells?|rbc|packed cells?|plasma|platelets?|cryoprecipitate|cryo)\b/gi, " ")
      .replace(/\b\d+\s*(?:units?|bags?)?\b/gi, " ")
      .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:units?|bags?)?\b/gi, " ")
      .replace(/\b(?:and|near|in|around|at|city|locality|landmark|please|the)\b/gi, " ")
      .replace(/[^a-zA-Z0-9, -]/g, " ").replace(/\s+/g, " ").replace(/^[\s,.-]+|[\s,.-]+$/g, "").trim();
    if (locationAnswer.length >= 2 && locationAnswer.length <= 100) {
      location = `${locationAnswer}, India`;
    }
  }
  return {
    bloodGroup: parseBloodGroup(userContext) ?? undefined,
    component: parseComponent(userContext),
    units: parseRequestedUnits(userContext) ?? parseRequestedUnits(lastUser,
      /\b(?:unit|quantity|how many)\b/i.test(lastAssistant)),
    location,
  };
}

export function formatUrgentBloodAssistance(input: {
  details: UrgentBloodDetails;
  facilities: UrgentBloodFacility[];
  inventory: UrgentBloodInventory[];
  coordinates?: Coordinates;
  inventoryAvailable?: boolean;
  facilityLookupAvailable?: boolean;
  actorCanCreateRequest?: boolean;
  now?: number;
}): LiveOutcome {
  const { details } = input;
  const now = input.now ?? Date.now();
  const inventoryByFacility = new Map<string, UrgentBloodInventory[]>();
  for (const record of input.inventory) {
    if (details.bloodGroup && record.bloodGroup !== details.bloodGroup) continue;
    if (details.component && record.component !== details.component) continue;
    const entries = inventoryByFacility.get(record.institutionId) ?? [];
    entries.push(record);
    inventoryByFacility.set(record.institutionId, entries);
  }

  const facilities = input.facilities.filter((facility) => Boolean(input.coordinates || details.location || inventoryByFacility.has(facility.id))).map((facility) => {
    const records = (inventoryByFacility.get(facility.id) ?? []).sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());
    const fresh = records.filter((record) => now - record.lastUpdated.getTime() <= 24 * 60 * 60 * 1000);
    const distanceKm = input.coordinates && facility.latitude !== null && facility.longitude !== null
      ? Math.round(calculateDistance(input.coordinates.latitude, input.coordinates.longitude, facility.latitude, facility.longitude) * 10) / 10
      : undefined;
    return { facility, records, fresh, distanceKm };
  }).filter((item) => !input.coordinates || item.distanceKm === undefined || item.distanceKm <= 25)
    .sort((a, b) => Number(b.fresh.length > 0) - Number(a.fresh.length > 0) ||
      (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY))
    .slice(0, 6);

  const lines: string[] = [
    "I’m sorry this is urgent. If someone may be in immediate danger, contact local emergency services and the treating hospital team now; don’t wait for this chat. I can’t guarantee availability or fulfil a request.",
  ];
  if (facilities.some((item) => item.fresh.length > 0)) {
    const inventoryHeading = details.component
      ? "Recent matching inventory records"
      : "Recent records for the requested blood group (component is not yet confirmed)";
    lines.push(`**${inventoryHeading} (updated within 24 hours; confirm directly before travelling):**`);
    for (const item of facilities.filter((facility) => facility.fresh.length > 0)) {
      const record = item.fresh[0];
      const quantityNote = details.units
        ? record.unitsAvailable >= details.units ? ` (record shows at least ${details.units} requested unit(s))` : ` (below the ${details.units} requested unit(s))`
        : "";
      lines.push(`- **${item.facility.name}** — ${item.facility.address}${item.distanceKm !== undefined ? ` · ${item.distanceKm} km` : " · distance not verified"}; ${record.unitsAvailable} unit(s) recorded for ${displayBloodGroup(record.bloodGroup)} ${record.component.replaceAll("_", " ").toLowerCase()}${quantityNote}; updated ${record.lastUpdated.toISOString()}${item.facility.contactNumber ? `; contact ${item.facility.contactNumber}` : ""}.`);
    }
  }

  const unverified = facilities.filter((item) => item.fresh.length === 0);
  if (unverified.length) {
    lines.push("**Registered facilities; matching stock is unknown or unverified:**");
    for (const item of unverified) {
      const stale = item.records[0];
      lines.push(`- **${item.facility.name}** — ${item.facility.address}${item.distanceKm !== undefined ? ` · ${item.distanceKm} km` : " · distance not verified"}${item.facility.contactNumber ? `; contact ${item.facility.contactNumber}` : ""}${stale ? `; last matching record updated ${stale.lastUpdated.toISOString()} (too old to confirm)` : "; no current matching inventory record"}.`);
    }
  }
  if (!facilities.length) {
    lines.push(input.facilityLookupAvailable === false
      ? "I couldn’t retrieve registered facility contacts right now, so I can’t verify nearby options.":
        "I couldn’t find a registered facility record to confirm as nearby. Use the facility map or contact the treating hospital directly.");
  }
  if (details.location && !input.coordinates) {
    lines.push(`I couldn't verify the location “${details.location.replace(/,\s*India$/i, "") }” on the map. The facility records above are not ranked as nearby; please share a clearer locality or landmark.`);
  } else if (!details.location) {
    lines.push("I don’t have a locality to rank nearby facilities yet. The inventory results above, if any, are not proximity-ranked.");
  }
  if (input.inventoryAvailable === false) {
    lines.push("Live inventory could not be checked; stock status is unknown, not proof that no blood is available.");
  }

  const missing: string[] = [];
  if (!details.bloodGroup) missing.push("blood group");
  if (!details.location) missing.push("city/locality or landmark");
  if (!details.component) missing.push("component specified by the care team");
  if (!details.units) missing.push("number of units specified by the care team");
  let handoff: LiveOutcome["handoff"];
  if (!missing.length && input.actorCanCreateRequest) {
    lines.push(`Request details noted: ${displayBloodGroup(details.bloodGroup!)} ${details.component!.replaceAll("_", " ").toLowerCase()}, ${details.units} unit(s), ${details.location!.replace(/,\s*India$/i, "")}. Enter these in the authenticated form along with the required contact number; set priority to Urgent as appropriate. Emergency broadcast is a separate option. Nothing has been created by this chat.`);
    handoff = { label: "Open blood request form", href: "/requests", reason: "Enter and review the details in the authenticated form, provide the required contact number, and set priority to Urgent as appropriate. Emergency broadcast is a separate option. This assistant has not submitted a request." };
  } else if (missing.length) {
    const ask = missing.length >= 2 && (!details.bloodGroup || !details.location)
      ? missing.slice(0, 2)
      : missing.slice(0, 2);
    lines.push(`To narrow this down, what ${ask.join(" and ")} should I use? Follow the treating team’s instructions for the blood group, component, and units.`);
    handoff = { label: "Open Facility Map", href: "/map", reason: "Review registered facility locations while we narrow down the request details." };
  } else {
    lines.push("This account cannot create blood requests. Please ask an authorized hospital or blood-bank account to submit through its workflow.");
  }
  return {
    answer: lines.join("\n\n"), intent: "LIVE_INVENTORY",
    liveDataUsed: input.facilityLookupAvailable !== false || input.inventoryAvailable !== false,
    needsClarification: missing.length > 0,
    handoff: handoff ?? { label: "Open Facility Map", href: "/map", reason: "Review registered facilities and contact the care team directly." },
    data: { resultCount: facilities.length, confirmedInventoryCount: facilities.filter((item) => item.fresh.length > 0).length, inventoryUnknownCount: unverified.length },
  };
}
function parseComponent(query: string): BloodComponent | undefined {
  if (/\b(whole blood)\b/i.test(query)) return BloodComponent.WHOLE_BLOOD;
  if (/\b(red blood cells?|rbc|packed cells?)\b/i.test(query)) return BloodComponent.RED_BLOOD_CELLS;
  if (/\b(plasma)\b/i.test(query)) return BloodComponent.PLASMA;
  if (/\b(platelets?)\b/i.test(query)) return BloodComponent.PLATELETS;
  if (/\b(cryoprecipitate|cryo)\b/i.test(query)) return BloodComponent.CRYOPRECIPITATE;
  return undefined;
}

function displayBloodGroup(group: string) {
  return group.replace("_POSITIVE", "+").replace("_NEGATIVE", "-").replaceAll("_", " ");
}

async function findRequestStatus(query: string, actor: AuthContext): Promise<LiveOutcome> {
  const id = query.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i)?.[0];
  if (id) {
    const record = await database.request.findUnique({
      where: { id },
      select: {
        id: true, requestType: true, status: true, priority: true, requestDate: true,
        location: true, createdById: true, createdByInstitutionId: true,
        recipients: { select: { userId: true } },
        matches: { select: {
          status: true, providerInstitutionId: true, reservationExpiresAt: true,
          providerInstitution: { select: { name: true } },
        } },
      },
    });
    if (record) {
      const permitted = actor.role === "ADMINISTRATOR" ||
        (actor.principalType === "USER" && (
          record.createdById === actor.userId ||
          record.recipients.some((recipient) => recipient.userId === actor.userId)
        )) ||
        (actor.principalType === "INSTITUTION" && (
          record.createdByInstitutionId === actor.institutionId ||
          record.matches.some((match) => match.providerInstitutionId === actor.institutionId)
        ));
      if (!permitted) {
        return {
          answer: "I couldn't retrieve that record in your current access scope. Please open the Requests page and select a request you are authorized to view.",
          intent: "REQUEST_STATUS",
          liveDataUsed: false,
          handoff: { label: "Open Requests", href: "/requests", reason: "Request details are protected and must be viewed through the authenticated workflow." },
        };
      }
      const label = record.requestType === RequestType.BLOOD ? "blood request" : "organ-related request";
      const lines = [
        `I checked the current LifeLink record for your ${label}.`,
        `**Status:** ${record.status.replaceAll("_", " ")}.`,
        `**Priority:** ${record.priority}.`,
        `**Created:** ${record.requestDate.toISOString()}.`,
      ];
      if (record.matches.length) {
        const offers = record.matches.slice(0, 5).map((match) =>
          `${match.providerInstitution?.name ?? "Participating institution"} — ${match.status.replaceAll("_", " ")}`,
        );
        lines.push(`**Recorded offers/matches:** ${offers.join("; ")}.`);
      }
      lines.push("This is the status currently recorded by LifeLink; it does not guarantee fulfilment or clinical suitability.");
      return {
        answer: lines.join("\n\n"),
        intent: "REQUEST_STATUS",
        liveDataUsed: true,
        data: { recordType: label, status: record.status, requestDate: record.requestDate.toISOString() },
        handoff: { label: "Open Requests", href: "/requests", reason: "Open the record for its full, role-authorized details." },
      };
    }

    const organRecipient = await database.organRecipient.findUnique({
      where: { id },
      select: { id: true, reference: true, status: true, organType: true, priority: true, createdAt: true, userId: true, institutionId: true },
    });
    if (organRecipient) {
      const permitted = actor.role === "ADMINISTRATOR" ||
        (actor.principalType === "USER" && organRecipient.userId === actor.userId) ||
        (actor.principalType === "INSTITUTION" && organRecipient.institutionId === actor.institutionId);
      if (permitted) {
        return {
          answer: `I checked the current LifeLink recipient record **${organRecipient.reference}**. Its recorded status is **${organRecipient.status.replaceAll("_", " ")}**. Organ matching and allocation remain subject to authorized professional review; this status is not a clinical decision.`,
          intent: "REQUEST_STATUS",
          liveDataUsed: true,
          data: { recordType: "organ recipient requirement", status: organRecipient.status },
          handoff: { label: "Open Organ Services", href: actor.principalType === "INSTITUTION" ? "/organ-centre/recipients" : "/organ-services", reason: "Open the authorized recipient workflow for full details." },
        };
      }
    }

    return {
      answer: "I couldn't find a request record that is available in your current access scope. Check the reference and try again, or open Requests to select one of your records.",
      intent: "REQUEST_STATUS",
      liveDataUsed: false,
      handoff: { label: "Open Requests", href: "/requests", reason: "Select a request you are authorized to view." },
    };
  }

  if (actor.role === "ADMINISTRATOR") {
    return {
      answer: "Please provide the LifeLink request or recipient reference you want to check. I won't choose an arbitrary record from the system.",
      intent: "REQUEST_STATUS",
      liveDataUsed: false,
      needsClarification: true,
    };
  }

  const where = actor.principalType === "USER"
    ? { OR: [{ createdById: actor.userId }, { recipients: { some: { userId: actor.userId } } }] }
    : { OR: [{ createdByInstitutionId: actor.institutionId }, { matches: { some: { providerInstitutionId: actor.institutionId } } }] };
  const requests = await database.request.findMany({
    where,
    select: { id: true, requestType: true, status: true, priority: true, requestDate: true },
    orderBy: { requestDate: "desc" },
    take: 5,
  });
  if (!requests.length) {
    return {
      answer: "I couldn't find a recent request associated with this account. Open Requests to start or select a workflow, or share the request reference if you have it.",
      intent: "REQUEST_STATUS",
      liveDataUsed: true,
      handoff: { label: "Open Requests", href: "/requests", reason: "View or start an authorized request workflow." },
    };
  }
  const list = requests.map((item) =>
    `- ${item.requestType === RequestType.BLOOD ? "Blood request" : "Organ request"} ending **${item.id.slice(0, 8)}** — **${item.status.replaceAll("_", " ")}**, ${item.priority.toLowerCase()}, created ${item.requestDate.toISOString()}`,
  );
  return {
    answer: `Here are the latest requests visible to this account:\n\n${list.join("\n")}\n\nThese statuses come from LifeLink's operational database. Open a record in Requests for the full authorized details.`,
    intent: "REQUEST_STATUS",
    liveDataUsed: true,
    handoff: { label: "Open Requests", href: "/requests", reason: "View the full status and eligible next steps." },
  };
}

async function searchLiveInventory(query: string): Promise<LiveOutcome> {
  const bloodGroup = parseBloodGroup(query);
  if (!bloodGroup) {
    return {
      answer: "Which blood group should I look for (for example, O+, A−, or AB+)? You can also mention a component such as red blood cells, plasma, or platelets, and your city/locality if you want nearby results.",
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "You can also search using the structured inventory filters." },
    };
  }

  const location = extractLocationQuery(query);
  const nearby = /\b(nearby|nearest|closest|around me|near me|within)\b/i.test(query);
  let coords: Coordinates = null;
  if (location) coords = await geocodeLocation(location);
  if (location && !coords) {
    return {
      answer: `I couldn't reliably resolve **${location.replace(/,\s*India$/i, "")}** to a map location, so I won't label facilities as nearby. Please provide a more specific locality and city, or use the map page.`,
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "Use the map to choose a location." },
    };
  }
  if (nearby && !location) {
    return {
      answer: "What city or locality should I search around? I don't assume or access a device location automatically.",
      intent: "LIVE_INVENTORY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Choose a location and search radius in the structured form." },
    };
  }

  const component = parseComponent(query);
  const records = await database.bloodInventory.findMany({
    where: {
      bloodGroup,
      ...(component ? { component } : {}),
      status: BloodInventoryStatus.AVAILABLE,
      unitsAvailable: { gt: 0 },
      OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
      institution: {
        status: InstitutionStatus.ACTIVE,
        deletedAt: null,
        OR: [
          { type: InstitutionType.BLOOD_BANK },
          { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } },
        ],
      },
    },
    select: {
      id: true, bloodGroup: true, component: true, unitsAvailable: true, reservedUnits: true,
      lastUpdated: true, expiryDate: true,
      institution: { select: { id: true, name: true, type: true, address: true, latitude: true, longitude: true, contactNumber: true } },
    },
    orderBy: { lastUpdated: "desc" },
    take: 100,
  });

  const radius = radiusFromQuery(query, nearby || Boolean(coords));
  const now = Date.now();
  const candidates = records.flatMap((record) => {
    let distanceKm: number | undefined;
    if (coords && record.institution.latitude !== null && record.institution.longitude !== null) {
      distanceKm = calculateDistance(coords.latitude, coords.longitude, record.institution.latitude, record.institution.longitude);
    }
    if (coords && radius !== undefined && (distanceKm === undefined || distanceKm > radius)) return [];
    const ageMinutes = (now - record.lastUpdated.getTime()) / 60_000;
    return [{
      group: displayBloodGroup(record.bloodGroup),
      component: record.component.replaceAll("_", " "),
      unitsAvailable: record.unitsAvailable,
      institution: record.institution.name,
      address: record.institution.address,
      contactNumber: record.institution.contactNumber,
      distanceKm: distanceKm === undefined ? null : Math.round(distanceKm * 10) / 10,
      lastUpdated: record.lastUpdated.toISOString(),
      stale: ageMinutes > 24 * 60,
      expiryDate: record.expiryDate?.toISOString() ?? null,
    }];
  }).sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity) || b.unitsAvailable - a.unitsAvailable).slice(0, 8);

  if (!candidates.length) {
    return {
      answer: `I couldn't find an active, non-expired LifeLink inventory record for **${displayBloodGroup(bloodGroup)}**${component ? ` (${component.replaceAll("_", " ").toLowerCase()})` : ""}${coords && radius !== undefined ? ` within ${radius} km of ${coords.displayName ?? location}` : ""}. This means no matching record was found in the current LifeLink data; it does not prove that no blood is available elsewhere. Please confirm with a participating facility or use Inventory Search.`,
      intent: "LIVE_INVENTORY",
      liveDataUsed: true,
      data: { resultCount: 0, searchedGroup: bloodGroup, component: component ?? null, radiusKm: radius ?? null },
      handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Run a structured search and confirm the result with the institution." },
    };
  }

  const lines = candidates.map((item, index) => {
    const details = [
      `${index + 1}. **${item.institution}**`,
      `${item.address}`,
      `**${item.unitsAvailable}** unit(s) recorded for ${item.group} ${item.component}.`,
      item.distanceKm !== null ? `Approx. ${item.distanceKm} km away.` : "",
      item.contactNumber ? `Facility contact: ${item.contactNumber}.` : "",
      `Inventory last updated: ${item.lastUpdated}.`,
      item.stale ? "⚠️ This record has not been updated in the last 24 hours; confirm directly with the facility." : "",
      item.expiryDate ? `Recorded expiry date: ${item.expiryDate}.` : "",
    ].filter(Boolean);
    return details.join("\n");
  });
  const scopeLine = coords && radius !== undefined
    ? `I checked active LifeLink blood-bank/hospital inventory within ${radius} km of ${coords.displayName ?? location}.`
    : "I checked the current inventory records at participating LifeLink facilities; because no search location was provided, these results are not ranked by proximity.";
  return {
    answer: `${scopeLine}\n\n${lines.join("\n\n")}\n\nThese are current database records, not a guarantee of availability. Please contact the facility to confirm before travelling or making care decisions.`,
    intent: "LIVE_INVENTORY",
    liveDataUsed: true,
    data: { resultCount: candidates.length, searchedGroup: bloodGroup, component: component ?? null, radiusKm: radius ?? null, candidates },
    handoff: { label: "Open Inventory Search", href: "/inventory", reason: "Use the structured search to refine the request and view the full current records." },
  };
}

async function discoverLiveFacilities(query: string): Promise<LiveOutcome> {
  const location = extractLocationQuery(query);
  if (!location) {
    return {
      answer: "I can look for nearby healthcare facilities. If location access is available, nearby options will appear here; otherwise, use the current-location action or search by city or locality. I won't invent a facility or claim it is nearby without a usable location.",
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "The map lets you choose a location and facility type." },
    };
  }
  const coords = await geocodeLocation(location);
  if (!coords) {
    return {
      answer: `I couldn't resolve **${location.replace(/,\s*India$/i, "")}** to reliable coordinates. Please provide a more specific locality and city, or use the map page. I won't recommend a facility as nearby without usable location information.`,
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: false,
      needsClarification: true,
      handoff: { label: "Open Map", href: "/map", reason: "Choose a location for facility discovery." },
    };
  }

  const wantsOrgan = /\b(organ|transplant|organ centre|organ center)\b/i.test(query);
  const wantsBlood = /\b(blood|donat(?:e|ion)|blood bank|blood centre|blood center|camp)\b/i.test(query);
  const typeFilter = wantsOrgan
    ? [{ type: InstitutionType.ORGAN_CENTRE }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { organService: { isNot: null } } } }]
    : wantsBlood
      ? [{ type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } }]
      : [{ type: InstitutionType.HOSPITAL }, { type: InstitutionType.BLOOD_BANK }, { type: InstitutionType.ORGAN_CENTRE }];

  const institutions = await database.institution.findMany({
    where: { status: InstitutionStatus.ACTIVE, deletedAt: null, OR: typeFilter },
    select: {
      id: true, name: true, type: true, address: true, contactNumber: true,
      latitude: true, longitude: true, updatedAt: true,
    },
    take: 500,
  });
  const radius = radiusFromQuery(query, true) ?? 25;
  const candidates = institutions.flatMap((institution) => {
    if (institution.latitude === null || institution.longitude === null) return [];
    const distanceKm = calculateDistance(coords.latitude, coords.longitude, institution.latitude, institution.longitude);
    if (distanceKm > radius) return [];
    return [{
      name: institution.name,
      type: institution.type.replaceAll("_", " "),
      address: institution.address,
      contactNumber: institution.contactNumber,
      distanceKm: Math.round(distanceKm * 10) / 10,
      updatedAt: institution.updatedAt.toISOString(),
    }];
  }).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 8);

  const missingCoordinates = institutions.some((institution) => institution.latitude === null || institution.longitude === null);
  const asksCamp = /\b(camp|camps|upcoming)\b/i.test(query);
  if (!candidates.length) {
    return {
      answer: `I couldn't find a registered, active ${wantsOrgan ? "organ-service" : wantsBlood ? "blood-service" : "healthcare"} facility with usable coordinates within ${radius} km of ${coords.displayName ?? location}. ${missingCoordinates ? "Some registered institutions do not have coordinates, so they could not be confirmed as nearby. " : ""}Try the map page or ask an administrator to update facility location data.`,
      intent: "FACILITY_DISCOVERY",
      liveDataUsed: true,
      data: { resultCount: 0, radiusKm: radius, location: coords.displayName ?? location },
      handoff: { label: "Open Map", href: "/map", reason: "View registered facilities and refine the location search." },
    };
  }

  const lines = candidates.map((item, index) => [
    `${index + 1}. **${item.name}** (${item.type})`,
    item.address,
    `Approx. ${item.distanceKm} km away.`,
    item.contactNumber ? `Facility contact: ${item.contactNumber}.` : "",
    `Profile last updated: ${item.updatedAt}.`,
  ].filter(Boolean).join("\n"));
  const campNote = asksCamp
    ? "\n\nLifeLink's current data model does not include a scheduled blood-donation-camp calendar, so I can identify registered facilities but cannot confirm upcoming camp dates."
    : "";
  return {
    answer: `I checked registered, active LifeLink facilities within ${radius} km of ${coords.displayName ?? location}:\n\n${lines.join("\n\n")}${missingCoordinates ? "\n\nSome other registered facilities lack coordinates and could not be ranked by distance." : ""}${campNote}\n\nThese are facility records, not a guarantee of current services or donation availability. Contact the facility to confirm before travelling.`,
    intent: "FACILITY_DISCOVERY",
    liveDataUsed: true,
    data: { resultCount: candidates.length, radiusKm: radius, location: coords.displayName ?? location, facilities: candidates, scheduledCampsAvailable: false },
    handoff: { label: "Open Map", href: "/map", reason: "View locations and continue facility discovery." },
  };
}

export async function fetchLiveContext(query: string, actor: AuthContext, intent: QueryIntent): Promise<LiveOutcome | null> {
  try {
    if (intent === "REQUEST_STATUS") return await findRequestStatus(query, actor);
    if (intent === "LIVE_INVENTORY") return await searchLiveInventory(query);
    if (intent === "FACILITY_DISCOVERY") return await discoverLiveFacilities(query);
    return null;
  } catch (error) {
    // External geocoding and live data dependencies fail closed. Never fall back to invented results.
    if (error instanceof ApiError) throw error;
    console.error("LifeLink assistant live-data lookup failed", error instanceof Error ? error.name : "UnknownError");
    return {
      answer: "I couldn't access the live LifeLink data needed for that request right now. No live result has been confirmed. Please use the relevant LifeLink page and try again shortly.",
      intent,
      liveDataUsed: false,
      handoff: intent === "REQUEST_STATUS"
        ? { label: "Open Requests", href: "/requests", reason: "Check your authorized request records." }
        : intent === "LIVE_INVENTORY"
          ? { label: "Open Inventory Search", href: "/inventory", reason: "Search through the authenticated inventory workflow." }
          : { label: "Open Map", href: "/map", reason: "Search registered facilities through the map." },
    };
  }
}

export async function fetchUrgentBloodContext(
  message: string,
  history: Array<{ role: "user" | "assistant"; content: string }>,
  actor: AuthContext,
): Promise<LiveOutcome> {
  const details = extractUrgentBloodDetails(message, history);
  const coordinates = details.location ? await geocodeLocation(details.location) : null;
  const facilityTypes = [
    { type: InstitutionType.BLOOD_BANK },
    { type: InstitutionType.HOSPITAL, hospitalProfile: { is: { bloodService: { isNot: null } } } },
  ];
  const facilitiesQuery = database.institution.findMany({
    where: { status: InstitutionStatus.ACTIVE, deletedAt: null, OR: facilityTypes },
    select: { id: true, name: true, address: true, contactNumber: true, latitude: true, longitude: true },
    take: 500,
  });
  const inventoryQuery = details.bloodGroup
    ? database.bloodInventory.findMany({
      where: {
        bloodGroup: details.bloodGroup,
        ...(details.component ? { component: details.component } : {}),
        status: BloodInventoryStatus.AVAILABLE,
        unitsAvailable: { gt: 0 },
        OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }],
        institution: { status: InstitutionStatus.ACTIVE, deletedAt: null, OR: facilityTypes },
      },
      select: {
        institutionId: true, bloodGroup: true, component: true, unitsAvailable: true, lastUpdated: true,
        institution: { select: { id: true, name: true, address: true, contactNumber: true, latitude: true, longitude: true } },
      },
      orderBy: { lastUpdated: "desc" },
      take: 500,
    })
    : Promise.resolve([]);

  const [facilityResult, inventoryResult] = await Promise.allSettled([facilitiesQuery, inventoryQuery]);
  const facilities: UrgentBloodFacility[] = facilityResult.status === "fulfilled"
    ? facilityResult.value
    : [];
  const inventory: UrgentBloodInventory[] = inventoryResult.status === "fulfilled"
    ? inventoryResult.value
    : [];
  const inventoryFacilities: UrgentBloodFacility[] = inventoryResult.status === "fulfilled"
    ? inventoryResult.value.map((record) => ({
      id: record.institution.id, name: record.institution.name, address: record.institution.address,
      contactNumber: record.institution.contactNumber, latitude: record.institution.latitude, longitude: record.institution.longitude,
    }))
    : [];
  const combinedFacilities = [...new Map([...facilities, ...inventoryFacilities].map((facility) => [facility.id, facility])).values()];
  return formatUrgentBloodAssistance({
    details, facilities: combinedFacilities, inventory, coordinates,
    facilityLookupAvailable: facilityResult.status === "fulfilled" || inventoryFacilities.length > 0,
    inventoryAvailable: inventoryResult.status === "fulfilled",
    actorCanCreateRequest: ["USER", "ADMINISTRATOR", "HOSPITAL_USER"].includes(actor.role),
  });
}
