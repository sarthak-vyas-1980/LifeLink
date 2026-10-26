"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, HeartPulse, MapPinned, ShieldCheck, Building2, Clock3, RefreshCw } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { getCurrentSession } from "../../../lib/auth";
import { InstitutionRequestAnalytics } from "../../../components/institution/request-analytics";

type OverviewAccount = {
	role: string;
	principalType?: string;
	institutionId?: string | null;
	capabilities?: { blood?: boolean; organ?: boolean };
};

type OverviewAction = {
	href: string;
	title: string;
	description: string;
	icon: typeof HeartPulse;
};

type AuditEvent = {
	id: string;
	actorId: string | null;
	actorInstitutionId: string | null;
	action: string;
	entityType: string;
	entityId: string;
	metadata: unknown;
	createdAt: string;
};

export default function DashboardPage() {
	const [account, setAccount] = useState<OverviewAccount | null>(null);
	const [activityScope, setActivityScope] = useState<"mine" | "operational">("mine");
	const [auditActivity, setAuditActivity] = useState<AuditEvent[]>([]);
	const [personalActivity, setPersonalActivity] = useState<AuditEvent[]>([]);
	const [activityLoading, setActivityLoading] = useState(false);
	const [activityError, setActivityError] = useState("");
	useEffect(() => {
		setAccount(getCurrentSession()?.user ?? null);
	}, []);
	useEffect(() => {
		if (!account) return;
		setActivityLoading(true);
		setActivityError("");
		if (account.role === "ADMINISTRATOR") {
			void requestApi<{ events: AuditEvent[] }>(`/api/admin/audit?page=1&pageSize=10&scope=${activityScope}`)
				.then((response) => setAuditActivity(response.events.slice(0, 5)))
				.catch((reason: Error) => setActivityError(reason.message || "Could not load recent activity."))
				.finally(() => setActivityLoading(false));
		} else if (account.principalType === "INSTITUTION") {
			void requestApi<{ events: AuditEvent[] }>(`/api/audit?page=1&pageSize=5&scope=${activityScope}`)
				.then((response) => setPersonalActivity(response.events))
				.catch((reason: Error) => setActivityError(reason.message || "Could not load recent activity."))
				.finally(() => setActivityLoading(false));
		} else {
			void requestApi<{ events: AuditEvent[] }>("/api/audit?page=1&pageSize=5")
				.then((response) => setPersonalActivity(response.events))
				.catch((reason: Error) => setActivityError(reason.message || "Could not load recent activity."))
				.finally(() => setActivityLoading(false));
		}
	}, [account, activityScope]);

	const personalUser = account?.role === "USER" || (account?.role === "ADMINISTRATOR" && account.principalType === "USER");
	const institutionUser = Boolean(account?.institutionId);
	const institutionAccount = account?.principalType === "INSTITUTION";
	const bloodDonationWorkspace = !institutionUser || account?.role === "ADMINISTRATOR" || Boolean(account?.capabilities?.blood);
	const organWorkspace = account?.role === "ORGAN_CENTRE_USER" || account?.role === "ADMINISTRATOR" || (account?.role === "HOSPITAL_USER" && account.capabilities?.organ);

	const actions: OverviewAction[] = institutionUser
		? [
			{ href: "/institution", title: "Institution workspace", description: "Open service dashboards and operational records.", icon: Building2 },
			...(bloodDonationWorkspace ? [{ href: "/blood-services", title: "Blood services", description: "Coordinate requests and review blood donor interests.", icon: HeartPulse }] : []),
			...(organWorkspace ? [{ href: "/organ-centre", title: "Organ coordination", description: "Manage donor, recipient, and organ workflows.", icon: HeartPulse }] : []),
		]
		: [
			...(account?.role === "ADMINISTRATOR" ? [{ href: "/admin", title: "Administration", description: "Review platform activity and manage institutions.", icon: ShieldCheck }] : []),
			{ href: "/map", title: "Find an institution", description: "Explore nearby hospitals and blood banks.", icon: MapPinned },
			{ href: "/blood-services", title: "Blood services", description: account?.role === "ADMINISTRATOR" ? "Review requests and donor activity across the platform." : "Request blood, donate blood, and follow both workflows.", icon: HeartPulse },
			...(personalUser ? [{ href: "/organ-services", title: "Organ services", description: "Manage donor interest or recipient requirements.", icon: HeartPulse }] : []),
		];

	return <div className="page-stack overview-page">
		<header className="welcome-banner"><div><span className="eyebrow">LIFELINK WORKSPACE</span><h1>Your coordination workspace</h1><p>Open a service to continue a request, manage workflows, or find an institution.</p></div><div className="welcome-symbol"><HeartPulse size={52}/></div></header>
		<section className="panel overview-actions"><div className="panel-heading"><div><span className="eyebrow">WORKSPACES & SERVICES</span><h2>Where would you like to go?</h2><p>Choose a service to get started or continue your work.</p></div></div><div className="overview-action-grid">{actions.map(({ href, title, description, icon: Icon }) => <Link className="overview-action" href={href} key={href}><span className="overview-action-icon"><Icon size={20}/></span><span className="overview-action-copy"><strong>{title}</strong><small>{description}</small></span><ArrowUpRight className="overview-action-arrow" size={17}/></Link>)}</div></section>
		{personalUser && <InstitutionRequestAnalytics endpoint="/api/users/me/request-analytics" eyebrow="PERSONAL REQUEST PERFORMANCE" title="Your fulfillment performance" description="Track how your personal blood and organ requests are fulfilled over time."/>}
		<section className="panel overview-activity"><div className="panel-heading"><div><span className="eyebrow">RECENT ACTIVITY</span><h2>{account?.role === "ADMINISTRATOR" ? "Platform activity" : institutionAccount ? "Institution activity" : "Your activity"}</h2><p>{account?.role === "ADMINISTRATOR" ? "Review your actions or recent events across operational workflows." : institutionAccount ? "Review actions by this institution or events across its operational records." : "Recent changes and workflow actions performed by your account."}</p></div><Link className="button" href={account?.role === "ADMINISTRATOR" ? "/admin/audit" : institutionAccount ? `/activity?scope=${activityScope}` : "/activity"}>{account?.role === "ADMINISTRATOR" ? "Open audit log" : "View all activity"}</Link></div>
			{(account?.role === "ADMINISTRATOR" || institutionAccount) && <div className="overview-tabs" role="tablist" aria-label="Activity scope"><button type="button" role="tab" aria-selected={activityScope === "mine"} className={activityScope === "mine" ? "selected" : ""} onClick={() => setActivityScope("mine")}>My activity</button><button type="button" role="tab" aria-selected={activityScope === "operational"} className={activityScope === "operational" ? "selected" : ""} onClick={() => setActivityScope("operational")}>Operational scope</button></div>}
			{activityError && <p className="error" role="alert">{activityError}</p>}
			{activityLoading ? <p className="overview-activity-empty"><RefreshCw size={15}/> Loading activity…</p> : account?.role === "ADMINISTRATOR" ? auditActivity.length ? <ul className="overview-activity-list">{auditActivity.map((event) => <li key={event.id}><span className="overview-activity-icon"><Clock3 size={16}/></span><span className="overview-activity-copy"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{auditEntityLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></li>)}</ul> : <p className="overview-activity-empty">{activityError ? "Activity could not be loaded." : "No activity recorded in this view yet."}</p> : personalActivity.length ? <ul className="overview-activity-list">{personalActivity.map((event) => <li key={event.id}><span className="overview-activity-icon"><Clock3 size={16}/></span><span className="overview-activity-copy"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{auditEntityLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></li>)}</ul> : <p className="overview-activity-empty">{activityError ? "Activity could not be loaded." : "No activity recorded yet."}</p>}
		</section>
		<p className="map-disclaimer">Matching results indicate possible sources. A provider’s explicit confirmation is required before units are reserved.</p>
	</div>;
}

function auditEntityLabel(event: AuditEvent) {
	const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) ? event.metadata as Record<string, unknown> : {};
	const reference = metadata.reference ?? metadata.donorReference ?? metadata.recipientReference;
	return reference ? `${event.entityType} · ${String(reference)}` : `${event.entityType} record`;
}
