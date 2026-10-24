# Assistant facility discovery

The assistant's facility search combines active, non-deleted LifeLink institutions with nearby public OpenStreetMap listings. LifeLink rows are marked `REGISTERED_ACTIVE`; external places are marked `EXTERNAL_LISTING`. External records are returned to the browser only and are never written to the database or included in trusted inventory.

## Providers and setup

The map uses Leaflet and OpenStreetMap raster tiles. The external facility provider is the OpenStreetMap Overpass API. Public facility discovery stays disabled until `OVERPASS_API_URL` is set on the API server; there is no key and no provider secret in the browser. Set it to an Overpass instance URL, for example `https://overpass-api.de/api/interpreter`, subject to that instance's current usage policy and availability. The code applies a 14 second timeout and caches successful result sets briefly. Public instances are best effort and intended for modest use; use a managed or self-hosted instance for sustained production traffic. See [Overpass API public-instance guidance](https://wiki.openstreetmap.org/wiki/Overpass_API) before selecting an endpoint.

Location text is resolved through the existing Nominatim geocoder, which already uses `GEOCODING_ENDPOINT` and `GEOCODING_USER_AGENT`, serializes requests, and caches results. Keep the user agent descriptive and follow the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/), including its application-wide request limits. The browser reads permission state where supported and requests fresh GPS coordinates only for a user-initiated location search, or for a relevant newly received facility need when permission is already granted. It does not repeatedly prompt after denial or track in the background. Current coordinates are sent to LifeLink for that search and are not kept in browser storage; conversation results round saved search centers to three decimal places.

Set this API-server value to enable public external facility discovery:

```text
OVERPASS_API_URL=https://overpass-api.de/api/interpreter
```

Optional:

```text
GEOCODING_ENDPOINT=https://nominatim.openstreetmap.org/search
GEOCODING_USER_AGENT=LifeLinkPlatform/1.0 (operator contact email)
```

`GEOCODING_USER_AGENT` has a code default for development; configure a descriptive operator contact value before deployment and follow the geocoder policy.

No external account or API key is required for these OSM services. OSM data is provided under ODbL and tiles require visible attribution and compliance with the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). The current Overpass response usually has no photo; opening hours and contact fields are often absent and missing values are left blank. Search results are listings, not proof of licensing, transplant registration, or service availability. Organ searches show active LifeLink organ facilities and OSM-tagged transplant listings separately.

## API and trust boundaries

`GET /api/rag/facilities` requires a LifeLink session. It accepts a locality or a coordinate pair, category, radius, and optional blood group. Categories distinguish hospitals, emergency-support hospitals, clinics/doctors, combined clinic-and-hospital care, pharmacies, blood banks, organ services, other healthcare facilities, and all. The combined care category is used for routine doctor searches and returns clinics plus hospitals. External OSM tags are classified by their actual `amenity` and `healthcare` tags; unknown healthcare categories remain `OTHER_HEALTHCARE_FACILITY`. Results include a straight-line distance, source and verification label, safe public contact fields, source object link, directions link, fetch time, and internal inventory freshness. Registered emergency support is exposed separately from an OSM emergency tag; a listed/registered service is not proof that the facility is currently operating. Search never creates or modifies a request. Inventory is looked up only for active internal records. External places always return inventory status `NOT_FOUND` and cannot become stock evidence.

Routine care results rank clinics first, followed by emergency departments and hospitals; facilities of the same fit are ordered by known emergency capability when relevant, then straight-line distance, registration verification, and contact/detail completeness. Hospital and emergency searches put registered or listed emergency capability ahead of unknown capability. Travel times are not calculated or implied.

If `OVERPASS_API_URL` is unset or a provider lookup fails or is rate-limited, the endpoint can still return active LifeLink facilities and reports the external-provider limitation, including partial results. Failed geocoding is reported as location unavailable rather than provider failure; a successful search with zero results is distinct from both. Facilities without coordinates are omitted from proximity results rather than labeled nearby. The UI identifies missing or stale inventory and distinguishes OSM listings from active LifeLink institutions. Photos are not sourced by the current provider and are not fabricated.
# Runtime configuration and current behavior

The API intentionally returns `NOT_CONFIGURED` when `OVERPASS_API_URL` is absent. The local project root `.env` now contains the documented public Overpass interpreter endpoint; restart the API process after changing it. This setting is not proof that the upstream is reachable. The API has a 14-second timeout, preserves LifeLink records if the external provider fails, and caches results briefly. OpenStreetMap data is a public listing and does not verify service availability.

The assistant reads browser geolocation permission state when the Permissions API is available. It only requests fresh coordinates when the user invokes location search or when a newly received urgent-care/facility result can use a permission that is already `granted`. It does not continuously track location. Device coordinates are used in the current UI response only; conversation storage rounds the search center to three decimal places. A locality query remains available as a manual fallback.

Facility results show the list before the interactive map. Selecting a list item focuses its map marker; selecting a marker selects the corresponding result. For emergency searches, hospitals and emergency departments are included, with registered or listed emergency capability sorted ahead of unknown capability. The public provider has not been live-verified from this development environment.
