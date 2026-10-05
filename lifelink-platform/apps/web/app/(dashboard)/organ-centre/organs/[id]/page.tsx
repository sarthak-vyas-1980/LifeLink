"use client";
import { useParams } from "next/navigation";
import { OrganDetailPage } from "../../../../../components/organ";
export default function OrganDetailRoute() { const params = useParams<{id:string}>(); return <OrganDetailPage id={params.id}/>; }
