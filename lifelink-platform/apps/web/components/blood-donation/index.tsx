"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HandHeart, HeartPulse, MapPin, Search } from "lucide-react";
import { BLOOD_GROUPS } from "@lifelink/shared";
import { ApiFailure, requestApi } from "../../lib/api-client";
import { getCurrentSession } from "../../lib/auth";

type Facility = { id: string; name: string; type: string; address: string; contactNumber?: string | null; distanceKm?: number | null };
type Donation = { id: string; bloodGroup?: string | null; status: string; remarks?: string | null; createdAt: string; donor: { id: string; name: string; phone?: string }; providerInstitution?: Facility | null };
const groupLabel = (value: string) => value.replace("_POSITIVE", "+").replace("_NEGATIVE", "−");
const localToday = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`; };

function DonationProgress({ status }: { status: string }) {
	if (status === "REJECTED" || status === "CANCELLED") return <p className="blood-donation-terminal">{status === "REJECTED" ? "The institution declined this donor interest." : "The donor withdrew this interest."}</p>;
	const activeStep = status === "COMPLETED" ? 2 : status === "ACCEPTED" ? 1 : 0;
	const steps = ["Interest submitted", "Institution approved", "Added to inventory"];
	return <ol className="blood-donation-progress" aria-label={`Donation workflow, ${status.toLowerCase()}`}>
		{steps.map((step, index) => <li key={step} className={index < activeStep ? "completed" : index === activeStep ? "current" : ""}><span aria-hidden="true">{index < activeStep ? "✓" : index + 1}</span><small>{step}</small></li>)}
	</ol>;
}

export function BloodDonationWorkspace({ embedded = false }: { embedded?: boolean }) {
	const PageWrapper = embedded ? "div" : "main";
	const session = getCurrentSession();
	const isInstitution = session?.user.principalType === "INSTITUTION";
	const isAdmin = session?.user.role === "ADMINISTRATOR";
	const canPledge = session?.user.role === "USER";
	const canReview = Boolean(isInstitution || isAdmin);
	const recordsEndpoint = canReview ? "/api/blood-donations/queue" : "/api/blood-donations/mine";
	const [facilities, setFacilities] = useState<Facility[]>([]);
	const [facilityMode, setFacilityMode] = useState<"none" | "nearby" | "all" | "area">("none");
	const [areaQuery, setAreaQuery] = useState("");
	const [facilityLoading, setFacilityLoading] = useState(false);
	const [facilityMessage, setFacilityMessage] = useState("");
	const [donations, setDonations] = useState<Donation[]>([]);
	const [institutionId, setInstitutionId] = useState("");
	const [bloodGroup, setBloodGroup] = useState<string>(BLOOD_GROUPS[0]);
	const [verifiedGroups, setVerifiedGroups] = useState<Record<string, string>>({});
	const [expiryDates, setExpiryDates] = useState<Record<string, string>>({});
	const [remarks, setRemarks] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const donationData = await requestApi<{ donations: Donation[] }>(recordsEndpoint);
			setDonations(donationData.donations);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not load blood donation records.");
		} finally { setLoading(false); }
	}, [recordsEndpoint]);

	useEffect(() => { void load(); }, [load]);

	async function searchFacilities(options: { latitude?: number; longitude?: number; radiusKm?: number; q?: string }, mode: "nearby" | "all" | "area") {
		setFacilityLoading(true); setFacilityMessage(""); setFacilities([]); setFacilityMode(mode); setError("");
		try {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(options)) if (value !== undefined) query.set(key, String(value));
			const suffix = query.size ? `?${query.toString()}` : "";
			const data = await requestApi<{ institutions: Facility[] }>(`/api/blood-donations/facilities${suffix}`);
			setFacilities(data.institutions);
			setFacilityMode(mode);
			setInstitutionId((current) => data.institutions.some((item) => item.id === current) ? current : data.institutions[0]?.id ?? "");
			setFacilityMessage(data.institutions.length ? mode === "nearby" ? "Nearby blood services within 50 km, sorted by distance." : mode === "area" ? "Blood services matching the locality in their name or address." : "Showing all active blood services. Location was not used." : mode === "nearby" ? "No mapped blood service was found within 50 km. Try searching a locality or showing all services." : mode === "area" ? "No blood service matched that locality. Try a broader area or show all services." : "No active blood services are available right now.");
		} catch (cause) {
			setFacilities([]); setFacilityMode(mode);
			setFacilityMessage(cause instanceof Error ? cause.message : "Could not load blood services.");
		} finally { setFacilityLoading(false); }
	}

	function findNearbyFacilities() {
		if (!window.isSecureContext && location.hostname !== "localhost") { setFacilityMessage("Location requires HTTPS or localhost. Search by locality or show all services instead."); return; }
		if (!navigator.geolocation) { setFacilityMessage("This browser does not support location. Search by locality or show all services instead."); return; }
		setFacilityMode("nearby"); setFacilities([]); setFacilityLoading(true); setFacilityMessage("Waiting for location permission…");
		navigator.geolocation.getCurrentPosition(
			(position) => void searchFacilities({ latitude: position.coords.latitude, longitude: position.coords.longitude, radiusKm: 50 }, "nearby"),
			(cause) => { setFacilityLoading(false); setFacilityMode("none"); setFacilityMessage(cause.code === cause.PERMISSION_DENIED ? "Location permission was denied. Search by locality or show all services; your location is optional." : cause.code === cause.TIMEOUT ? "Location lookup timed out. Try again, search by locality, or show all services." : "Could not determine your location. Search by locality or show all services instead."); },
			{ timeout: 10000, maximumAge: 300000 },
		);
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault(); setBusy("submit"); setError(""); setNotice("");
		try {
			await requestApi("/api/blood-donations", { method: "POST", body: JSON.stringify({ institutionId, bloodGroup, remarks: remarks.trim() || undefined }) });
			setRemarks(""); setNotice("Your donor interest was sent to the selected blood service."); await load();
		} catch (cause) { setError(cause instanceof ApiFailure ? cause.message : "Could not submit donor interest."); }
		finally { setBusy(""); }
	}

	async function updateStatus(item: Donation, status: string, completion?: { expiryDate: string; verifiedBloodGroup: string }) {
		if (status === "COMPLETED" && (!completion?.expiryDate || !completion.verifiedBloodGroup)) { setError("Confirm the screened blood group and unit expiry date before adding stock."); return; }
		setBusy(item.id); setError(""); setNotice("");
		try { await requestApi(`/api/blood-donations/${item.id}/status`, { method: "PATCH", body: JSON.stringify({ status, ...completion }) }); setNotice(status === "COMPLETED" ? "Donation confirmed and 1 Whole Blood unit added to institutional inventory." : `Donation interest marked ${status.toLowerCase()}.`); await load(); }
		catch (cause) { setError(cause instanceof ApiFailure ? cause.message : "Could not update donation status."); }
		finally { setBusy(""); }
	}

	async function cancel(item: Donation) {
		setBusy(item.id); setError(""); setNotice("");
		try { await requestApi(`/api/blood-donations/${item.id}/cancel`, { method: "POST" }); setNotice("Your donor interest was withdrawn."); await load(); }
		catch (cause) { setError(cause instanceof ApiFailure ? cause.message : "Could not withdraw donor interest."); }
		finally { setBusy(""); }
	}

	return <PageWrapper className={`${embedded ? "blood-service-panel" : "page-stack"} blood-donation-workspace`}>
		{!embedded && <header className="page-heading"><div><span className="eyebrow">BLOOD DONATION</span><h1>{isInstitution ? "Donor coordination" : isAdmin ? "Blood donation oversight" : "Donate blood"}</h1><p>{isInstitution ? "Review donor interest and confirm outcomes through your institution’s blood service." : isAdmin ? "Monitor donation interest across the platform and support institution review." : "Register your interest with an active blood service. The institution will confirm eligibility and collection arrangements."}</p></div></header>}
		{canPledge && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">DONOR INTEREST</span><h2>Register to donate blood</h2><p>This records interest only. It does not replace medical screening or add blood to inventory.</p></div><span className="metric-icon teal"><HandHeart size={20}/></span></div>
			<div className="blood-donation-facility-search"><div><strong>Choose a blood service</strong><small>Location is optional. We only use it if you choose nearby search.</small></div><div className="blood-donation-facility-actions"><button type="button" className="button" disabled={facilityLoading} onClick={findNearbyFacilities}><MapPin size={15}/>{facilityLoading && facilityMode === "nearby" ? "Finding nearby…" : "Use my location"}</button><button type="button" className="button" disabled={facilityLoading} onClick={() => void searchFacilities({}, "all")}>Show all services</button></div><form className="blood-donation-area-search" onSubmit={(event) => { event.preventDefault(); const query = areaQuery.trim(); if (query) void searchFacilities({ q: query }, "area"); }}><input aria-label="Search blood services by locality" placeholder="Enter a city or locality" value={areaQuery} onChange={(event) => setAreaQuery(event.target.value)} maxLength={100}/><button type="submit" className="button quiet" disabled={!areaQuery.trim() || facilityLoading}><Search size={15}/>Search area</button></form>{facilityMessage && <p className="blood-donation-facility-message" role="status">{facilityMessage}</p>}</div>
			{facilityMode !== "none" && facilities.length > 0 ? <form className="inventory-filter-form" onSubmit={(event) => void submit(event)}>
				<label>Blood service<select required value={institutionId} onChange={(event) => setInstitutionId(event.target.value)}>{facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name} · {facility.type.replaceAll("_", " ")}{facility.distanceKm != null ? ` · ${facility.distanceKm} km` : ""}</option>)}</select><small>{facilityMode === "all" ? "All active services, sorted by name." : facilityMode === "area" ? "Check the address before travelling." : "Distance is approximate; confirm hours and availability with the facility."}</small></label>
				<label>Your blood group<select required value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}>{BLOOD_GROUPS.map((group) => <option key={group} value={group}>{groupLabel(group)}</option>)}</select><small>Self-reported; the blood service will verify it.</small></label>
				<label className="profile-wide">Note for the blood service (optional)<input maxLength={300} value={remarks} onChange={(event) => setRemarks(event.target.value)} placeholder="Share a preferred time or a short coordination note"/></label>
				<div className="profile-wide profile-actions"><button className="button primary" disabled={Boolean(busy) || !institutionId}>{busy === "submit" ? "Submitting…" : "Register donor interest"}</button></div>
			</form> : facilityMode !== "none" && !facilityLoading && facilities.length === 0 ? <div className="empty-state"><h3>No services match this search</h3><p>Try a broader locality or show all active services.</p></div> : facilityMode === "none" ? <div className="empty-state blood-donation-facility-prompt"><h3>Find a blood service</h3><p>Choose nearby search, search a locality, or view all active services to continue.</p></div> : facilityLoading ? <p className="empty">Finding blood services…</p> : null}
		</section>}
		{error && <p className="error" role="alert">{error}</p>}{notice && <p className="inventory-notice" role="status">{notice}</p>}
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">{isInstitution ? "INSTITUTION QUEUE" : isAdmin ? "PLATFORM DONATION RECORDS" : "YOUR DONATION INTEREST"}</span><h2>{isInstitution ? "Donors to review" : isAdmin ? "Blood donation activity" : "Your donor interests"}</h2><p>{isInstitution ? "Accept interest to coordinate screening, reject when the service cannot proceed, and mark completed only after collection." : "Follow each record from institutional review through completion."}</p></div><button type="button" className="button quiet" onClick={() => void load()} disabled={loading}>Refresh</button></div>
			{loading ? <p className="empty">Loading donation records…</p> : donations.length === 0 ? <div className="empty-state"><span className="metric-icon teal"><HeartPulse size={20}/></span><h3>No blood donation records yet</h3><p>{canPledge ? "Your donor interests will appear here after you register." : isAdmin ? "Donation interests will appear here as users register." : "New donor interests for your institution will appear here."}</p></div> : <div className="organ-personal-record-list">{donations.map((item) => <article className="organ-personal-record" key={item.id}><div className="panel-heading"><div><span className="eyebrow">{item.providerInstitution?.name ?? "Blood service"}</span><h3>{canPledge ? `Blood group ${item.bloodGroup ? groupLabel(item.bloodGroup) : "not provided"}` : item.donor.name}</h3><p>{new Date(item.createdAt).toLocaleString()} · {item.remarks || (canPledge ? "No note provided" : "No donor note provided")}</p></div><span className={`pill ${item.status.toLowerCase()}`}>{item.status.replaceAll("_", " ")}</span></div>
					<DonationProgress status={item.status}/>
					{!canPledge && <p>{item.bloodGroup && <>Self-reported blood group: <strong>{groupLabel(item.bloodGroup)}</strong> · </>}Donor contact: <strong>{item.donor.phone || "Not provided"}</strong></p>}
					{canReview && item.status === "PENDING" && <div className="latest-request-actions"><button className="button primary" disabled={busy === item.id} onClick={() => void updateStatus(item, "ACCEPTED")}>Approve donor interest</button><button className="button" disabled={busy === item.id} onClick={() => void updateStatus(item, "REJECTED")}>Decline</button></div>}
					{canReview && item.status === "ACCEPTED" && <div className="blood-donation-completion"><label>Verified blood group<select value={verifiedGroups[item.id] ?? item.bloodGroup ?? BLOOD_GROUPS[0]} onChange={(event) => setVerifiedGroups((current) => ({ ...current, [item.id]: event.target.value }))}>{BLOOD_GROUPS.map((group) => <option key={group} value={group}>{groupLabel(group)}</option>)}</select><small>Confirm the group after screening.</small></label><label>Unit expiry date<input required type="date" min={localToday()} value={expiryDates[item.id] ?? ""} onChange={(event) => setExpiryDates((current) => ({ ...current, [item.id]: event.target.value }))}/><small>Use the date on the screened unit label.</small></label><button className="button primary" disabled={busy === item.id} onClick={() => void updateStatus(item, "COMPLETED", { expiryDate: expiryDates[item.id] ?? "", verifiedBloodGroup: verifiedGroups[item.id] ?? item.bloodGroup ?? BLOOD_GROUPS[0] })}>Confirm screening & add 1 unit</button><p>Completion adds one verified Whole Blood unit to this institution’s inventory.</p></div>}
					{canPledge && (item.status === "PENDING" || item.status === "ACCEPTED") && <div className="latest-request-actions"><button className="button" disabled={busy === item.id} onClick={() => void cancel(item)}>Withdraw interest</button></div>}
				</article>)}</div>}
		</section>
	</PageWrapper>;
}

