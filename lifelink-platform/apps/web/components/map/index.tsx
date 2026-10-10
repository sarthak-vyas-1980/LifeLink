"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { requestApi, ApiFailure } from "../../lib/api-client";

type Institution = { id: string; name: string; type: string; address: string; latitude: number | null; longitude: number | null; distanceKm?: number };
const pageSize = 5;
const InstitutionMap = dynamic(() => import("./leaflet-map"), { ssr: false, loading: () => <div className="map-loading">Preparing institution map…</div> });

export default function InstitutionDiscovery() {
	const [activeInstitutions, setActiveInstitutions] = useState<Institution[]>([]);
	const [searchResults, setSearchResults] = useState<Institution[]>([]);
	const [type, setType] = useState("");
	const [radius, setRadius] = useState("50");
	const [coords, setCoords] = useState<{ latitude: number; longitude: number } | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [activePage, setActivePage] = useState(1);
	const [searchPage, setSearchPage] = useState(1);
	const [hasSearched, setHasSearched] = useState(false);

	useEffect(() => {
		void requestApi<{ institutions: Institution[] }>("/api/institutions")
			.then((result) => setActiveInstitutions(result.institutions))
			.catch((reason) => setError(reason instanceof ApiFailure ? reason.message : "Could not load active institutions."));
	}, []);

	const search = async (position = coords) => {
		setBusy(true);
		setError("");
		setHasSearched(true);
		setSearchPage(1);
		setSearchResults([]);
		try {
			const params = new URLSearchParams();
			if (type) params.set("type", type);
			if (position) {
				params.set("latitude", String(position.latitude));
				params.set("longitude", String(position.longitude));
				if (radius) params.set("radiusKm", radius);
			}
			const result = await requestApi<{ institutions: Institution[] }>(`/api/institutions?${params}`);
			const maxDistance = Number(radius);
			setSearchResults(result.institutions.filter((institution) =>
				(!type || institution.type === type) &&
				(!position || !radius || institution.distanceKm !== undefined && institution.distanceKm <= maxDistance),
			));
		} catch (reason) {
			setError(reason instanceof ApiFailure ? reason.message : "Could not load institutions.");
			setSearchResults([]);
		} finally {
			setBusy(false);
		}
	};

	const locate = () => {
		if (!navigator.geolocation) { setError("Location access is unavailable in this browser."); return; }
		navigator.geolocation.getCurrentPosition((position) => {
			const current = { latitude: position.coords.latitude, longitude: position.coords.longitude };
			setCoords(current);
			void search(current);
		}, () => setError("Location access was unavailable."));
	};

	const activePageCount = Math.max(1, Math.ceil(activeInstitutions.length / pageSize));
	const visibleActive = activeInstitutions.slice((activePage - 1) * pageSize, activePage * pageSize);
	const searchPageCount = Math.max(1, Math.ceil(searchResults.length / pageSize));
	const visibleSearch = searchResults.slice((searchPage - 1) * pageSize, searchPage * pageSize);

	return <div className="page-stack institution-discovery-page">
		<header className="page-heading"><div><span className="eyebrow">LOCAL NETWORK</span><h1>Institution discovery</h1><p>Browse active facilities or search by type and distance.</p></div></header>
		<section className="panel map-filters">
			<label>Institution type<select value={type} onChange={(event) => setType(event.target.value)}><option value="">All facilities</option><option value="HOSPITAL">Hospitals</option><option value="BLOOD_BANK">Blood banks</option><option value="ORGAN_CENTRE">Organ centres</option></select></label>
			<label>Radius (km)<input type="number" min="1" max="500" value={radius} onChange={(event) => setRadius(event.target.value)}/></label>
			<button className="button quiet" onClick={locate}>Use my location</button>
			<button className="button primary" onClick={() => void search()} disabled={busy}>{busy ? "Searching…" : "Search map"}</button>
			{coords && <span className="muted coordinates-hint">Location filter enabled</span>}
		</section>
		{error && <p className="error" role="alert">{error}</p>}
		{hasSearched && <FacilityMapSection title="Search results" description={coords ? "Active facilities matching your type and distance filters." : "Active facilities matching your selected institution type."} institutions={searchResults} visible={visibleSearch} page={searchPage} pageCount={searchPageCount} onPageChange={setSearchPage} searching={busy}/>}
		<FacilityMapSection title="All active institutions" description="The complete active directory. Use the page controls to browse the list." institutions={activeInstitutions} visible={visibleActive} page={activePage} pageCount={activePageCount} onPageChange={setActivePage}/>
		<p className="map-disclaimer">Map pins show institution locations only. Inventory and ability to fulfil a request must be confirmed through the request workflow.</p>
	</div>;
}

