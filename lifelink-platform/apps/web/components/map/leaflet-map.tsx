"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef, useState } from "react";
import { hasMeasurableMapSize, isValidMapCoordinates } from "./map-layout";

type Institution = { id: string; name: string; type: string; address: string; latitude: number | null; longitude: number | null; distanceKm?: number; phone?: string | null; directionsUrl?: string | null };
const markerIcons = {
	blood: L.divIcon({ className: "lifelink-marker lifelink-marker-blood", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	organ: L.divIcon({ className: "lifelink-marker lifelink-marker-organ", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	hospital: L.divIcon({ className: "lifelink-marker lifelink-marker-hospital", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	clinic: L.divIcon({ className: "lifelink-marker lifelink-marker-clinic", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	pharmacy: L.divIcon({ className: "lifelink-marker lifelink-marker-pharmacy", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	emergency: L.divIcon({ className: "lifelink-marker lifelink-marker-emergency", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	other: L.divIcon({ className: "lifelink-marker lifelink-marker-other", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
};

const selectedMarkerIcons = {
	blood: L.divIcon({ className: "lifelink-marker lifelink-marker-blood is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	organ: L.divIcon({ className: "lifelink-marker lifelink-marker-organ is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	hospital: L.divIcon({ className: "lifelink-marker lifelink-marker-hospital is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	clinic: L.divIcon({ className: "lifelink-marker lifelink-marker-clinic is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	pharmacy: L.divIcon({ className: "lifelink-marker lifelink-marker-pharmacy is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	emergency: L.divIcon({ className: "lifelink-marker lifelink-marker-emergency is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
	other: L.divIcon({ className: "lifelink-marker lifelink-marker-other is-selected", html: "<span></span>", iconSize: [28, 28], iconAnchor: [14, 14] }),
};

function markerType(type: string) {
	return type === "BLOOD_BANK" ? "blood" : type === "ORGAN_CENTRE" ? "organ" : type === "CLINIC" ? "clinic" : type === "PHARMACY" ? "pharmacy" : type === "EMERGENCY_DEPARTMENT" ? "emergency" : type === "HOSPITAL" ? "hospital" : "other";
}

function createPopupContent(institution: Institution) {
	const content = document.createElement("div");
	const title = document.createElement("strong");
	title.textContent = institution.name;
	content.append(title, document.createElement("br"));
	content.append(document.createTextNode(institution.type.replaceAll("_", " ")));
	content.append(document.createElement("br"), document.createTextNode(institution.address));
	const phone = institution.phone?.trim();
	if (phone && /^[+\d().\-\s]+$/.test(phone) && phone.replace(/\D/g, "").length >= 7 && phone.replace(/\D/g, "").length <= 15) {
		content.append(document.createElement("br"));
		const call = document.createElement("a");
		call.href = `tel:${phone.replace(/[^+\d]/g, "")}`;
		call.textContent = "Call facility";
		content.append(call);
	}
	if (institution.directionsUrl) {
		try {
			const url = new URL(institution.directionsUrl);
			if (url.protocol === "https:" && url.hostname === "www.openstreetmap.org") {
				content.append(document.createElement("br"));
				const directions = document.createElement("a");
				directions.href = url.toString();
				directions.target = "_blank";
				directions.rel = "noreferrer";
				directions.textContent = "Directions";
				content.append(directions);
			}
		} catch { /* Ignore malformed external URLs. */ }
	}
	return content;
}

export default function InstitutionMap({ institutions, center, selectedInstitutionId, onSelectInstitution, centerLabel = "Search area" }: {
	institutions: Institution[];
	center?: [number, number];
	selectedInstitutionId?: string | null;
	onSelectInstitution?: (id: string) => void;
	centerLabel?: string;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<L.Map | null>(null);
	const facilitiesLayerRef = useRef<L.LayerGroup | null>(null);
	const centerMarkerRef = useRef<L.CircleMarker | null>(null);
	const markerRefs = useRef<Record<string, L.Marker>>({});
	const fittedViewKey = useRef("");
	const [ready, setReady] = useState(false);
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
		const map = L.map(container, { scrollWheelZoom: true }).setView(validCenter ?? [0, 0], validCenter ? 13 : 2);
		mapRef.current = map;
		const tileLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
		}).addTo(map);
		const facilitiesLayer = L.layerGroup().addTo(map);
		facilitiesLayerRef.current = facilitiesLayer;
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
			map.stop();
			facilitiesLayer.clearLayers();
			tileLayer.remove();
			map.remove();
			if (mapRef.current === map) mapRef.current = null;
			if (facilitiesLayerRef.current === facilitiesLayer) facilitiesLayerRef.current = null;
			centerMarkerRef.current = null;
			markerRefs.current = {};
		};
		// The instance belongs to this mounted DOM node. Changes to search data update layers in separate effects.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		const map = mapRef.current;
		const layer = facilitiesLayerRef.current;
		if (!ready || !map || !layer || !map.getContainer().isConnected) return;
		layer.clearLayers();
		markerRefs.current = {};
		for (const institution of validInstitutions) {
			const type = markerType(institution.type);
			const isSelected = selectedInstitutionId === institution.id;
			const marker = L.marker([institution.latitude!, institution.longitude!], { icon: isSelected ? selectedMarkerIcons[type] : markerIcons[type] });
			marker.bindPopup(createPopupContent(institution));
			marker.on("click", () => onSelectInstitution?.(institution.id));
			markerRefs.current[institution.id] = marker;
			layer.addLayer(marker);
		}
	}, [ready, validInstitutions, selectedInstitutionId, onSelectInstitution]);

	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || !map.getContainer().isConnected || fittedViewKey.current === viewKey) return;
		fittedViewKey.current = viewKey;
		map.stop();
		map.invalidateSize({ animate: false, pan: false });
		const points = validInstitutions.map((item) => [item.latitude!, item.longitude!] as [number, number]);
		if (validCenter) points.push(validCenter);
		if (points.length > 1) map.fitBounds(points, { padding: [24, 24], maxZoom: 14, animate: false });
		else if (points.length === 1) map.setView(points[0], 13, { animate: false });
	}, [ready, viewKey, validCenter?.[0], validCenter?.[1], validInstitutions]);

	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !map || !map.getContainer().isConnected) return;
		centerMarkerRef.current?.remove();
		centerMarkerRef.current = null;
		if (validCenter) centerMarkerRef.current = L.circleMarker(validCenter, { radius: 8, color: "#2563eb", fillColor: "#60a5fa", fillOpacity: 0.8 }).bindPopup(centerLabel).addTo(map);
	}, [ready, validCenter?.[0], validCenter?.[1], centerLabel]);

	useEffect(() => {
		const map = mapRef.current;
		if (!ready || !selectedInstitutionId || !map || !map.getContainer().isConnected) return;
		const marker = markerRefs.current[selectedInstitutionId];
		if (!marker?.getElement()?.isConnected) return;
		let active = true;
		let frame = 0;
		map.stop();
		const institution = validInstitutions.find((item) => item.id === selectedInstitutionId);
		if (institution && isValidMapCoordinates([institution.latitude, institution.longitude])) {
			map.flyTo([institution.latitude!, institution.longitude!], Math.max(map.getZoom(), 14), { duration: 0.45 });
			frame = requestAnimationFrame(() => { if (active && marker.getElement()?.isConnected) marker.openPopup(); });
		}
		return () => { active = false; cancelAnimationFrame(frame); if (mapRef.current === map) map.stop(); };
	}, [ready, selectedInstitutionId, validInstitutions]);

	return <div ref={containerRef} className="leaflet-map" role="application" aria-label="Interactive healthcare facilities map" />;
}
