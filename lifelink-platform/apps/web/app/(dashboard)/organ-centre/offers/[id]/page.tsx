"use client";
import { useParams } from "next/navigation";
import { OrganRelatedDetailPage } from "../../../../../components/organ";
export default function OfferDetailRoute() { const params = useParams<{id:string}>(); return <OrganRelatedDetailPage id={params.id} resource="offers"/>; }
