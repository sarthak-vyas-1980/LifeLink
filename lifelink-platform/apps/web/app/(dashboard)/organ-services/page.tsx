"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, HeartPulse, ShieldCheck } from "lucide-react";
import { requestApi } from "../../../lib/api-client";

type Institution = { id: string; name: string; type: string; address?: string | null };
type Donor = { id: string; reference: string; donorType: string; bloodGroup?: string | null; consentStatus: string; authorizationStatus: string; status: string; institution: { id: string; name: string }; consents: Array<{ status: string; consentType: string; recordedAt?: string | null; notes?: string | null }> };
type Recipient = { id: string; reference: string; organType: string; bloodGroup?: string | null; priority: string; status: string; institution: { name: string }; requirement?: { urgency?: string | null; requiredBy?: string | null }; matches: Array<{ status: string; coordinationScore: number; matchReasons: string[]; organ: { reference: string; organType: string; status: string } }>; offers: Array<{ reference: string; status: string; responseDeadline: string }> };
const organTypes = ["KIDNEY", "LIVER", "HEART", "LUNG", "PANCREAS", "INTESTINE", "CORNEA", "BONE_MARROW", "OTHER"];
const bloodGroups = ["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"];

export default function OrganServicesPage() {
	const [mode, setMode] = useState<"choose" | "donate" | "receive">("choose");
	const [institutions, setInstitutions] = useState<Institution[]>([]);
	const [servicesLoading, setServicesLoading] = useState(true);
	const [servicesError, setServicesError] = useState("");
	const [donor, setDonor] = useState<Donor | null>(null);
	const [recipients, setRecipients] = useState<Recipient[]>([]);
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
		try {
			const data = await requestApi<{ institutions: Institution[] }>("/api/organs/me/organ-services");
			setInstitutions(data.institutions);
			setDonorCentre((current) => data.institutions.some((item) => item.id === current) ? current : data.institutions[0]?.id ?? "");
			setRecipientCentre((current) => data.institutions.some((item) => item.id === current) ? current : data.institutions[0]?.id ?? "");
		} catch (reason) {
			setServicesError((reason as Error).message);
		} finally {
			setServicesLoading(false);
		}
	}, []);

	const refresh = useCallback(async () => {
		const [donorResult, recipientResult] = await Promise.allSettled([
			requestApi<{ donor: Donor | null }>("/api/organs/me/donor"),
			requestApi<{ recipients: Recipient[] }>("/api/organs/me/recipients"),
		]);
		if (donorResult.status === "fulfilled") setDonor(donorResult.value.donor);
		if (recipientResult.status === "fulfilled") setRecipients(recipientResult.value.recipients);
		const failures = [donorResult, recipientResult].filter((result) => result.status === "rejected");
		if (failures.length) {
			const reason = failures[0].status === "rejected" ? failures[0].reason : undefined;
			setError(`Your request may be saved, but the status could not be refreshed. ${reason instanceof Error ? reason.message : "Try refreshing the page."}`);
		}
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
	const withdrawDonor = async () => {
		setBusy(true); setError(""); setMessage("");
		try { await requestApi("/api/organs/me/donor/withdraw", { method: "POST" }); setMessage("Your donor interest has been withdrawn."); await refresh(); }
		catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
	};
	const submitRecipient = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault(); setBusy(true); setError(""); setMessage("");
		try {
			await requestApi("/api/organs/me/recipients", { method: "POST", body: JSON.stringify({ institutionId: recipientCentre, organType, priority, ...(recipientBloodGroup ? { bloodGroup: recipientBloodGroup } : {}), ...(urgency.trim() ? { urgency: urgency.trim() } : {}), ...(requiredBy ? { requiredBy: new Date(requiredBy).toISOString() } : {}) }) });
			setMessage("Your recipient requirement has been registered with the selected organ service."); setUrgency(""); setRequiredBy(""); await refresh();
		} catch (reason) { setError((reason as Error).message); } finally { setBusy(false); }
	};
	const serviceSelect = (value: string, onChange: (next: string) => void) => <select required value={value} onChange={(event) => onChange(event.target.value)}><option value="">Select an organ service</option>{institutions.map((item) => <option key={item.id} value={item.id}>{item.name}{item.address ? ` · ${item.address}` : ""}</option>)}</select>;

	return <main className="page-stack organ-workspace"><header className="page-heading"><div><span className="eyebrow">PERSONAL ORGAN SERVICES</span><h1>Organ donation and receiving</h1><p>Choose how you want to continue.</p></div><HeartPulse size={34} color="var(--teal)"/></header>
		{error && <p className="error" role="alert">{error}</p>}{message && <p className="success" role="status">{message}</p>}
		{mode === "choose" && <section className="panel organ-choice"><span className="eyebrow">HOW CAN WE HELP?</span><h2>Select an option</h2><div className="organ-choice-actions"><button className="organ-choice-button" onClick={() => { setMessage(""); setError(""); setMode("donate"); }}><HeartPulse/><strong>Donate</strong><small>Register your interest in donating an organ</small><ArrowUpRight/></button><button className="organ-choice-button" onClick={() => { setMessage(""); setError(""); setMode("receive"); }}><HeartPulse/><strong>Receive</strong><small>Register an organ or tissue requirement</small><ArrowUpRight/></button></div></section>}
		{mode !== "choose" && <><button className="text-button" onClick={() => { setMode("choose"); setMessage(""); setError(""); }}><ArrowLeft size={15}/> Choose Donate or Receive</button>
			<section className="panel organ-provider-panel"><div className="panel-heading"><div><span className="eyebrow">ACTIVE ORGAN SERVICES</span><h2>Choose a participating institution</h2><p>Select a hospital or organ centre to submit your request for professional review.</p></div><button className="button quiet" type="button" onClick={() => void loadServices()} disabled={servicesLoading}>{servicesLoading ? "Refreshing…" : "Refresh services"}</button></div>
				{servicesLoading ? <p className="empty">Loading active organ services…</p> : servicesError ? <div><p className="error" role="alert">{servicesError}</p><button className="button" type="button" onClick={() => void loadServices()}>Try again</button></div> : institutions.length === 0 ? <div className="empty-state"><h3>No active organ services found</h3><p>Newly registered institutions appear after they are active and have organ coordination enabled.</p><a className="text-button" href="/map">View institutions on the map <ArrowUpRight size={14}/></a></div> : <div className="organ-provider-list">{institutions.map((item) => <article className="organ-provider-card" key={item.id}><span className="metric-icon gold"><HeartPulse size={18}/></span><div><strong>{item.name}</strong><small>{item.type.replaceAll("_", " ")}{item.address ? ` · ${item.address}` : ""}</small></div><span className="provider-active">Active</span></article>)}</div>}
			</section>
			{mode === "donate" && <section className="panel organ-personal-card"><span className="eyebrow">DONOR INTEREST</span><h2>Register donor interest</h2><p>This records interest only. The selected organ service must review it and verify consent and authorization.</p>{donor ? <><div className="organ-personal-record"><strong>{donor.reference}</strong><span>{donor.institution.name}</span><span>Organ interest: {donor.consents[0]?.notes ?? "See organ service for details"}</span><span>Consent review: {donor.consentStatus.replaceAll("_", " ").toLowerCase()}</span><span>Authorization: {donor.authorizationStatus.replaceAll("_", " ").toLowerCase()}</span></div>{donor.consentStatus !== "WITHDRAWN" && <button className="button danger" disabled={busy} onClick={() => void withdrawDonor()}>Withdraw my interest</button>}</> : <form className="organ-create-form" onSubmit={(event) => void submitDonor(event)}><label>Organ service{serviceSelect(donorCentre, setDonorCentre)}</label><label>Donation interest<select value={donorType} onChange={(event) => setDonorType(event.target.value)}><option value="LIVING">Living donation interest</option><option value="POSTHUMOUS_INTENT">Posthumous donation interest</option></select></label><fieldset className="organ-type-choices"><legend>Organs or tissues you are interested in</legend>{organTypes.map((value) => <label key={value}><input type="checkbox" checked={donorOrgans.includes(value)} onChange={(event) => setDonorOrgans((current) => event.target.checked ? [...current, value] : current.filter((item) => item !== value))}/>{value.replaceAll("_", " ")}</label>)}</fieldset><label>Blood group (optional)<select value={donorBloodGroup} onChange={(event) => setDonorBloodGroup(event.target.value)}><option value="">Prefer not to provide</option>{bloodGroups.map((value) => <option key={value}>{value.replaceAll("_", " ")}</option>)}</select></label><button className="button primary" disabled={busy || !donorCentre || donorOrgans.length === 0}>{busy ? "Submitting…" : "Register donor interest"}</button></form>}</section>}
			{mode === "receive" && <><section className="panel organ-personal-card"><span className="eyebrow">RECIPIENT REQUIREMENT</span><h2>Register an organ need</h2><p>Share a requirement with a receiving organ service. Professionals review the information and manage any coordination.</p><form className="organ-create-form" onSubmit={(event) => void submitRecipient(event)}><label>Receiving organ service{serviceSelect(recipientCentre, setRecipientCentre)}</label><label>Organ or tissue<select value={organType} onChange={(event) => setOrganType(event.target.value)}>{organTypes.map((value) => <option key={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Blood group (optional)<select value={recipientBloodGroup} onChange={(event) => setRecipientBloodGroup(event.target.value)}><option value="">Not provided</option>{bloodGroups.map((value) => <option key={value}>{value.replaceAll("_", " ")}</option>)}</select></label><label>Coordination priority<select value={priority} onChange={(event) => setPriority(event.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option><option value="EMERGENCY">Emergency</option></select></label><label>Urgency note (optional)<input maxLength={80} value={urgency} onChange={(event) => setUrgency(event.target.value)} placeholder="Short operational note"/></label><label>Required by (optional)<input type="datetime-local" value={requiredBy} onChange={(event) => setRequiredBy(event.target.value)}/></label><button className="button primary" disabled={busy || !recipientCentre}>{busy ? "Submitting…" : "Register recipient requirement"}</button></form></section>{recipients.length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">YOUR RECIPIENT RECORDS</span><h2>Coordination updates</h2></div></div><div className="organ-personal-record-list">{recipients.map((item) => <article className="organ-personal-record" key={item.id}><strong>{item.reference} · {item.organType.replaceAll("_", " ")}</strong><span>{item.institution.name} · {item.status === "PENDING_REVIEW" ? "awaiting institution approval" : item.status === "ACTIVE" ? "approved for coordination" : item.status === "MATCHED" ? "offer accepted; coordination in progress" : item.status.toLowerCase()} · {item.priority.toLowerCase()} priority</span><span>Blood group: {item.bloodGroup?.replaceAll("_", " ") ?? "not provided"}</span>{item.matches.length > 0 && <div><b>Potential coordination matches</b><ul>{item.matches.map((match, index) => <li key={`${match.organ.reference}-${index}`}>{match.organ.reference} · {match.status.toLowerCase()} · score {match.coordinationScore.toFixed(2)} <small>({match.matchReasons.join("; ")})</small></li>)}</ul></div>}{["PENDING_REVIEW", "ACTIVE"].includes(item.status) && <button className="button danger" disabled={busy} onClick={() => void cancelRecipient(item.id)}>Cancel request</button>}{item.offers.length > 0 && <div><b>Offers for professional review</b><ul>{item.offers.map((offer) => <li key={offer.reference}>{offer.reference} · {offer.status.toLowerCase()} · response by {new Date(offer.responseDeadline).toLocaleString()}</li>)}</ul></div>}</article>)}</div></section>}</>}
			<p className="organ-disclaimer"><ShieldCheck size={14}/> LifeLink records coordination information. Donor consent, clinical eligibility, compatibility, and allocation are determined by authorized professionals.</p>
		</>}
		{mode === "choose" && recipients.length > 0 && <section className="panel"><span className="eyebrow">YOUR RECIPIENT RECORDS</span><h2>Coordination updates</h2><p>Your recipient records are available after selecting Receive.</p></section>}
		<a className="text-button" href="/map">Find care institutions <ArrowUpRight size={14}/></a>
	</main>;
}
