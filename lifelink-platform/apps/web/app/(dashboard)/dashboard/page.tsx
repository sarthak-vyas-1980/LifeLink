"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, ClipboardList, MapPinned, Bell, HeartPulse } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { getCurrentSession } from "../../../lib/auth";

export default function DashboardPage() {
	const [counts, setCounts] = useState({ requests: 0, notifications: 0 });
	const [personalUser, setPersonalUser] = useState(false);
	const [institutionUser, setInstitutionUser] = useState(false);
	useEffect(() => {
		const user = getCurrentSession()?.user;
		setPersonalUser(user?.role === "USER");
		setInstitutionUser(Boolean(user?.institutionId));
		void Promise.all([
			requestApi<{ requests: unknown[] }>("/api/requests/blood"),
			requestApi<{ notifications: { status: string }[] }>("/api/notifications?limit=100"),
		]).then(([requests, notifications]) => setCounts({ requests: requests.requests.length, notifications: notifications.notifications.filter((item) => item.status === "UNREAD").length })).catch(() => {});
	}, []);
	return <div className="page-stack">
		<header className="welcome-banner"><div><span className="eyebrow">LIFELINK WORKSPACE</span><h1>Coordination, made clear.</h1><p>Choose how you want to use LifeLink. You can switch actions whenever you need.</p></div><div className="welcome-symbol"><HeartPulse size={52}/></div></header>
		<div className="metric-grid"><article className="metric-card"><span className="metric-icon teal"><ClipboardList/></span><span className="eyebrow">AUTHORIZED REQUESTS</span><strong>{counts.requests}</strong><small>Visible to your account</small></article><article className="metric-card"><span className="metric-icon gold"><Bell/></span><span className="eyebrow">UNREAD UPDATES</span><strong>{counts.notifications}</strong><small>Workflow notifications</small></article><article className="metric-card"><span className="metric-icon blue"><MapPinned/></span><span className="eyebrow">DISCOVERY</span><strong>Local</strong><small>Active care institutions</small></article></div>
		<section className="panel quick-start"><div><span className="eyebrow">GET STARTED</span><h2>What do you need to do?</h2></div><div className="quick-links">{institutionUser ? <Link href="/institution"><span><HeartPulse/><strong>Institution workspace<small>Open your service dashboards and operational records</small></strong></span><ArrowUpRight/></Link> : <><Link href="/map"><span><MapPinned/><strong>Donate blood<small>Find nearby hospitals and blood banks</small></strong></span><ArrowUpRight/></Link><Link href="/requests"><span><ClipboardList/><strong>Request blood<small>Create and track a recipient request</small></strong></span><ArrowUpRight/></Link></>}{personalUser && <><Link href="/organ-services"><span><HeartPulse/><strong>Donate an organ<small>Register your donor interest</small></strong></span><ArrowUpRight/></Link><Link href="/organ-services"><span><HeartPulse/><strong>Need an organ<small>Register a recipient requirement</small></strong></span><ArrowUpRight/></Link></>}</div></section>
		<p className="map-disclaimer">Matching results indicate possible sources. A provider’s explicit confirmation is required before units are reserved.</p>
	</div>;
}
