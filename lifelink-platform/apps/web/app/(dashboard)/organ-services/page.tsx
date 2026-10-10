"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, HeartPulse, ShieldCheck } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { donorWorkflowStage, recipientWorkflowStage, DonorWorkflowProgress, WorkflowPath, WorkflowProgress } from "../../../components/organ/workflow-progress";
import { PersonalOrganActivitySnapshot } from "../../../components/organ/personal-activity-snapshot";

type Institution = { id: string; name: string; type: string; address?: string | null; distanceKm: number | null };
type Donor = { id: string; reference: string; organType: string; donorType: string; bloodGroup?: string | null; consentStatus: string; authorizationStatus: string; status: string; createdAt: string; updatedAt: string; institution: { id: string; name: string }; consents: Array<{ status: string; consentType: string; recordedAt?: string | null; notes?: string | null }>; organs?: Array<{ reference: string; organType: string; status: string; matches: Array<{ status: string }>; offers: Array<{ status: string }>; procurements: Array<{ status: string }> }> };
type Recipient = { id: string; reference: string; organType: string; bloodGroup?: string | null; priority: string; status: string; registrationDate: string; updatedAt: string; institution: { name: string }; requirement?: { urgency?: string | null; requiredBy?: string | null }; matches: Array<{ status: string; matchReasons: string[]; organ: { reference: string; organType: string; status: string } }>; offers: Array<{ id: string; reference: string; status: string; responseDeadline: string; organ?: { status: string; procurements: Array<{ status: string }> } }> };
type Consent = { id: string; status: string; requestedAt: string; respondedAt?: string | null; donor: { reference: string; organType: string; institution: { name: string } } };
const organTypes = ["KIDNEY", "LIVER", "HEART", "LUNG", "PANCREAS", "INTESTINE", "CORNEA", "BONE_MARROW", "OTHER"];
const bloodGroups = ["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"];

