"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronDown, Clock, Droplet, ExternalLink, Globe2, HeartPulse, Hospital, List, Map as MapIcon, Maximize2, Minimize2, Navigation, Phone, Pill, RotateCcw, ShieldCheck, Siren, Stethoscope } from "lucide-react";
import { directionsLinks, safePhoneHref } from "../map/map-presentation";
import type { DiscoveredFacility, FacilitySearchResult } from "./conversation-types";
import {
  NO_FILTERS, applyFacilityView, availableFilters, facilityResultsHeading, facilityTypeLabel, formatDistance,
  safeFacilityPhoto, safeOpenStreetMapUrl, safeWebsite, uniqueFacilities, type FacilityFilters, type FacilitySort,
} from "./facility-presentation";

const FacilityMap = dynamic(() => import("../map/leaflet-map"), { ssr: false, loading: () => <div className="ll-map-loading" role="status">Loading map…</div> });

function TypeIcon({ type, size = 18 }: { type: string; size?: number }) {
  if (type === "PHARMACY") return <Pill size={size} aria-hidden="true" />;
  if (type === "CLINIC") return <Stethoscope size={size} aria-hidden="true" />;
  if (type === "BLOOD_BANK") return <Droplet size={size} aria-hidden="true" />;
  if (type === "ORGAN_CENTRE") return <HeartPulse size={size} aria-hidden="true" />;
  if (type === "EMERGENCY_DEPARTMENT") return <Siren size={size} aria-hidden="true" />;
  if (type === "HOSPITAL") return <Hospital size={size} aria-hidden="true" />;
  return <Building2 size={size} aria-hidden="true" />;
}

const PROVIDER_NOTES: Record<string, string> = {
  NOT_CONFIGURED: "Public map listings aren't configured on this server, so only LifeLink-registered facilities can appear.",
  LOCATION_UNAVAILABLE: "A reliable search location wasn't available, so nearby places couldn't be found. Use your location or type an area.",
  RATE_LIMITED: "The public map service is busy right now. This doesn't mean nothing is nearby; try again in a minute.",
  LOOKUP_FAILED: "The public map service didn't respond. This doesn't mean nothing is nearby; try again shortly.",
};

