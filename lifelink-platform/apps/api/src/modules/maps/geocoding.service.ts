import { saveInstitution } from "@lifelink/database";

type InstitutionLocation = {
	id: string;
	name: string;
	address: string;
	latitude: number | null;
	longitude: number | null;
};

type Coordinates = { latitude: number; longitude: number } | null;

// Nominatim is queried serially and successful results are persisted in the institution row.
const requestIntervalMs = 1_100;
const geocodeCache = new Map<string, Coordinates>();
const negativeCacheUntil = new Map<string, number>();
const inFlight = new Map<string, Promise<Coordinates>>();
let queue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;
const negativeCacheTtlMs = 5 * 60 * 1_000;

function cacheKey(institution: Pick<InstitutionLocation, "name" | "address">) {
	return `${institution.name.trim()}, ${institution.address.trim()}, India`.toLocaleLowerCase();
}

const genericAddressWords = new Set(["near", "nearby", "opposite", "front", "behind", "next", "beside", "road", "roads", "rd", "street", "st", "marg", "main", "india", "sector", "phase"]);

function addressTokens(address: string) {
	return address.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !genericAddressWords.has(token) && !/^\d+$/.test(token));
}

async function lookupAddress(query: string, requiredTokens: string[]): Promise<Coordinates> {
	const task = queue.then(async () => {
		const delay = Math.max(0, nextRequestAt - Date.now());
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		nextRequestAt = Date.now() + requestIntervalMs;

		const endpoint = (process.env.GEOCODING_ENDPOINT || "https://nominatim.openstreetmap.org/search").replace(/\/$/, "");
		const url = new URL(endpoint);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "jsonv2");
		url.searchParams.set("limit", "1");
		url.searchParams.set("countrycodes", "in");
		const response = await fetch(url, {
			headers: { "User-Agent": process.env.GEOCODING_USER_AGENT || "LifeLinkPlatform/1.0 (institution map)" },
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) return null;
		const results = await response.json() as Array<{ lat?: string; lon?: string; display_name?: string; type?: string; addresstype?: string }>;
		const result = results[0];
		if (!result || result.addresstype === "country" || result.type === "country") return null;
		const displayName = result.display_name?.toLocaleLowerCase() ?? "";
		if (!requiredTokens.some((token) => displayName.includes(token))) return null;
		const latitude = Number(result.lat);
		const longitude = Number(result.lon);
		return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
			? { latitude, longitude }
			: null;
	});
	queue = task.then(() => undefined, () => undefined);
	return task;
}

function getAddressQueries(institution: Pick<InstitutionLocation, "name" | "address">) {
	const normalized = institution.address.toLocaleLowerCase();
	const queries = [`${institution.name.trim()}, ${institution.address.trim()}, India`];
	const cleanedAddress = institution.address
		.replace(/,?\s*\bIndia\b\s*$/i, "")
		.replace(/\b(near|nearby|close to|opposite|in front of|behind|next to|beside)\b/gi, " ")
		.replace(/[;,]+/g, ", ")
		.replace(/\s+/g, " ")
		.replace(/,\s*,/g, ",")
		.trim()
		.replace(/^[,\s]+|[,\s]+$/g, "");
	if (cleanedAddress && cleanedAddress.toLocaleLowerCase() !== normalized.trim()) {
		queries.push(`${institution.name.trim()}, ${cleanedAddress}, India`);
	}
	if (cleanedAddress) {
		const addressParts = cleanedAddress.split(",").map((part) => part.trim()).filter(Boolean);
		if (addressParts.length > 0) queries.push(`${addressParts.slice(-Math.min(4, addressParts.length)).join(", ")}, India`);
	}
	// Bhawarkua/Bhawarkuan is a well-known locality in Indore, but short addresses often omit the city.
	if (/\bbhawarkua?n\b/.test(normalized) || /\bbhanwarkua?n\b/.test(normalized)) {
		queries.push(`${institution.name.trim()}, Indore, India`);
	}
	return [...new Set(queries)];
}

export async function ensureInstitutionCoordinates<T extends InstitutionLocation>(institution: T): Promise<T> {
	if (institution.latitude !== null && institution.longitude !== null || !institution.address.trim()) return institution;

	const key = cacheKey(institution);
	let lookup = inFlight.get(key);
	if (!lookup) {
		lookup = (async () => {
			if (geocodeCache.has(key)) return geocodeCache.get(key)!;
			const retryAt = negativeCacheUntil.get(key);
			if (retryAt && retryAt > Date.now()) return null;
			negativeCacheUntil.delete(key);
			try {
				let coordinates: Coordinates = null;
				const requiredTokens = addressTokens(institution.address);
				for (const query of getAddressQueries(institution)) {
					coordinates = await lookupAddress(query, requiredTokens);
					if (coordinates) break;
				}
				if (coordinates) geocodeCache.set(key, coordinates);
				else negativeCacheUntil.set(key, Date.now() + negativeCacheTtlMs);
				return coordinates;
			} finally {
				inFlight.delete(key);
			}
		})();
		inFlight.set(key, lookup);
	}

	try {
		const coordinates = await lookup;
		if (!coordinates) return institution;
		await saveInstitution(institution.id, coordinates);
		return { ...institution, ...coordinates };
	} catch (error) {
		// A provider/network failure must not prevent registration or institution discovery.
		console.warn("Institution address geocoding failed", institution.id, error instanceof Error ? error.message : "Unknown geocoder error");
		return institution;
	}
}
