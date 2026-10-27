"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { hasMeasurableMapSize, isValidMapCoordinates } from "./map-layout";
import { directionsLinks, markerKind, safePhoneHref, type MarkerKind } from "./map-presentation";

type Institution = { id: string; name: string; type: string; address: string; latitude: number | null; longitude: number | null; distanceKm?: number; phone?: string | null; directionsUrl?: string | null };

// Category glyphs are drawn inside a pin so a marker can be told apart by shape and label, not colour alone.
const glyphs: Record<MarkerKind, string> = {
	hospital: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/></svg>',
	emergency: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 4h4v6h6v4h-6v6h-4v-6H4v-4h6z"/></svg>',
	blood: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c3.6 4.4 6 7.9 6 11a6 6 0 1 1-12 0c0-3.1 2.4-6.6 6-11z"/></svg>',
	clinic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v6a4 4 0 0 0 8 0V3h-2v6a2 2 0 1 1-4 0V3zM10 15v1a5 5 0 0 0 10 0v-2.2a2.5 2.5 0 1 0-2 0V16a3 3 0 0 1-6 0v-1z"/></svg>',
	pharmacy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 3.5a5 5 0 0 1 7.1 0 5 5 0 0 1 0 7.1L10.6 15.6a5 5 0 0 1-7.1-7.1zm1.4 1.4L6.4 8.4l4.2 4.2 3.5-3.5a3 3 0 0 0-4.2-4.2zM15 14h6v2h-6zm2-3h2v8h-2z"/></svg>',
	organ: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
	other: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/></svg>',
};

const iconCache = new Map<string, L.DivIcon>();
function pinIcon(kind: MarkerKind, selected: boolean) {
	const key = `${kind}:${selected}`;
	let icon = iconCache.get(key);
	if (!icon) {
		const size = selected ? 40 : 32;
		// Only the inner element is styled or scaled: Leaflet positions the outer element with its own transform.
		icon = L.divIcon({
			className: `lifelink-pin-icon${selected ? " is-selected" : ""}`,
			html: `<span class="lifelink-pin lifelink-pin-${kind}${selected ? " is-selected" : ""}">${glyphs[kind]}</span>`,
			iconSize: [size, size],
			iconAnchor: [size / 2, size],
			popupAnchor: [0, -size + 4],
		});
		iconCache.set(key, icon);
	}
	return icon;
}

function createPopupContent(institution: Institution) {
	const content = document.createElement("div");
	content.className = "lifelink-popup";
	const title = document.createElement("strong");
	title.textContent = institution.name;
	const meta = document.createElement("span");
	const type = institution.type.replaceAll("_", " ").toLowerCase();
	meta.textContent = [type.charAt(0).toUpperCase() + type.slice(1), institution.distanceKm !== undefined ? `${institution.distanceKm.toFixed(1)} km straight-line` : ""].filter(Boolean).join(" · ");
	const address = document.createElement("small");
	address.textContent = institution.address;
	content.append(title, meta, address);
	const actions = document.createElement("div");
	actions.className = "lifelink-popup-actions";
	const phone = safePhoneHref(institution.phone ?? null);
	if (phone) {
		const call = document.createElement("a");
		call.href = phone;
		call.textContent = "Call";
		actions.append(call);
	}
	const links = directionsLinks(institution.latitude, institution.longitude);
	if (links.google) {
		const directions = document.createElement("a");
		directions.href = links.google;
		directions.target = "_blank";
		directions.rel = "noreferrer";
		directions.textContent = "Directions";
		actions.append(directions);
	}
	if (actions.childElementCount) content.append(actions);
	return content;
}

function controlButton(label: string, text: string, onClick: () => void) {
	const button = L.DomUtil.create("button", "lifelink-map-control") as HTMLButtonElement;
	button.type = "button";
	button.title = label;
	button.setAttribute("aria-label", label);
	button.textContent = text;
	L.DomEvent.disableClickPropagation(button);
	L.DomEvent.on(button, "click", (event) => { L.DomEvent.preventDefault(event); onClick(); });
	return button;
}

