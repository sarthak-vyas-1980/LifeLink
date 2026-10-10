"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Building2, HeartPulse, RefreshCw, ShieldCheck } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { WorkflowPath } from "../../../components/organ/workflow-progress";
import { InstitutionRequestAnalytics } from "../../../components/institution/request-analytics";

type Institution = { id: string; name: string; type: string; status: string; address: string; contactPerson?: string | null; contactNumber?: string | null; hospitalProfile?: { emergencySupport: boolean; bloodService?: { id: string } | null; organService?: { id: string } | null } | null; organCentreProfile?: { id: string } | null; bloodBankProfile?: { id: string } | null };
type ProfileResponse = { institution: Institution; capabilities: { blood: boolean; organ: boolean; emergency: boolean } };
type OrganMetrics = { total: number; donorRequests: number; recipientRequests: number; activeWorkflows: number; matching: number; activeOffers: number; acceptedOffers: number; pendingDonorReview: number; pendingRecipientReview: number; activeRecipientRequirements: number; procurements: number; procurementVolume: number; completed: number; rejected: number; cancelled: number; expired: number; recentActivity: Array<{ id: string; action: string; createdAt: string; reference: string | null; organType: string | null }> };

export default function InstitutionWorkspacePage() {
	const [profile, setProfile] = useState<ProfileResponse | null>(null);
	const [organMetrics, setOrganMetrics] = useState<OrganMetrics | null>(null);
	const [error, setError] = useState("");
	const load = useCallback(() => {
		setError("");
		void requestApi<ProfileResponse>("/api/institutions/me").then(async (data) => {
			setProfile(data);
			if (data.capabilities.organ) {
				try { setOrganMetrics(await requestApi<OrganMetrics>("/api/organs/dashboard")); }
				catch { /* Keep the institution profile available if a dashboard metric is temporarily unavailable. */ }
			}
		}).catch((reason: Error) => setError(reason.message));
	}, []);
	useEffect(load, [load]);

	if (error) return <main className="page-stack institution-workspace"><header className="welcome-banner"><div><span className="eyebrow">INSTITUTION WORKSPACE</span><h1>Institution workspace</h1><p>Your institution profile and enabled services.</p></div><button className="button" onClick={load}><RefreshCw size={14}/> Retry</button></header><section className="panel"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION OVERVIEW</span><h2>Workspace data unavailable</h2><p>The institution workspace is still here, but its profile could not be loaded.</p></div></div><p className="error" role="alert">{error}</p><Link className="button" href="/dashboard">Return to overview</Link></section></main>;
	if (!profile) return <main className="page-stack"><section className="panel">Loading institution workspace…</section></main>;
	const { institution, capabilities } = profile;
	return <main className="page-stack institution-workspace"><header className="welcome-banner"><div><span className="eyebrow">INSTITUTION WORKSPACE</span><h1>{institution.name}</h1><p>{institution.type.replaceAll("_", " ")} · {institution.status.toLowerCase().replaceAll("_", " ")}</p></div><div className="welcome-symbol"><Building2 size={48}/></div></header>{capabilities.organ && organMetrics && <WorkflowPath/>}
		<div className="metric-grid"><article className="metric-card"><span className="metric-icon teal"><Building2/></span><span className="eyebrow">INSTITUTION TYPE</span><strong className="institution-metric-text">{institution.type.replaceAll("_", " ")}</strong><small>{institution.address}</small></article><article className="metric-card"><span className="metric-icon blue"><ShieldCheck/></span><span className="eyebrow">ENABLED SERVICES</span><strong>{[capabilities.blood && "Blood", capabilities.organ && "Organ", capabilities.emergency && "Emergency"].filter(Boolean).length}</strong><small>{[capabilities.blood && "Blood", capabilities.organ && "Organ", capabilities.emergency && "Emergency support"].filter(Boolean).join(" · ") || "No optional services enabled"}</small></article>{capabilities.organ && <article className="metric-card"><span className="metric-icon gold"><HeartPulse/></span><span className="eyebrow">ACTIVE ORGAN WORKFLOWS</span><strong>{organMetrics?.activeWorkflows ?? "—"}</strong><small>{organMetrics ? `${organMetrics.donorRequests} donor interests · ${organMetrics.recipientRequests} recipient requirements` : "Organ coordination"}</small></article>}</div>
		<InstitutionRequestAnalytics/>
		{capabilities.organ && organMetrics && <>
			<section className="panel institution-organ-analytics">
				<div className="panel-heading"><div><span className="eyebrow">ORGAN WORKFLOW ANALYTICS</span><h2>Requests and coordination stages</h2><p>A live overview of work moving through your organ service.</p></div><Link href="/organ-centre" className="button small">Open organ workspace <ArrowUpRight size={14}/></Link></div>
				<div className="institution-organ-stage-grid">
					<article className="institution-organ-stage review"><span className="eyebrow">UNDER REVIEW</span><strong>{organMetrics.pendingDonorReview + organMetrics.pendingRecipientReview}</strong><small>Donor and recipient reviews</small></article>
					<article className="institution-organ-stage matching"><span className="eyebrow">MATCHING</span><strong>{organMetrics.matching}</strong><small>Organ records in matching</small></article>
					<article className="institution-organ-stage offers"><span className="eyebrow">OFFERS</span><strong>{organMetrics.activeOffers}</strong><small>{organMetrics.acceptedOffers} accepted</small></article>
					<article className="institution-organ-stage procurement"><span className="eyebrow">PROCUREMENT</span><strong>{organMetrics.procurements}</strong><small>{organMetrics.procurementVolume} total records</small></article>
					<article className="institution-organ-stage completed"><span className="eyebrow">COMPLETED</span><strong>{organMetrics.completed}</strong><small>Completed workflows</small></article>
					<article className="institution-organ-stage closed"><span className="eyebrow">CLOSED / EXPIRED</span><strong>{organMetrics.cancelled + organMetrics.rejected + organMetrics.expired}</strong><small>{organMetrics.cancelled} cancelled · {organMetrics.expired} expired · {organMetrics.rejected} unavailable</small></article>
				</div>
			</section>
			<section className="panel institution-organ-activity">
				<div className="panel-heading"><div><span className="eyebrow">RECENT ORGAN ACTIVITY</span><h2>Latest updates</h2><p>Recent changes across your organ workflows.</p></div><span className="institution-activity-count">{organMetrics.recentActivity.length} updates</span></div>
				{organMetrics.recentActivity.length ? <ol className="institution-activity-list">{organMetrics.recentActivity.map((activity) => <li key={activity.id}><span className="institution-activity-marker"/><div className="institution-activity-content"><div><strong>{activity.action.replaceAll("_", " ").toLowerCase()}</strong><time>{new Date(activity.createdAt).toLocaleString()}</time></div>{(activity.reference || activity.organType) && <small>{[activity.reference, activity.organType?.replaceAll("_", " ")].filter(Boolean).join(" · ")}</small>}</div></li>)}</ol> : <div className="institution-activity-empty">No organ workflow activity recorded yet.</div>}
			</section>
		</>}
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION OPERATIONS</span><h2>Open a service workspace</h2><p>Manage institution records with your account’s enabled permissions.</p></div></div><div className="institution-service-grid">{capabilities.blood && <Link href="/requests" className="institution-service-card"><span className="metric-icon teal"><Building2/></span><strong>Blood coordination</strong><small>Review requests, offers, and inventory workflows.</small><ArrowUpRight/></Link>}{capabilities.organ && <Link href="/organ-centre" className="institution-service-card"><span className="metric-icon gold"><HeartPulse/></span><strong>Organ coordination</strong><small>{organMetrics ? `${organMetrics.pendingDonorReview} donor interests · ${organMetrics.pendingRecipientReview} recipient requests awaiting review · ${organMetrics.activeRecipientRequirements} active requirements` : "Review donors, recipients, inventory, and offers."}</small><ArrowUpRight/></Link>}{capabilities.emergency && <article className="institution-service-card"><span className="metric-icon blue"><ShieldCheck/></span><strong>Emergency support</strong><small>Listed as a hospital capability for institution discovery.</small></article>}</div></section>
		<section className="panel institution-profile"><span className="eyebrow">INSTITUTION PROFILE</span><div><span>Address</span><strong>{institution.address}</strong></div>{institution.contactPerson && <div><span>Contact person</span><strong>{institution.contactPerson}</strong></div>}{institution.contactNumber && <div><span>Contact number</span><strong>{institution.contactNumber}</strong></div>}</section>
	</main>;
}