export default function OrganServicesPage() {
	const [mode, setMode] = useState<"choose" | "donate" | "receive">("choose");
	const [institutions, setInstitutions] = useState<Institution[]>([]);
	const [servicesLoading, setServicesLoading] = useState(true);
	const [servicesError, setServicesError] = useState("");
	const [locationMessage, setLocationMessage] = useState("");
	const [donors, setDonors] = useState<Donor[]>([]);
	const [recipients, setRecipients] = useState<Recipient[]>([]);
	const [consents, setConsents] = useState<Consent[]>([]);
	const [donorType, setDonorType] = useState("LIVING");
	const [donorOrgans, setDonorOrgans] = useState<string[]>([]);
	const [donorCentre, setDonorCentre] = useState("");
	const [donorBloodGroup, setDonorBloodGroup] = useState("");
	const [recipientCentre, setRecipientCentre] = useState("");
	const [organType, setOrganType] = useState("KIDNEY");
	const [recipientBloodGroup, setRecipientBloodGroup] = useState("");
	const [priority, setPriority] = useState("NORMAL");
	const [requiredBy, setRequiredBy] = useState("");
	const [urgency, setUrgency] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const loadServices = useCallback(async () => {
		setServicesLoading(true);
		setServicesError("");
		setLocationMessage("");
		try {
			const fetchInstitutions = (position?: GeolocationPosition) => {
				const query = position ? `?latitude=${position.coords.latitude}&longitude=${position.coords.longitude}` : "";
				return requestApi<{ institutions: Institution[] }>(`/api/organs/me/organ-services${query}`);
			};
			const data = await new Promise<{ institutions: Institution[] }>((resolve, reject) => {
				if (!navigator.geolocation) { setLocationMessage("This browser does not provide location access. Distances will show as —."); void fetchInstitutions().then(resolve, reject); return; }
				navigator.geolocation.getCurrentPosition((position) => { void fetchInstitutions(position).then(resolve, reject); }, (locationError) => { setLocationMessage(locationError.code === locationError.PERMISSION_DENIED ? "Location access is blocked. Allow location for this site in your browser settings, then select Update distance." : locationError.code === locationError.TIMEOUT ? "Location lookup timed out. Select Update distance to try again." : "Your location could not be determined. Check browser location access and try again."); void fetchInstitutions().then(resolve, reject); }, { timeout: 10000, maximumAge: 300000 });
			});
			setInstitutions([...data.institutions].sort((a, b) => (a.distanceKm ?? Number.POSITIVE_INFINITY) - (b.distanceKm ?? Number.POSITIVE_INFINITY)));
			setDonorCentre((current) => data.institutions.some((item) => item.id === current) ? current : data.institutions[0]?.id ?? "");
			setRecipientCentre((current) => data.institutions.some((item) => item.id === current) ? current : data.institutions[0]?.id ?? "");
		} catch (reason) {
			setServicesError((reason as Error).message);
		} finally {
			setServicesLoading(false);
		}
	}, []);

	const refresh = useCallback(async () => {
		const [donorResult, recipientResult, consentResult] = await Promise.allSettled([
			requestApi<{ donors: Donor[] }>("/api/organs/me/donor"),
			requestApi<{ recipients: Recipient[] }>("/api/organs/me/recipients"),
			requestApi<{ consents: Consent[] }>("/api/organ-consents/me"),
		]);
		if (donorResult.status === "fulfilled") setDonors(donorResult.value.donors);
		if (recipientResult.status === "fulfilled") setRecipients(recipientResult.value.recipients);
		if (consentResult.status === "fulfilled") setConsents(consentResult.value.consents);
		// Consent history is supplemental; a failed consent fetch must not make
		// the donor or recipient registration workflow appear unavailable.
		const failures = [donorResult, recipientResult].filter((result) => result.status === "rejected");
		if (failures.length) {
			const reason = failures[0].status === "rejected" ? failures[0].reason : undefined;
			setError(`Your donor or recipient status could not be refreshed. ${reason instanceof Error ? reason.message : "Try refreshing the page."}`);
		} else setError("");
	}, []);

	useEffect(() => {
		void loadServices();
		void refresh();
	}, [loadServices, refresh]);

	const submitDonor = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault(); setBusy(true); setError(""); setMessage("");
		try {
			await requestApi("/api/organs/me/donor", { method: "POST", body: JSON.stringify({ institutionId: donorCentre, donorType, organTypes: donorOrgans, ...(donorBloodGroup ? { bloodGroup: donorBloodGroup } : {}) }) });
			setMessage("Your donor interest has been sent to the selected organ service for review.");
			await refresh();
		} catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
	};
	const cancelRecipient = async (id: string) => { setBusy(true); setError(""); setMessage(""); try { await requestApi(`/api/organs/me/recipients/${id}/cancel`, { method: "POST" }); setMessage("Your recipient request was cancelled."); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
	const respondOrganOffer = async (offerId: string, action: "ACCEPT" | "REJECT") => { setBusy(true); setError(""); setMessage(""); try { await requestApi(`/api/organs/me/offers/${offerId}/respond`, { method: "POST", body: JSON.stringify({ action }) }); setMessage(`Offer ${action.toLowerCase()}ed.`); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
	const withdrawDonor = async (donorId: string) => {
		setBusy(true); setError(""); setMessage("");
		try { await requestApi(`/api/organs/me/donor/${donorId}/withdraw`, { method: "POST" }); setMessage("Your donor interest has been withdrawn."); await refresh(); }
		catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
	};
	const respondConsent = async (id: string, action: "ACCEPT" | "DECLINE") => { setBusy(true); setError(""); try { await requestApi(`/api/organ-consents/${id}/respond`, { method: "POST", body: JSON.stringify({ action }) }); setMessage(`Consent ${action.toLowerCase()}ed.`); await refresh(); } catch (reason) { setError((reason as Error).message); } finally { setBusy(false); } };
	const submitRecipient = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault(); setBusy(true); setError(""); setMessage("");
		try {
			await requestApi("/api/organs/me/recipients", { method: "POST", body: JSON.stringify({ institutionId: recipientCentre, organType, priority, ...(recipientBloodGroup ? { bloodGroup: recipientBloodGroup } : {}), ...(urgency.trim() ? { urgency: urgency.trim() } : {}), ...(requiredBy ? { requiredBy: new Date(requiredBy).toISOString() } : {}) }) });
			setMessage("Your recipient requirement has been registered with the selected organ service."); setUrgency(""); setRequiredBy(""); await refresh();
		} catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
	};
	const activeDonorTypes = new Set(donors.filter((item) => ["REGISTERED", "ACTIVE"].includes(item.status)).map((item) => item.organType));
	const personalSnapshotMetrics = {
		donorRequests: donors.length,
		recipientRequests: recipients.length,
		awaitingReview: donors.filter((item) => item.authorizationStatus === "PENDING" || ["PENDING", "RECORDED"].includes(item.consentStatus)).length + recipients.filter((item) => item.status === "PENDING_REVIEW").length,
		activeRequests: donors.filter((item) => item.status === "ACTIVE").length + recipients.filter((item) => ["ACTIVE", "MATCHED"].includes(item.status)).length,
		potentialMatches: recipients.reduce((total, item) => total + item.matches.filter((match) => ["GENERATED", "UNDER_REVIEW", "SHORTLISTED", "CONVERTED_TO_OFFER"].includes(match.status)).length, 0),
		offersReceived: recipients.reduce((total, item) => total + item.offers.filter((offer) => !["REJECTED", "CANCELLED", "EXPIRED"].includes(offer.status)).length, 0),
		fulfilledRequests: donors.filter((item) => item.status === "FULFILLED").length + recipients.filter((item) => item.status === "CLOSED").length,
	};
	const recentActivity = [...donors.map((item) => ({ id: `donor-${item.id}`, label: `${item.organType.replaceAll("_", " ")} donation request Â· ${item.status.replaceAll("_", " ").toLowerCase()}`, at: item.updatedAt, kind: "donate" as const })), ...recipients.map((item) => ({ id: `recipient-${item.id}`, label: `${item.organType.replaceAll("_", " ")} recipient request Â· ${item.status.replaceAll("_", " ").toLowerCase()}`, at: item.updatedAt, kind: "receive" as const })), ...consents.map((item) => ({ id: `consent-${item.id}`, label: `Consent ${item.status.toLowerCase()} Â· ${item.donor.organType.replaceAll("_", " ")}`, at: item.respondedAt ?? item.requestedAt, kind: "donate" as const }))].filter((item) => item.at).sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 5);
	const latestRequests = [...donors.map((item) => ({ id: item.id, kind: "donate" as const, reference: item.reference, organType: item.organType, institution: item.institution.name, updatedAt: item.updatedAt, detail: `Donation interest Â· ${item.consentStatus.replaceAll("_", " ").toLowerCase() } consent`, stage: donorWorkflowStage(item) })), ...recipients.map((item) => ({ id: item.id, kind: "receive" as const, reference: item.reference, organType: item.organType, institution: item.institution.name, updatedAt: item.updatedAt, detail: `${item.priority.toLowerCase()} priority Â· ${item.matches.length} potential matches Â· ${item.offers.length} offers`, stage: recipientWorkflowStage(item) }))].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()).slice(0, 5);
	const serviceSelect = (value: string, onChange: (next: string) => void) => <><select required value={value} onChange={(event) => onChange(event.target.value)} disabled={servicesLoading || institutions.length === 0}><option value="">Select an organ service</option>{institutions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.type.replaceAll("_", " ")} · {item.distanceKm === null ? "—" : `${item.distanceKm.toFixed(1)} km away`}</option>)}</select>{institutions.find((item) => item.id === value)?.address && <small className="organ-service-address">{institutions.find((item) => item.id === value)?.address}</small>}<small className="service-distance-note">{servicesLoading ? "Finding organ services near you…" : institutions.some((item) => item.distanceKm !== null) ? "Distance from your current location · nearest services first" : locationMessage || "Distance unavailable — allow location access and update distance."}<button type="button" className="text-button" onClick={() => void loadServices()} disabled={servicesLoading}>{servicesLoading ? "Updating…" : "Update distance"}</button></small>{servicesError && <small className="error" role="alert">{servicesError}</small>}</>;

	return <main className="page-stack organ-workspace"><header className="page-heading"><div><span className="eyebrow">PERSONAL ORGAN SERVICES</span><h1>Organ coordination</h1><p>See your latest requests, follow each step, and choose how to continue.</p></div><HeartPulse size={34} color="var(--teal)"/></header>
		<div className="organ-services-toolbar"><div className="organ-mode-switch" role="group" aria-label="Choose organ service"><button type="button" aria-pressed={mode === "donate"} className={mode === "donate" ? "selected" : ""} onClick={() => { setError(""); setMessage(""); setMode("donate"); }}><HeartPulse size={16}/>Donate</button><button type="button" aria-pressed={mode === "receive"} className={mode === "receive" ? "selected" : ""} onClick={() => { setError(""); setMessage(""); setMode("receive"); }}><HeartPulse size={16}/>Receive</button></div>{mode !== "choose" && <button type="button" className="button" onClick={() => { setMode("choose"); setError(""); setMessage(""); }}>Overview</button>}</div>
		{error && <p className="error" role="alert">{error}</p>}{message && <p className="success" role="status">{message}</p>}
		{mode === "choose" && <WorkflowPath/>}
		{mode === "choose" && <PersonalOrganActivitySnapshot metrics={personalSnapshotMetrics}/>}
		{mode === "choose" && <section className="panel latest-request-overview"><div className="panel-heading"><div><span className="eyebrow">YOUR REQUESTS</span><h2>Latest updates</h2><p>Your five most recently updated requests. Open a request to see its workflow.</p></div></div>{latestRequests.length ? <div className="latest-request-list">{latestRequests.map((item) => <details className="latest-request-card" key={`${item.kind}-${item.id}`}><summary className="latest-request-summary"><span className={`request-kind ${item.kind}`}>{item.kind === "donate" ? "DONATION" : "RECIPIENT"}</span><span className="latest-request-main"><strong>{item.organType.replaceAll("_", " ")} · {item.reference}</strong><small>{item.institution} · {item.detail}</small></span><span className="latest-request-stage">{item.stage.replaceAll("_", " ").toLowerCase()}</span><span className="latest-request-toggle">View details <b>+</b></span></summary><div className="latest-request-expanded">{item.kind === "donate" ? <DonorWorkflowProgress stage={item.stage} donorType={donors.find((donor) => donor.id === item.id)?.donorType} compact/> : <WorkflowProgress stage={item.stage} compact/>}<div className="latest-request-expanded-footer"><small>Updated {new Date(item.updatedAt).toLocaleString()}</small><button className="text-button" onClick={() => setMode(item.kind)}>View all {item.kind === "donate" ? "donation" : "recipient"} requests</button></div></div></details>)}</div> : <div className="empty-state"><span className="empty-icon"><HeartPulse/></span><h3>No organ requests yet</h3><p>Choose Donate or Receive to submit a request to an active organ service.</p></div>}<div className="latest-request-actions"><button className="button" onClick={() => setMode("donate")}>All donation requests</button><button className="button" onClick={() => setMode("receive")}>All recipient requests</button></div></section>}{mode !== "choose" && <>

			{mode === "donate" && <>
                <section id="donate" className="panel organ-personal-card organ-donor-interest">
                    <div className="donor-interest-heading"><span className="metric-icon teal"><HeartPulse size={20}/></span><div><span className="eyebrow">DONOR INTEREST</span><h2>Register donor interest</h2><p>Choose a nearby service and the organs you wish to donate. The service will review your interest and request consent directly.</p></div></div>
                    <form className="organ-create-form organ-donor-form" onSubmit={(event) => void submitDonor(event)}><label className="organ-service-field">Organ service{serviceSelect(donorCentre, setDonorCentre)}</label><label>Donation interest<select value={donorType} onChange={(event) => setDonorType(event.target.value)}><option value="LIVING">Living donation interest</option><option value="POSTHUMOUS_INTENT">Posthumous donation interest</option></select></label><fieldset className="organ-type-choices"><legend>Organs or tissues you are interested in</legend>{organTypes.map((value) => <label key={value}><input type="checkbox" disabled={activeDonorTypes.has(value)} checked={donorOrgans.includes(value)} onChange={(event) => setDonorOrgans((current) => event.target.checked ? [...current, value] : current.filter((item) => item !== value))}/>{value.replaceAll("_", " ")}{activeDonorTypes.has(value) ? " Â· active request" : ""}</label>)}</fieldset><label>Blood group (optional)<select value={donorBloodGroup} onChange={(event) => setDonorBloodGroup(event.target.value)}><option value="">Prefer not to provide</option>{bloodGroups.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><button className="button primary" disabled={busy || !donorCentre || donorOrgans.length === 0}>{busy ? "Submittingâ€¦" : "Register donor interest"}</button></form>
                </section>
                <section className="panel organ-donation-history">
                    <div className="panel-heading"><div><span className="eyebrow">YOUR DONATION REQUESTS</span><h2>All donation requests</h2><p>Review the status and details of each donor interest you have submitted.</p></div></div>
                    {donors.length > 0 ? <div className="organ-personal-record-list">{donors.map((item) => <DonorRequestCard key={item.id} item={item} busy={busy} onWithdraw={() => void withdrawDonor(item.id)}/>)}</div> : <div className="empty-state"><h3>No donation requests yet</h3><p>After registering donor interest, your request will appear here.</p></div>}
                    {consents.some((item) => item.status === "PENDING") && <div className="organ-consent-requests"><h3>Consent requests</h3>{consents.filter((item) => item.status === "PENDING").map((item) => <article className="organ-personal-record" key={item.id}><strong>Consent requested · {item.donor.organType.replaceAll("_", " ")}</strong><span>{item.donor.institution.name} asks you to review consent.</span><span className="offer-actions"><button className="button small primary" disabled={busy} onClick={() => void respondConsent(item.id, "ACCEPT")}>Accept</button><button className="button small danger" disabled={busy} onClick={() => void respondConsent(item.id, "DECLINE")}>Decline</button></span></article>)}</div>}
                </section>
            </>}
			{mode === "receive" && <><section id="receive" className="panel organ-personal-card"><span className="eyebrow">RECIPIENT REQUIREMENT</span><h2>Register an organ need</h2><p>Share a requirement with a receiving organ service. Professionals review the information and manage any coordination.</p>{activeDonorTypes.has(organType) && <p className="error" role="status">You have an active donation request for this organ. Withdraw or complete it before requesting to receive the same organ.</p>}<form className="organ-create-form" onSubmit={(event) => void submitRecipient(event)}><label className="organ-service-field">Receiving organ service{serviceSelect(recipientCentre, setRecipientCentre)}</label><label>Organ or tissue<select value={organType} onChange={(event) => setOrganType(event.target.value)}>{organTypes.map((value) => <option key={value} value={value} disabled={activeDonorTypes.has(value)}>{value.replaceAll("_", " ")}{activeDonorTypes.has(value) ? " Â· active donation" : ""}</option>)}</select></label><label>Blood group (optional)<select value={recipientBloodGroup} onChange={(event) => setRecipientBloodGroup(event.target.value)}><option value="">Not provided</option>{bloodGroups.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Coordination priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></select></label><label>Urgency note (optional)<input maxLength={80} value={urgency} onChange={(event) => setUrgency(event.target.value)} placeholder="Short operational note"/></label><label>Required by (optional)<input type="datetime-local" value={requiredBy} onChange={(event) => setRequiredBy(event.target.value)}/></label><button className="button primary" disabled={busy || !recipientCentre || activeDonorTypes.has(organType)}>{busy ? "Submittingâ€¦" : "Register recipient requirement"}</button></form></section>{recipients.length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">YOUR RECIPIENT RECORDS</span><h2>Request history</h2></div></div><div className="organ-personal-record-list">{recipients.map((item) => <RecipientRequestCard key={item.id} item={item} busy={busy} onCancel={() => void cancelRecipient(item.id)} onRespond={(offerId, action) => void respondOrganOffer(offerId, action)}/>)}</div></section>}</>}
			<p className="organ-disclaimer"><ShieldCheck size={14}/> LifeLink records coordination information. Donor consent, clinical eligibility, compatibility, and allocation are determined by authorized professionals.</p>
		</>}
		<a className="text-button" href="/map">Find care institutions <ArrowUpRight size={14}/></a>
	</main>;
}

function RecipientRequestCard({ item, busy, onCancel, onRespond }: { item: Recipient; busy: boolean; onCancel: () => void; onRespond: (offerId: string, action: "ACCEPT" | "REJECT") => void }) {
	const [expanded, setExpanded] = useState(false);
	const statusText = item.status === "PENDING_REVIEW" ? "awaiting institution approval" : item.status === "ACTIVE" ? "approved for coordination" : item.status === "MATCHED" ? "offer accepted; coordination in progress" : item.status.replaceAll("_", " ").toLowerCase();
	return <article className={`organ-personal-record donor-request-card${expanded ? " expanded" : ""}`}>
		<button type="button" className="donor-request-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
			<span className="donor-request-primary"><strong>{item.reference} · {item.organType.replaceAll("_", " ")}</strong><small>{item.institution.name} · {statusText} · {item.priority.toLowerCase()} priority</small></span>
			<span className={`donor-request-status status-${item.status.toLowerCase()}`}>{item.status.replaceAll("_", " ").toLowerCase()}</span>
			<span className="donor-request-toggle">{expanded ? "Hide details −" : "View details +"}</span>
		</button>
		{expanded && <div className="donor-request-details">
			<div className="donor-request-facts"><span><small>Organ or tissue</small><strong>{item.organType.replaceAll("_", " ")}</strong></span><span><small>Blood group</small><strong>{item.bloodGroup?.replaceAll("_", " ") ?? "Not provided"}</strong></span><span><small>Priority</small><strong>{item.priority.toLowerCase()}</strong></span><span><small>Status</small><strong>{statusText}</strong></span><span><small>Registered</small><strong>{new Date(item.registrationDate).toLocaleString()}</strong></span><span><small>Last updated</small><strong>{new Date(item.updatedAt).toLocaleString()}</strong></span></div>
			<div className="donor-request-workflow"><span className="eyebrow">COORDINATION WORKFLOW</span><WorkflowProgress stage={recipientWorkflowStage(item)} compact/><p>{item.requirement?.urgency ? `Urgency note: ${item.requirement.urgency}` : "No urgency note provided."}{item.requirement?.requiredBy ? ` · Required by ${new Date(item.requirement.requiredBy).toLocaleString()}` : ""}</p></div>
			{item.matches.length > 0 && <div className="donor-request-workflow"><span className="eyebrow">POTENTIAL MATCHES</span>{item.matches.map((match, index) => <p key={`${match.organ.reference}-${index}`}><strong>{match.organ.reference}</strong> · {match.status.toLowerCase()} · {match.matchReasons.join("; ")}</p>)}</div>}
			{item.offers.length > 0 && <div className="donor-request-workflow"><span className="eyebrow">OFFERS</span>{item.offers.map((offer) => <div className="organ-offer-response" key={offer.reference}><p><strong>{offer.reference}</strong> · {offer.status.toLowerCase()} · response by {new Date(offer.responseDeadline).toLocaleString()}{offer.organ ? ` · organ ${offer.organ.status.toLowerCase()}` : ""}</p>{["SENT", "UNDER_REVIEW"].includes(offer.status) && <span className="offer-actions"><button className="button small primary" disabled={busy} onClick={() => onRespond(offer.id, "ACCEPT")}>Accept offer</button><button className="button small danger" disabled={busy} onClick={() => onRespond(offer.id, "REJECT")}>Reject offer</button></span>}</div>)}</div>}
			{["PENDING_REVIEW", "ACTIVE"].includes(item.status) && <button className="button danger donor-request-withdraw" disabled={busy} onClick={onCancel}>Cancel this request</button>}
		</div>}
	</article>;
}
function DonorRequestCard({ item, busy, onWithdraw }: { item: Donor; busy: boolean; onWithdraw: () => void }) {
	const [expanded, setExpanded] = useState(false);
	return <article className={`organ-personal-record donor-request-card${expanded ? " expanded" : ""}`}>
		<button type="button" className="donor-request-summary" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
			<span className="donor-request-primary"><strong>{item.organType.replaceAll("_", " ")} · {item.reference}</strong><small>{item.institution.name}</small></span>
			<span className={`donor-request-status status-${item.status.toLowerCase()}`}>{item.status.replaceAll("_", " ").toLowerCase()}</span>
			<span className="donor-request-toggle">{expanded ? "Hide details −" : "View details +"}</span>
		</button>
		{expanded && <div className="donor-request-details">
			<div className="donor-request-facts"><span><small>Donation type</small><strong>{item.donorType.replaceAll("_", " ").toLowerCase()}</strong></span><span><small>Blood group</small><strong>{item.bloodGroup?.replaceAll("_", " ") ?? "Not provided"}</strong></span><span><small>Consent</small><strong>{item.consentStatus.replaceAll("_", " ").toLowerCase()}</strong></span><span><small>Authorization</small><strong>{item.authorizationStatus.replaceAll("_", " ").toLowerCase()}</strong></span><span><small>Created</small><strong>{new Date(item.createdAt).toLocaleString()}</strong></span><span><small>Last updated</small><strong>{new Date(item.updatedAt).toLocaleString()}</strong></span></div>
			<div className="donor-request-workflow"><span className="eyebrow">COORDINATION WORKFLOW</span><DonorWorkflowProgress stage={donorWorkflowStage(item)} donorType={item.donorType} compact/>{item.organs?.length ? <div className="donor-request-organs">{item.organs.map((organ) => <div key={organ.reference}><strong>{organ.organType.replaceAll("_", " ")} · {organ.reference}</strong><small>{organ.status.replaceAll("_", " ").toLowerCase()} · {organ.matches.length} matches · {organ.offers.length} offers · {organ.procurements.map((procurement) => procurement.status.toLowerCase()).join(", ") || "procurement not started"}</small></div>)}</div> : <p>{donorWorkflowStage(item) === "ORGAN_REGISTRATION" ? "Authorization is complete. The organ service can register a specific organ case in Inventory." : "Awaiting institution review. The institution will contact you for consent and verification."}</p>}</div>
			{item.consents.length > 0 && <div className="donor-request-consents"><span className="eyebrow">CONSENT HISTORY</span>{item.consents.map((consent, index) => <p key={`${consent.consentType}-${index}`}>{consent.consentType.replaceAll("_", " ").toLowerCase()} · {consent.status.toLowerCase()}{consent.recordedAt ? ` · ${new Date(consent.recordedAt).toLocaleString()}` : ""}{consent.notes ? ` · ${consent.notes}` : ""}</p>)}</div>}
			{["REGISTERED", "ACTIVE"].includes(item.status) && <button className="button danger donor-request-withdraw" disabled={busy} onClick={onWithdraw}>Withdraw this request</button>}
		</div>}
	</article>;
}