export default function InstitutionMap({ institutions, center, selectedInstitutionId, onSelectInstitution, centerLabel = "Search area", centerKind = "search", controls = true }: {
	institutions: Institution[];
	center?: [number, number];
	selectedInstitutionId?: string | null;
	onSelectInstitution?: (id: string) => void;
	centerLabel?: string;
	/** "device" draws a you-are-here dot; "search" draws a search-area pin. */
	centerKind?: "device" | "search";
	controls?: boolean;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const facilitiesLayerRef = useRef<L.LayerGroup | null>(null);
	const centerMarkerRef = useRef<L.Marker | null>(null);
	const markerRefs = useRef<Record<string, { marker: L.Marker; kind: MarkerKind }>>({});
	const selectedRef = useRef<string | null>(null);
	const onSelectRef = useRef(onSelectInstitution);
	const fitRef = useRef<() => void>(() => undefined);
	const recenterRef = useRef<() => void>(() => undefined);
	const fittedViewKey = useRef("");
	const [ready, setReady] = useState(false);
	onSelectRef.current = onSelectInstitution;
	const validCenter = isValidMapCoordinates(center) ? [center[0], center[1]] as [number, number] : undefined;
	const validInstitutions = useMemo(() => {
		const ids = new Set<string>();
		return institutions.filter((institution) => {
			if (!institution.id || ids.has(institution.id) || !isValidMapCoordinates([institution.latitude, institution.longitude])) return false;
			ids.add(institution.id);
			return true;
		});
	}, [institutions]);
	const facilitiesKey = validInstitutions.map((item) => `${item.id}:${item.latitude},${item.longitude}`).join("|");
	const viewKey = `${validCenter?.[0] ?? ""},${validCenter?.[1] ?? ""}|${facilitiesKey}`;

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let active = true;
		let frame = 0;
		setReady(false);
		const map = L.map(container, { scrollWheelZoom: false, zoomControl: false }).setView(validCenter ?? [22.7, 78.9], validCenter ? 13 : 4);
		mapRef.current = map;
		L.control.zoom({ position: "topright" }).addTo(map);
		const tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
			maxZoom: 19,
		}).addTo(map);
		const facilitiesLayer = L.layerGroup().addTo(map);
		facilitiesLayerRef.current = facilitiesLayer;
		// Scroll-to-zoom only after the user interacts, so scrolling the chat never hijacks the map.
		map.on("focus click", () => map.scrollWheelZoom.enable());
		map.on("blur mouseout", () => map.scrollWheelZoom.disable());
		let controlBar: L.Control | null = null;
		if (controls) {
			const Bar = L.Control.extend({
				onAdd: () => {
					const bar = L.DomUtil.create("div", "lifelink-map-controls leaflet-bar");
					bar.append(controlButton("Fit all results on the map", "Fit all", () => fitRef.current()), controlButton("Return to the search point", "Recenter", () => recenterRef.current()));
					return bar;
				},
			});
			controlBar = new Bar({ position: "topleft" }).addTo(map);
		}
		const refreshSize = () => {
			if (!active) return;
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				if (active && container.isConnected && mapRef.current === map && hasMeasurableMapSize(container.clientWidth, container.clientHeight)) map.invalidateSize({ animate: false, pan: false });
			});
		};
		const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refreshSize) : null;
		observer?.observe(container.parentElement ?? container);
		window.addEventListener("resize", refreshSize);
		refreshSize();
		map.whenReady(() => { if (active && mapRef.current === map) setReady(true); });
		return () => {
			active = false;
			cancelAnimationFrame(frame);
			observer?.disconnect();
			window.removeEventListener("resize", refreshSize);
			map.off();
			map.stop();
			controlBar?.remove();
			facilitiesLayer.clearLayers();
			tileLayer.remove();
			map.remove();
			if (mapRef.current === map) mapRef.current = null;
			if (facilitiesLayerRef.current === facilitiesLayer) facilitiesLayerRef.current = null;
			centerMarkerRef.current = null;
			markerRefs.current = {};
			selectedRef.current = null;
		};
		// The instance belongs to this mounted DOM node. Changes to search data update layers in separate effects.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Fit and recenter read the latest data through refs, so the control buttons never go stale.
	fitRef.current = () => {
		const map = mapRef.current;
		if (!map || !map.getContainer().isConnected) return;
		const points = validInstitutions.map((item) => [item.latitude!, item.longitude!] as [number, number]);
		if (validCenter) points.push(validCenter);
		if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 15 });
		else if (points.length === 1) map.setView(points[0], 14);
	};
	recenterRef.current = () => {
		const map = mapRef.current;
		if (!map || !map.getContainer().isConnected) return;
		if (validCenter) map.setView(validCenter, Math.max(map.getZoom(), 14));
		else fitRef.current();
	};

	// Markers are rebuilt only when the set of facilities changes, never on selection.
	useEffect(() => {
		const map = mapRef.current;
		const layer = facilitiesLayerRef.current;
		if (!ready || !map || !layer || !map.getContainer().isConnected) return;
		layer.clearLayers();
		markerRefs.current = {};
		for (const institution of validInstitutions) {
			const kind = markerKind(institution.type);
			const marker = L.marker([institution.latitude!, institution.longitude!], {
				icon: pinIcon(kind, false), title: institution.name, alt: `${institution.name} map marker`, keyboard: true, riseOnHover: true,
			});
			marker.bindPopup(createPopupContent(institution), { closeButton: true, autoPanPadding: [24, 24] });
			marker.on("click", () => onSelectRef.current?.(institution.id));
			markerRefs.current[institution.id] = { marker, kind };
			layer.addLayer(marker);
		}
		selectedRef.current = null;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ready, facilitiesKey]);

	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || !map.getContainer().isConnected || fittedViewKey.current === viewKey) return;
		fittedViewKey.current = viewKey;
		map.stop();
		map.invalidateSize({ animate: false, pan: false });
		const points = validInstitutions.map((item) => [item.latitude!, item.longitude!] as [number, number]);
		if (validCenter) points.push(validCenter);
		if (points.length > 1) map.fitBounds(points, { padding: [32, 32], maxZoom: 15, animate: false });
		else if (points.length === 1) map.setView(points[0], 14, { animate: false });
	}, [ready, viewKey, validCenter?.[0], validCenter?.[1], validInstitutions]);

	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || !map.getContainer().isConnected) return;
		centerMarkerRef.current?.remove();
		centerMarkerRef.current = null;
		if (!validCenter) return;
		const device = centerKind === "device";
		centerMarkerRef.current = L.marker(validCenter, {
			icon: L.divIcon({
				className: "lifelink-center-icon",
				html: device ? '<span class="lifelink-you-are-here"></span>' : '<span class="lifelink-search-point"></span>',
				iconSize: device ? [22, 22] : [18, 18],
				iconAnchor: device ? [11, 11] : [9, 9],
			}),
			title: centerLabel, alt: centerLabel, keyboard: false, zIndexOffset: -100,
		}).bindTooltip(centerLabel, { direction: "top", offset: [0, -10] }).addTo(map);
	}, [ready, validCenter?.[0], validCenter?.[1], centerLabel, centerKind]);

	// Selection swaps two icons in place and brings the marker into view without re-zooming every time.
	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || !map.getContainer().isConnected) return;
		const previous = selectedRef.current ? markerRefs.current[selectedRef.current] : undefined;
		if (previous && selectedRef.current !== selectedInstitutionId) {
			previous.marker.setIcon(pinIcon(previous.kind, false));
			previous.marker.setZIndexOffset(0);
		}
		selectedRef.current = selectedInstitutionId ?? null;
		if (!selectedInstitutionId) return;
		const entry = markerRefs.current[selectedInstitutionId];
		if (!entry?.marker.getElement()?.isConnected) return;
		entry.marker.setIcon(pinIcon(entry.kind, true));
		entry.marker.setZIndexOffset(1000);
		let active = true;
		let frame = 0;
		map.stop();
		const position = entry.marker.getLatLng();
		if (!map.getBounds().pad(-0.15).contains(position)) map.flyTo(position, Math.max(map.getZoom(), 14), { duration: 0.4 });
		frame = requestAnimationFrame(() => { if (active && entry.marker.getElement()?.isConnected) entry.marker.openPopup(); });
		return () => { active = false; cancelAnimationFrame(frame); };
	}, [ready, selectedInstitutionId, facilitiesKey]);

	return <div ref={containerRef} className="leaflet-map" role="application" aria-label="Interactive healthcare facilities map" tabIndex={0} />;
}
