"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Building2, HeartPulse, ShieldCheck } from "lucide-react";
import { requestApi } from "../../../lib/api-client";

type Institution = { id: string; name: string; type: string; status: string; address: string; contactPerson?: string | null; contactNumber?: string | null; hospitalProfile?: { emergencySupport: boolean; bloodService?: { id: string } | null; organService?: { id: string } | null } | null; organCentreProfile?: { id: string } | null; bloodBankProfile?: { id: string } | null };
type ProfileResponse = { institution: Institution; capabilities: { blood: boolean; organ: boolean; emergency: boolean } };
type OrganMetrics = { total: number; available: number; activeOffers: number; pendingDonorReview: number; pendingRecipientReview: number; activeRecipientRequirements: number; procurements: number };

export default function InstitutionWorkspacePage() {
	const [profile, setProfile] = useState<ProfileResponse | null>(null);
	const [organMetrics, setOrganMetrics] = useState<OrganMetrics | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		void requestApi<ProfileResponse>("/api/institutions/me").then(async (data) => {
			setProfile(data);
			if (data.capabilities.organ) {
				try { setOrganMetrics(await requestApi<OrganMetrics>("/api/organs/dashboard")); }
				catch { /* Keep the institution profile available if a dashboard metric is temporarily unavailable. */ }
			}
		}).catch((reason: Error) => setError(reason.message));
	}, []);

	if (error) return <main className="page-stack"><section className="panel"><h1>Institution workspace</h1><p className="error" role="alert">{error}</p><Link className="button" href="/dashboard">Return to overview</Link></section></main>;
	if (!profile) return <main className="page-stack"><section className="panel">Loading institution workspace…</section></main>;
	const { institution, capabilities } = profile;
	return <main className="page-stack institution-workspace"><header className="welcome-banner"><div><span className="eyebrow">INSTITUTION WORKSPACE</span><h1>{institution.name}</h1><p>{institution.type.replaceAll("_", " ")} · {institution.status.toLowerCase().replaceAll("_", " ")}</p></div><div className="welcome-symbol"><Building2 size={48}/></div></header>
		<div className="metric-grid"><article className="metric-card"><span className="metric-icon teal"><Building2/></span><span className="eyebrow">INSTITUTION TYPE</span><strong className="institution-metric-text">{institution.type.replaceAll("_", " ")}</strong><small>{institution.address}</small></article><article className="metric-card"><span className="metric-icon blue"><ShieldCheck/></span><span className="eyebrow">ENABLED SERVICES</span><strong>{[capabilities.blood && "Blood", capabilities.organ && "Organ", capabilities.emergency && "Emergency"].filter(Boolean).length}</strong><small>{[capabilities.blood && "Blood", capabilities.organ && "Organ", capabilities.emergency && "Emergency support"].filter(Boolean).join(" · ") || "No optional services enabled"}</small></article>{capabilities.organ && <article className="metric-card"><span className="metric-icon gold"><HeartPulse/></span><span className="eyebrow">ORGAN RECORDS</span><strong>{organMetrics?.total ?? "—"}</strong><small>{organMetrics ? `${organMetrics.pendingDonorReview} donor interests need review` : "Organ coordination"}</small></article>}</div>
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION OPERATIONS</span><h2>Open a service workspace</h2><p>Manage institution records with your account’s enabled permissions.</p></div></div><div className="institution-service-grid">{capabilities.blood && <Link href="/requests" className="institution-service-card"><span className="metric-icon teal"><Building2/></span><strong>Blood coordination</strong><small>Review requests, offers, and inventory workflows.</small><ArrowUpRight/></Link>}{capabilities.organ && <Link href="/organ-centre" className="institution-service-card"><span className="metric-icon gold"><HeartPulse/></span><strong>Organ coordination</strong><small>{organMetrics ? `${organMetrics.pendingDonorReview} donor interests · ${organMetrics.pendingRecipientReview} recipient requests awaiting review · ${organMetrics.activeRecipientRequirements} active requirements` : "Review donors, recipients, inventory, and offers."}</small><ArrowUpRight/></Link>}{capabilities.emergency && <article className="institution-service-card"><span className="metric-icon blue"><ShieldCheck/></span><strong>Emergency support</strong><small>Listed as a hospital capability for institution discovery.</small></article>}</div></section>
		<section className="panel institution-profile"><span className="eyebrow">INSTITUTION PROFILE</span><div><span>Address</span><strong>{institution.address}</strong></div>{institution.contactPerson && <div><span>Contact person</span><strong>{institution.contactPerson}</strong></div>}{institution.contactNumber && <div><span>Contact number</span><strong>{institution.contactNumber}</strong></div>}</section>
	</main>;
}
