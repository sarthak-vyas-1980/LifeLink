"use client";
import { MapContainer,TileLayer,Marker,Popup,useMap } from "react-leaflet";
import L from "leaflet";
import { useEffect } from "react";
type Institution={id:string;name:string;type:string;address:string;latitude:number|null;longitude:number|null;distanceKm?:number};
const markerIcon=L.divIcon({className:"lifelink-marker",html:"<span></span>",iconSize:[22,22],iconAnchor:[11,11]});
function Recenter({center}:{center:[number,number]}){const map=useMap();useEffect(()=>{map.setView(center,center[0]===20.5937?5:11);},[center,map]);return null;}
export default function InstitutionMap({institutions,center}:{institutions:Institution[];center?:[number,number]}){const fallback:[number,number]=[20.5937,78.9629];return <MapContainer center={center??fallback} zoom={center?11:5} scrollWheelZoom className="leaflet-map"><TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"/>{center&&<Recenter center={center}/ >}{institutions.filter((i)=>i.latitude!==null&&i.longitude!==null).map((i)=><Marker key={i.id} position={[i.latitude!,i.longitude!]} icon={markerIcon}><Popup><strong>{i.name}</strong><br/>{i.type.replaceAll("_"," ")}<br/>{i.address}</Popup></Marker>)}</MapContainer>;}
