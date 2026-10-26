"use client";

import { Suspense, useEffect, useState } from "react";
import RequestsWorkspace from "../../../components/requests";
import { BloodDonationWorkspace } from "../../../components/blood-donation";
import { BloodInventoryWorkspace } from "../../../components/blood-inventory";
import { getCurrentSession } from "../../../lib/auth";

type ServiceTab = "requests" | "donations" | "inventory";

export default function BloodServicesPage() {
	const [activeTab, setActiveTab] = useState<ServiceTab>("requests");
	const [isInstitution, setIsInstitution] = useState(false);
	const [canManageInventory, setCanManageInventory] = useState(false);
	useEffect(() => {
		const user = getCurrentSession()?.user;
		setIsInstitution(user?.principalType === "INSTITUTION");
		setCanManageInventory(user?.role === "ADMINISTRATOR" || Boolean(user?.principalType === "INSTITUTION" && user.capabilities?.blood));
	}, []);
	const tabs: Array<{ id: ServiceTab; label: string; description: string }> = [
		{ id: "requests", label: isInstitution ? "Blood request coordination" : "Request blood", description: isInstitution ? "Review matched requests and provider offers." : "Create a request or follow its matching and offers." },
		{ id: "donations", label: isInstitution ? "Donor approvals" : "Donate blood", description: isInstitution ? "Review donor interest and confirm collection." : "Register donor interest with a blood service." },
		...(canManageInventory ? [{ id: "inventory" as const, label: "Blood inventory", description: "Review, add, and update available stock." }] : []),
	];
	const selected = tabs.find((tab) => tab.id === activeTab)!;

	return <main className="page-stack blood-services-page">
		<header className="page-heading"><div><span className="eyebrow">LIFELINK · BLOOD SERVICES</span><h1>Blood services</h1><p>Manage blood requests and donation coordination from one workspace.</p></div></header>
		<nav className="panel blood-services-tabs" role="tablist" aria-label="Blood service workflows">
			{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={`blood-service-${tab.id}`} id={`blood-tab-${tab.id}`} className={activeTab === tab.id ? "selected" : ""} onClick={() => setActiveTab(tab.id)}><strong>{tab.label}</strong><small>{tab.description}</small></button>)}
		</nav>
		<section role="tabpanel" id={`blood-service-${activeTab}`} aria-labelledby={`blood-tab-${activeTab}`}>
			{activeTab === "requests" ? <Suspense fallback={<section className="panel">Loading blood request workflow…</section>}><RequestsWorkspace embedded/></Suspense> : activeTab === "donations" ? <BloodDonationWorkspace embedded/> : <BloodInventoryWorkspace embedded/>}
		</section>
	</main>;
}
