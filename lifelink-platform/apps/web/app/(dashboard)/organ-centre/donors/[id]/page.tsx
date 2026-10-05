"use client";
import { useParams } from "next/navigation";
import { OrganRelatedDetailPage } from "../../../../../components/organ";
export default function DonorDetailRoute() { const params = useParams<{id:string}>(); return <OrganRelatedDetailPage id={params.id} resource="donors"/>; }