function FacilityMapSection({ title, description, institutions, visible, page, pageCount, onPageChange, searching = false }: { title: string; description: string; institutions: Institution[]; visible: Institution[]; page: number; pageCount: number; onPageChange: (page: number) => void; searching?: boolean }) {
	const [selectedInstitutionId, setSelectedInstitutionId] = useState<string | null>(null);
	const selectInstitution = (id: string) => {
		setSelectedInstitutionId(id);
		const index = institutions.findIndex((institution) => institution.id === id);
		if (index >= 0) onPageChange(Math.floor(index / pageSize) + 1);
	};
	return <section className="facility-map-section">
		<header className="facility-map-section-heading"><div><span className="eyebrow">{title === "All active institutions" ? "ACTIVE DIRECTORY" : "FILTERED SEARCH"}</span><h2>{title}</h2><p>{description}</p></div><span className="facility-result-count">{institutions.length} {institutions.length === 1 ? "facility" : "facilities"}</span></header>
		<div className="facility-map-legend" aria-label="Map pin colors"><span><i className="blood"/>Blood bank</span><span><i className="organ"/>Organ centre</span><span><i className="hospital"/>Hospital</span></div>
		<div className="map-results-layout">
			<section className="panel map-panel" aria-label={`${title} map`}><InstitutionMap institutions={institutions} selectedInstitutionId={selectedInstitutionId} onSelectInstitution={selectInstitution}/></section>
			<section className="panel facility-list" aria-label={`${title} list`}>
				<div className="panel-heading"><div><span className="eyebrow">{title === "All active institutions" ? "ACTIVE FACILITIES" : "MATCHING FACILITIES"}</span><h2>{institutions.length} found</h2></div></div>
				{searching ? <p className="empty">Searching active facilities…</p> : visible.length === 0 ? <p className="empty">{title === "All active institutions" ? "No active institutions found." : "No active institutions match these filters."}</p> : visible.map((item) => <FacilityRow item={item} key={item.id} selected={selectedInstitutionId === item.id} onSelect={() => selectInstitution(item.id)}/>)}
				{institutions.length > pageSize && <div className="facility-pagination"><small>Page {page} of {pageCount}</small><div><button type="button" className="button small" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>Previous</button><button type="button" className="button small" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)}>Next</button></div></div>}
			</section>
		</div>
	</section>;
}

function FacilityRow({ item, selected, onSelect }: { item: Institution; selected: boolean; onSelect: () => void }) {
	const markerType = item.type === "BLOOD_BANK" ? "blood" : item.type === "ORGAN_CENTRE" ? "organ" : "hospital";
	const initial = item.type === "BLOOD_BANK" ? "B" : item.type === "ORGAN_CENTRE" ? "O" : "H";
	return <button type="button" className={`facility-row${selected ? " selected" : ""}`} aria-pressed={selected} onClick={onSelect}><span className={`facility-dot ${markerType}`} aria-hidden="true">{initial}</span><span className="facility-row-details"><strong>{item.name}</strong><small className="facility-address">{item.address || "Address not listed"}</small>{item.distanceKm !== undefined && <small>{item.distanceKm.toFixed(1)} km away</small>}</span></button>;
}
