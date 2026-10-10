"use client";

import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { useEffect, useRef } from "react";

type Institution = { id: string; name: string; type: string; address: string; latitude: number | null; longitude: number | null; distanceKm?: number };
type MarkerRefs = { current: Record<string, L.Marker | null> };

const markerIcons = {
	blood: L.divIcon({ className: "lifelink-marker lifelink-marker-blood", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	organ: L.divIcon({ className: "lifelink-marker lifelink-marker-organ", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
	hospital: L.divIcon({ className: "lifelink-marker lifelink-marker-hospital", html: "<span></span>", iconSize: [22, 22], iconAnchor: [11, 11] }),
};

function Recenter({ center }: { center: [number, number] }) {
	const map = useMap();
	useEffect(() => { map.setView(center, center[0] === 20.5937 ? 5 : 11); }, [center, map]);
	return null;
}

function FocusInstitution({ institution, markerRefs }: { institution?: Institution; markerRefs: MarkerRefs }) {
	const map = useMap();
	useEffect(() => {
		if (!institution || institution.latitude === null || institution.longitude === null) return;
		map.flyTo([institution.latitude, institution.longitude], Math.max(map.getZoom(), 14), { duration: 0.8 });
		markerRefs.current[institution.id]?.openPopup();
	}, [institution?.id, institution?.latitude, institution?.longitude, map, markerRefs]);
	return null;
}

export default function InstitutionMap({ institutions, center, selectedInstitutionId, onSelectInstitution }: {
	institutions: Institution[];
	center?: [number, number];
	selectedInstitutionId?: string | null;
	onSelectInstitution?: (id: string) => void;
}) {
	const fallback: [number, number] = [20.5937, 78.9629];
	const markerRefs = useRef<Record<string, L.Marker | null>>({});
	const selected = institutions.find((institution) => institution.id === selectedInstitutionId);
	return <MapContainer center={center ?? fallback} zoom={center ? 11 : 5} scrollWheelZoom className="leaflet-map">
		<TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
		{center && <Recenter center={center} />}
		<FocusInstitution institution={selected} markerRefs={markerRefs} />
		{institutions.filter((institution) => institution.latitude !== null && institution.longitude !== null).map((institution) => {
			const type = institution.type === "BLOOD_BANK" ? "blood" : institution.type === "ORGAN_CENTRE" ? "organ" : "hospital";
			return <Marker
				key={institution.id}
				position={[institution.latitude!, institution.longitude!]}
				icon={markerIcons[type]}
				ref={(marker) => { markerRefs.current[institution.id] = marker; }}
				eventHandlers={{ click: () => onSelectInstitution?.(institution.id) }}
			>
				<Popup><strong>{institution.name}</strong><br />{institution.type.replaceAll("_", " ")}<br />{institution.address}</Popup>
			</Marker>;
		})}
	</MapContainer>;
}