export function FacilityResults({ result, messageId, onRefresh, refreshing }: { result: FacilitySearchResult; messageId: string; onRefresh: (result: FacilitySearchResult) => void; refreshing: boolean }) {
  const facilities = useMemo(() => uniqueFacilities(result.facilities), [result.facilities]);
  const [selectedId, setSelectedId] = useState<string | null>(result.selectedId ?? null);
  const [expandedId, setExpandedId] = useState<string | null>(result.selectedId ?? null);
  const [sort, setSort] = useState<FacilitySort>("recommended");
  const [filters, setFilters] = useState<FacilityFilters>(NO_FILTERS);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const [largeMap, setLargeMap] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const options = useMemo(() => availableFilters(facilities), [facilities]);
  const visible = useMemo(() => applyFacilityView(facilities, sort, filters), [facilities, sort, filters]);
  const hasMap = Boolean(result.center) || facilities.some((facility) => facility.latitude !== null && facility.longitude !== null);
  const markers = useMemo(() => visible.map((facility) => ({
    id: facility.id, name: facility.name, type: facility.type, address: facility.address,
    latitude: facility.latitude, longitude: facility.longitude, distanceKm: facility.distanceKm ?? undefined, phone: facility.phone,
  })), [visible]);
  const heading = facilityResultsHeading({ category: result.category, title: result.title, searchLocationType: result.searchLocationType, area: result.center?.displayName ?? null });
  const registered = facilities.filter((facility) => facility.source === "LIFELINK").length;

  // A marker click brings its card into view inside the list only. scrollIntoView is avoided because it
  // also scrolls clipped ancestors and would push the chat header out of view.
  useEffect(() => {
    const list = listRef.current;
    if (!selectedId || !list || list.scrollHeight <= list.clientHeight + 1) return;
    const card = list.querySelector<HTMLElement>(`[data-facility-id="${CSS.escape(selectedId)}"]`);
    if (!card) return;
    const top = card.offsetTop, bottom = top + card.offsetHeight;
    if (top >= list.scrollTop && bottom <= list.scrollTop + list.clientHeight) return;
    list.scrollTo({ top: Math.max(0, top - 8), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [selectedId]);

  function select(id: string, showOnMap = false) {
    setSelectedId(id);
    if (showOnMap) setMobileView("map");
  }

  return <section className={`ll-facilities${largeMap ? " is-large" : ""}`} aria-label={heading}>
    <header className="ll-facilities-head">
      <div>
        <h3>{heading}</h3>
        <p>{facilities.length ? `${facilities.length} ${facilities.length === 1 ? "place" : "places"}${registered ? ` · ${registered} LifeLink-registered` : ""}${options.distance ? " · straight-line distances" : ""}` : "No places to show"}</p>
      </div>
      <div className="ll-facilities-tools">
        {options.distance && facilities.length > 1 && <label className="ll-select"><span className="ll-sr-only">Sort facilities</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as FacilitySort)}><option value="recommended">Best match</option><option value="distance">Closest first</option></select>
          <ChevronDown size={13} aria-hidden="true" />
        </label>}
        {hasMap && facilities.length > 0 && <button type="button" className="ll-icon-button ll-desktop-only" aria-pressed={largeMap} onClick={() => setLargeMap((value) => !value)} title={largeMap ? "Compact map" : "Larger map"}>
          {largeMap ? <Minimize2 size={15} aria-hidden="true" /> : <Maximize2 size={15} aria-hidden="true" />}<span className="ll-sr-only">{largeMap ? "Compact map" : "Larger map"}</span>
        </button>}
        {!result.title && <button type="button" className="ll-icon-button" onClick={() => onRefresh(result)} disabled={refreshing} title="Search again"><RotateCcw size={15} aria-hidden="true" /><span className="ll-sr-only">Search again</span></button>}
      </div>
    </header>

    {(options.types.length > 0 || options.withPhone || options.emergencyListed || options.registeredOnly) && <div className="ll-filter-row" role="group" aria-label="Filter facilities">
      {options.types.length > 0 && <button type="button" className="ll-filter" aria-pressed={!filters.type} onClick={() => setFilters((value) => ({ ...value, type: null }))}>All types</button>}
      {options.types.map((type) => <button key={type} type="button" className="ll-filter" aria-pressed={filters.type === type} onClick={() => setFilters((value) => ({ ...value, type: value.type === type ? null : type }))}><TypeIcon type={type} size={12} />{facilityTypeLabel(type, true)}</button>)}
      {options.withPhone && <button type="button" className="ll-filter" aria-pressed={filters.withPhone} onClick={() => setFilters((value) => ({ ...value, withPhone: !value.withPhone }))}><Phone size={12} aria-hidden="true" />Has phone</button>}
      {options.emergencyListed && <button type="button" className="ll-filter" aria-pressed={filters.emergencyListed} onClick={() => setFilters((value) => ({ ...value, emergencyListed: !value.emergencyListed }))}><Siren size={12} aria-hidden="true" />Emergency listed</button>}
      {options.registeredOnly && <button type="button" className="ll-filter" aria-pressed={filters.registeredOnly} onClick={() => setFilters((value) => ({ ...value, registeredOnly: !value.registeredOnly }))}><ShieldCheck size={12} aria-hidden="true" />LifeLink registered</button>}
    </div>}

    {result.unavailableReason && PROVIDER_NOTES[result.unavailableReason] && <p className="ll-provider-note" role="status">{PROVIDER_NOTES[result.unavailableReason]}</p>}

    {!facilities.length ? <div className="ll-facilities-empty">
      <p><strong>{result.unavailableReason && result.unavailableReason !== "NOT_CONFIGURED" ? "The search couldn't be completed." : "Nothing matched within the search radius."}</strong></p>
      <p>Try a wider area, another locality, or a different type of facility.</p>
      {!result.title && <button type="button" className="ll-button" onClick={() => onRefresh(result)} disabled={refreshing}><RotateCcw size={13} aria-hidden="true" />Search again</button>}
    </div> : <>
      {hasMap && <div className="ll-view-toggle" role="tablist" aria-label="Show list or map">
        <button type="button" role="tab" aria-selected={mobileView === "list"} onClick={() => setMobileView("list")}><List size={14} aria-hidden="true" />List</button>
        <button type="button" role="tab" aria-selected={mobileView === "map"} onClick={() => setMobileView("map")}><MapIcon size={14} aria-hidden="true" />Map</button>
      </div>}
      <div className={`ll-facilities-body${hasMap ? " has-map" : ""}`} data-mobile-view={mobileView}>
        <ul className="ll-facility-list" ref={listRef}>
          {visible.map((facility, index) => <FacilityCard key={facility.id} facility={facility} position={index + 1}
            selected={selectedId === facility.id} expanded={expandedId === facility.id} hideInventory={Boolean(result.hideInventory)}
            onSelect={() => select(facility.id)} onShowOnMap={() => select(facility.id, true)}
            onToggleDetails={() => { setExpandedId((value) => value === facility.id ? null : facility.id); select(facility.id); }} />)}
          {!visible.length && <li className="ll-facilities-empty"><p>No places match these filters.</p><button type="button" className="ll-button" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button></li>}
        </ul>
        {hasMap && <div className="ll-map-pane">
          <FacilityMap key={messageId} institutions={markers} center={result.center ? [result.center.latitude, result.center.longitude] : undefined}
            selectedInstitutionId={selectedId} onSelectInstitution={(id) => select(id)}
            centerKind={result.searchLocationType === "DEVICE" ? "device" : "search"}
            centerLabel={result.searchLocationType === "DEVICE" ? "Your location (used for this search)" : "Search area"} />
        </div>}
      </div>
    </>}
    <p className="ll-attribution">Map data © OpenStreetMap contributors. Public listings are not verified by LifeLink; confirm services and hours by phone before travelling.{result.attribution && result.attribution !== "© OpenStreetMap contributors" ? ` ${result.attribution}` : ""}</p>
  </section>;
}

function FacilityCard({ facility, position, selected, expanded, hideInventory, onSelect, onShowOnMap, onToggleDetails }: {
  facility: DiscoveredFacility; position: number; selected: boolean; expanded: boolean; hideInventory: boolean;
  onSelect: () => void; onShowOnMap: () => void; onToggleDetails: () => void;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = photoFailed ? null : safeFacilityPhoto(facility.photoUrl);
  const call = safePhoneHref(facility.phone);
  const links = directionsLinks(facility.latitude, facility.longitude);
  const website = safeWebsite(facility.website);
  const source = safeOpenStreetMapUrl(facility.sourceUrl);
  const photoSource = safeWebsite(facility.photoSourceUrl);
  const distance = formatDistance(facility.distanceKm);
  const registered = facility.source === "LIFELINK";
  const detailsId = `ll-details-${facility.id.replace(/[^\w-]/g, "-")}`;
  const inventory = hideInventory ? null : facility.inventory.status === "CONFIRMED"
    ? <span className="ll-tag good"><Droplet size={11} aria-hidden="true" />{facility.inventory.units} {facility.inventory.bloodGroup?.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")} recorded{facility.inventory.updatedAt ? ` · ${new Date(facility.inventory.updatedAt).toLocaleDateString()}` : ""}</span>
    : facility.inventory.status === "STALE" ? <span className="ll-tag warn">Stock record is out of date</span>
      : facility.inventory.status === "UNAVAILABLE" ? <span className="ll-tag warn">Stock couldn't be checked</span> : null;

  return <li className={`ll-facility-card${selected ? " is-selected" : ""}`} data-facility-id={facility.id}>
    <div className="ll-facility-media" aria-hidden={photo ? undefined : true}>
      {photo
        ? <img src={photo} alt={`Photo of ${facility.name}`} loading="lazy" referrerPolicy="no-referrer" onError={() => setPhotoFailed(true)} />
        : <span className={`ll-facility-placeholder type-${facility.type.toLowerCase()}`} title="No photo available"><TypeIcon type={facility.type} size={22} /></span>}
    </div>
    <div className="ll-facility-body">
      <button type="button" className="ll-facility-title" onClick={onSelect} aria-pressed={selected}>
        <span className="ll-facility-position">{position}</span><strong>{facility.name}</strong>
      </button>
      <div className="ll-facility-meta">
        <span>{facilityTypeLabel(facility.type)}</span>
        {distance && <span>{distance} away</span>}
        {registered ? <span className="ll-tag verified"><ShieldCheck size={11} aria-hidden="true" />LifeLink registered</span> : <span className="ll-tag">Public listing</span>}
        {facility.emergencyServiceStatus !== "UNKNOWN" && <span className="ll-tag alert"><Siren size={11} aria-hidden="true" />{facility.emergencyServiceStatus === "REGISTERED" ? "Emergency care registered" : "Emergency listed"}</span>}
      </div>
      <p className="ll-facility-address">{facility.address && facility.address !== "Address not listed" ? facility.address : "Address not listed"}</p>
      {facility.openingHours && <p className="ll-facility-hours"><Clock size={12} aria-hidden="true" />{facility.openingHours}</p>}
      {inventory}
      <div className="ll-facility-actions">
        {call ? <a className="ll-action primary" href={call} aria-label={`Call ${facility.name} (opens your phone app)`}><Phone size={14} aria-hidden="true" />Call</a>
          : <span className="ll-action is-disabled" aria-disabled="true" title="No phone number is listed"><Phone size={14} aria-hidden="true" />No phone</span>}
        {links.google && <a className="ll-action" href={links.google} target="_blank" rel="noreferrer" aria-label={`Directions to ${facility.name} in Google Maps (opens a new tab)`}><Navigation size={14} aria-hidden="true" />Directions</a>}
        {facility.latitude !== null && facility.longitude !== null && <button type="button" className="ll-action" onClick={onShowOnMap}><MapIcon size={14} aria-hidden="true" />Map</button>}
        <button type="button" className="ll-action ghost" aria-expanded={expanded} aria-controls={detailsId} onClick={onToggleDetails}>Details<ChevronDown size={13} aria-hidden="true" className={expanded ? "is-open" : ""} /></button>
      </div>
      {expanded && <dl className="ll-facility-details" id={detailsId}>
        <div><dt>Phone</dt><dd>{facility.phone ?? "Not listed"}</dd></div>
        <div><dt>Opening hours</dt><dd>{facility.openingHours ?? "Not listed"}</dd></div>
        {website && <div><dt>Website</dt><dd><a href={website} target="_blank" rel="noreferrer"><Globe2 size={12} aria-hidden="true" />{new URL(website).hostname}</a></dd></div>}
        <div><dt>Source</dt><dd>{registered ? "LifeLink institution record" : <>OpenStreetMap public listing{source && <> · <a href={source} target="_blank" rel="noreferrer">view<ExternalLink size={11} aria-hidden="true" /></a></>}</>}</dd></div>
        {links.openStreetMap && <div><dt>Other directions</dt><dd><a href={links.openStreetMap} target="_blank" rel="noreferrer">OpenStreetMap<ExternalLink size={11} aria-hidden="true" /></a></dd></div>}
        {photo && facility.photoCredit && <div><dt>Photo</dt><dd>{photoSource ? <a href={photoSource} target="_blank" rel="noreferrer">{facility.photoCredit}</a> : facility.photoCredit}</dd></div>}
        <div><dt>Retrieved</dt><dd>{new Date(facility.retrievedAt).toLocaleString()}</dd></div>
      </dl>}
    </div>
  </li>;
}
