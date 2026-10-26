"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BLOOD_COMPONENTS, BLOOD_GROUPS } from "@lifelink/shared";
import { ApiFailure, requestApi, submitWorkflowAction } from "../../lib/api-client";
import { getCurrentSession } from "../../lib/auth";
import { subscribeToWorkflowEvents } from "../../lib/socket-client";

type BloodRequest = {
	id: string;
	bloodGroup: string;
	component: string;
	quantity: number;
	priority: string;
	location: string;
	latitude: number | null;
	longitude: number | null;
	radiusKm: number | null;
	status: string;
	requestDate?: string;
	contactNumber?: string;
};
type Candidate = { matchId?: string; institutionId: string; institutionName: string; unitsAvailable: number; distanceKm?: number; expiryDate: string | null; score: number; guaranteedFulfilment?: false };
type Offer = { matchId: string; status: string; providerInstitutionId: string | null; providerName: string; compatibilityScore: number | null; matchedAt: string; unitsAvailable: number; expiryDate: string | null; reservationExpiresAt: string | null };

const pretty = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const statusLabel = (value: string) => value === "UNDER_REVIEW" ? "Ready for Matching" : pretty(value);
const finalStatuses = ["FULFILLED", "CANCELLED", "EXPIRED", "REJECTED"];
const reopenableStatuses = ["SEARCHING_MATCHING", "INSTITUTIONS_NOTIFIED", "OFFERS_RECEIVED", "OFFER_EVALUATION", "RESERVED"];
const cancellableStatuses = ["CREATED", "UNDER_REVIEW", "SEARCHING_MATCHING", "INSTITUTIONS_NOTIFIED", "OFFERS_RECEIVED", "OFFER_EVALUATION", "RESERVED", "REOPENED"];

export function RequestForm({ onCreated }: { onCreated: (request: BloodRequest, candidates: Candidate[], retryRadius?: number) => void }) {
	const router = useRouter();
	const [emergency, setEmergency] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [form, setForm] = useState({ bloodGroup: "O_POSITIVE", component: "RED_BLOOD_CELLS", quantity: "1", priority: "NORMAL", location: "", contactNumber: "", latitude: "", longitude: "", radiusKm: "50" });
	const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));
	const locate = () => {
		setError("");
		if (!window.isSecureContext || !navigator.geolocation) { router.push("/profile#location-access"); return; }
		navigator.geolocation.getCurrentPosition(
			(position) => setForm((current) => ({ ...current, latitude: String(position.coords.latitude), longitude: String(position.coords.longitude) })),
			(cause) => {
				if (cause.code === cause.PERMISSION_DENIED) router.push("/profile#location-access");
				else setError(cause.code === cause.TIMEOUT ? "Location lookup timed out. Check your device location service and try again." : "Your device could not determine a location. Check device location services and try again.");
			},
			{ timeout: 10000, maximumAge: 0 },
		);
	};
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (Boolean(form.latitude) !== Boolean(form.longitude)) { setError("Enter both coordinates or leave both blank."); return; }
		setBusy(true);
		setError("");
		try {
			const hasCoordinates = Boolean(form.latitude && form.longitude);
			const body = { bloodGroup: form.bloodGroup, component: form.component, quantity: Number(form.quantity), location: form.location, contactNumber: form.contactNumber, ...(hasCoordinates ? { latitude: Number(form.latitude), longitude: Number(form.longitude), ...(form.radiusKm ? { radiusKm: Number(form.radiusKm) } : {}) } : {}) };
			const result = emergency
				? await submitWorkflowAction<{ request: BloodRequest; matching: { candidates: Candidate[]; retry: { suggestedRadiusKm?: number } } }>("/api/emergency/blood-requests", body)
				: await submitWorkflowAction<{ request: BloodRequest; matching: { candidates: Candidate[]; retry: { suggestedRadiusKm?: number } } }>("/api/requests/blood", { ...body, priority: form.priority });
			onCreated(result.request, result.matching.candidates, result.matching.retry.suggestedRadiusKm);
		} catch (reason) {
			setError(reason instanceof ApiFailure ? reason.message : "Request submission failed.");
		} finally { setBusy(false); }
	};

	return <form className="panel form-grid" onSubmit={submit}>
		<div className="panel-heading"><div><span className="eyebrow">COORDINATION</span><h2>Create a blood request</h2></div><label className="switch-label"><input type="checkbox" checked={emergency} onChange={(event) => setEmergency(event.target.checked)} /> Emergency broadcast</label></div>
		<label>Blood group<select value={form.bloodGroup} onChange={(event) => update("bloodGroup", event.target.value)}>{BLOOD_GROUPS.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}</select></label>
		<label>Component<select value={form.component} onChange={(event) => update("component", event.target.value)}>{BLOOD_COMPONENTS.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}</select></label>
		<label>Units<input type="number" min="1" step="1" required value={form.quantity} onChange={(event) => update("quantity", event.target.value)} /></label>
		{!emergency && <label>Priority<select value={form.priority} onChange={(event) => update("priority", event.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></select></label>}
		<label className="wide">Delivery location<input required maxLength={200} value={form.location} onChange={(event) => update("location", event.target.value)} placeholder="Hospital or delivery address" /></label>
		<label>Contact number<input required value={form.contactNumber} onChange={(event) => update("contactNumber", event.target.value)} autoComplete="tel" /></label>
		<label>Search radius (km)<input type="number" min="1" max="500" value={form.radiusKm} disabled={!form.latitude || !form.longitude} onChange={(event) => update("radiusKm", event.target.value)} /><small>Enter both coordinates to use a radius filter.</small></label>
		<div className="coordinate-row"><label>Latitude<input type="number" step="any" min="-90" max="90" value={form.latitude} onChange={(event) => update("latitude", event.target.value)} /></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={form.longitude} onChange={(event) => update("longitude", event.target.value)} /></label><button type="button" className="button quiet" onClick={locate}>Use my location</button></div>
		{error && <p className="error wide" role="alert">{error}</p>}
		<div className="wide form-footer"><p>{emergency ? "Emergency requests start matching immediately; provider confirmation is still required." : "Matching starts as soon as you submit. Institutions still confirm availability before you can select an offer."}</p><button className="button primary" disabled={busy}>{busy ? "Submitting…" : emergency ? "Broadcast emergency" : "Submit and find matches"}</button></div>
	</form>;
}

export function RequestStateTimeline({ status }: { status: string }) {
	const stepRows = [
		["CREATED", "UNDER_REVIEW", "SEARCHING_MATCHING", "INSTITUTIONS_NOTIFIED", "OFFERS_RECEIVED"],
		["OFFER_EVALUATION", "OFFER_ACCEPTED", "RESERVED", "FULFILLED"],
	];
	const allSteps = stepRows.flat();
	const currentIndex = allSteps.indexOf(status);

	return <div className="timeline">
		{stepRows.map((row, rowIndex) => (
			<div key={rowIndex} className="timeline-row">
				{row.map((step, colIndex) => {
					const globalIndex = allSteps.indexOf(step);
					const isDone = currentIndex >= 0 && globalIndex <= currentIndex;
					const isCurrent = step === status;
					const isLastInRow = colIndex === row.length - 1;
					const nextGlobalIndex = globalIndex + 1;
					const isConnectorFilled = isDone && currentIndex >= nextGlobalIndex && !isLastInRow;

					return (
						<div key={step} className={`timeline-step ${isDone ? "done" : ""} ${isCurrent ? "current" : ""}`}>
							<div className="timeline-node">
								<i className="timeline-dot" />
								{!isLastInRow && <div className={`timeline-connector ${isConnectorFilled ? "filled" : ""}`} />}
							</div>
							<span>{statusLabel(step)}</span>
						</div>
					);
				})}
			</div>
		))}
		{status === "REOPENED" && <p className="status-note">Request reopened for another matching attempt.</p>}
		{finalStatuses.includes(status) && <p className={`status-note ${status.toLowerCase()}`}>Request {pretty(status.toLowerCase())}</p>}
	</div>;
}

export function OfferReview({ offers, candidates, request, role, institutionId, canRequesterAct, onAction }: { offers: Offer[]; candidates: Candidate[]; request: BloodRequest; role: string; institutionId?: string | null; canRequesterAct: boolean; onAction: (path: string, body?: unknown) => Promise<void> }) {
	const isAdmin = role === "ADMINISTRATOR";
	return <div className="offer-list">
		{candidates.length > 0 && <section><h3>Matching candidates <span className="pill neutral">Not confirmed</span></h3><p className="muted">These providers matched the current criteria. Availability must be confirmed by the institution.</p>{candidates.map((candidate, index) => <article className="offer-card" key={candidate.matchId ?? candidate.institutionId + index}><div><strong>{candidate.institutionName}</strong><p>{candidate.distanceKm === undefined ? "Distance unavailable" : `${candidate.distanceKm.toFixed(1)} km away`} · {candidate.unitsAvailable} units shown</p></div><span className="score">{Math.round(candidate.score * 100)} match</span></article>)}</section>}
		<section><h3>Provider offers <span className="pill neutral">{offers.length}</span></h3>{offers.length === 0 && candidates.length === 0 && <p className="empty">No offers yet. Run matching to search current institutional stock.</p>}{offers.map((offer) => {
			const isProvider = ["BLOOD_BANK_USER", "HOSPITAL_USER"].includes(role) && institutionId === offer.providerInstitutionId;
			const canRespond = offer.status === "PENDING" && (isAdmin || isProvider);
			const canEvaluate = canRequesterAct && offer.status === "ACCEPTED" && ["OFFERS_RECEIVED", "OFFER_EVALUATION"].includes(request.status);
			const canFulfill = request.status === "RESERVED" && offer.status === "ACCEPTED" && (isAdmin || isProvider);
			return <article className="offer-card" key={offer.matchId}><div><strong>{offer.providerName}</strong><p>{offer.unitsAvailable} units · {offer.compatibilityScore === null ? "Compatibility not scored" : `${Math.round(offer.compatibilityScore * 100)}% compatibility`}</p>{offer.reservationExpiresAt && <small>Reservation ends {new Date(offer.reservationExpiresAt).toLocaleString()}</small>}</div><div className="offer-actions"><span className={`pill ${offer.status.toLowerCase()}`}>{pretty(offer.status)}</span>{canRespond && <><button className="button small primary" onClick={() => void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/respond`, { action: "ACCEPT" })}>Confirm availability</button><button className="button small quiet" onClick={() => void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/respond`, { action: "REJECT" })}>Decline</button></>}{canEvaluate && <><button className="button small primary" onClick={() => void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/evaluate`, { action: "ACCEPT" })}>Select offer</button><button className="button small quiet" onClick={() => void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/evaluate`, { action: "REJECT" })}>Decline offer</button></>}{canFulfill && <button className="button small primary" onClick={() => void onAction(`/api/requests/blood/${request.id}/fulfill`)}>Mark fulfilled & handed over</button>}</div></article>;
		})}</section>
	</div>;
}

export default function RequestsWorkspace() {
	const [requests, setRequests] = useState<BloodRequest[]>([]);
	const [selectedId, setSelectedId] = useState("");
	const [offers, setOffers] = useState<Offer[]>([]);
	const [candidates, setCandidates] = useState<Candidate[]>([]);
	const [retryRadius, setRetryRadius] = useState<number>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const initialRefreshStarted = useRef(false);
	const session = getCurrentSession();
	const isAdmin = session?.user.role === "ADMINISTRATOR";
	const selected = useMemo(() => requests.find((item) => item.id === selectedId), [requests, selectedId]);
	const canCreateRequest = isAdmin || ["USER", "HOSPITAL_USER"].includes(session?.user.role ?? "");
	const canRequesterAct = Boolean(isAdmin || selected?.contactNumber);

	const searchParams = useSearchParams();
	const queryRequestId = searchParams?.get("requestId") ?? "";

	const loadOffers = useCallback(async (id: string) => {
		try {
			const offerData = await requestApi<{ offers: Offer[] }>(`/api/requests/blood/${id}/offers`);
			setOffers(offerData.offers);
		} catch {
			setOffers([]);
		}
	}, []);

	const refresh = useCallback(async (preferredId?: string) => {
		setError("");
		try {
			const data = await requestApi<{ requests: BloodRequest[] }>("/api/requests/blood");
			setRequests(data.requests);
			const targetId = preferredId || selectedId || queryRequestId;
			const active = (targetId ? data.requests.find((item) => item.id === targetId) : undefined) ?? data.requests[0];
			if (!active) {
				setSelectedId("");
				setOffers([]);
				return;
			}
			setSelectedId(active.id);
			await loadOffers(active.id);
		} catch (reason) {
			setError(reason instanceof ApiFailure ? reason.message : "Could not load blood requests.");
		}
	}, [selectedId, queryRequestId, loadOffers]);

	const selectRequest = (id: string) => {
		setSelectedId(id);
		setOffers([]);
		setCandidates([]);
		void loadOffers(id);
	};

	useEffect(() => {
		if (initialRefreshStarted.current) return;
		initialRefreshStarted.current = true;
		void refresh(queryRequestId);
	}, [refresh, queryRequestId]);
	useEffect(() => subscribeToWorkflowEvents((event) => { if (!event.requestId || event.requestId === selectedId) void refresh(selectedId); }), [refresh, selectedId]);

	const act = async (path: string, body?: unknown) => {
		if (["/cancel", "/reopen"].some((part) => path.endsWith(part)) && !window.confirm("Confirm this request status update?")) return;
		setBusy(true);
		setError("");
		try {
			await submitWorkflowAction(path, body);
			setCandidates([]);
			setRetryRadius(undefined);
			await refresh(selectedId);
		} catch (reason) {
			setError(reason instanceof ApiFailure ? reason.message : "Action failed.");
		} finally { setBusy(false); }
	};
	const created = (item: BloodRequest, found: Candidate[], widerRadius?: number) => {
		setRequests((all) => [item, ...all.filter((request) => request.id !== item.id)]);
		setSelectedId(item.id);
		setCandidates(found);
		setRetryRadius(widerRadius);
		void refresh(item.id);
	};
	const match = async (radiusKm?: number) => {
		if (!selected) return;
		setBusy(true);
		setError("");
		try {
			const path = selected.priority === "EMERGENCY" ? `/api/emergency/blood-requests/${selected.id}/broadcast` : `/api/requests/blood/${selected.id}/match`;
			const result = await submitWorkflowAction<{ matching: { candidates: Candidate[]; retry: { canWidenRadius: boolean; suggestedRadiusKm?: number } } }>(path, radiusKm ? { radiusKm } : undefined);
			setCandidates(result.matching.candidates);
			setRetryRadius(result.matching.retry.canWidenRadius ? result.matching.retry.suggestedRadiusKm : undefined);
			await refresh(selected.id);
			if (result.matching.candidates.length === 0) setError("No eligible inventory matched. Retry after inventory changes or widen the search radius.");
		} catch (reason) {
			setError(reason instanceof ApiFailure ? reason.message : "Matching failed.");
		} finally { setBusy(false); }
	};

	const acceptedOffer = offers.find((item) => item.status === "ACCEPTED");
	const isProviderInstitution = Boolean(session?.user.institutionId && acceptedOffer?.providerInstitutionId === session.user.institutionId);
	const canFulfill = Boolean(selected && selected.status === "RESERVED" && (isAdmin || isProviderInstitution));
	const canCancel = Boolean(selected && canRequesterAct && cancellableStatuses.includes(selected.status));
	const canReopen = Boolean(selected && canRequesterAct && reopenableStatuses.includes(selected.status));
	const canMatch = Boolean(selected && canRequesterAct && ["CREATED", "UNDER_REVIEW", "REOPENED"].includes(selected.status));

	return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">BLOOD COORDINATION</span><h1>Requests & offers</h1><p>Submit a request, review provider responses, and follow each confirmed step.</p></div></header>
		{canCreateRequest ? <RequestForm onCreated={created} /> : <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PROVIDER WORKSPACE</span><h2>Respond to matched blood requests</h2><p>New blood requests are created by users and hospitals. Your institution will see requests when matching identifies your inventory.</p></div></div></section>}
		<div className="workflow-grid"><section className="panel request-list"><div className="panel-heading"><div><span className="eyebrow">WORKFLOW</span><h2>Requests you can access</h2></div><button className="button quiet" onClick={() => void refresh()} disabled={busy}>Refresh</button></div>{requests.length === 0 ? <p className="empty">Requests you are permitted to coordinate will appear here.</p> : requests.map((item) => <button key={item.id} className={`request-row ${selectedId === item.id ? "active" : ""}`} onClick={() => selectRequest(item.id)}><span><strong>{pretty(item.bloodGroup)} · {pretty(item.component)}</strong><small>{item.quantity} units · {item.location}</small></span><span className={`pill ${item.status.toLowerCase()}`}>{statusLabel(item.status)}</span></button>)}</section>
			<section className="panel workflow-detail">{selected ? <><div className="panel-heading"><div><span className="eyebrow">REQUEST DETAIL</span><h2>{pretty(selected.bloodGroup)} {pretty(selected.component)}</h2><p>{selected.quantity} units · {selected.priority} · {selected.location}</p></div><span className={`pill ${selected.status.toLowerCase()}`}>{statusLabel(selected.status)}</span></div><RequestStateTimeline status={selected.status} /><div className="action-bar">
				{canMatch && <><button className="button primary" disabled={busy} onClick={() => void match()}>Find matching inventory</button>{selected.status === "REOPENED" && retryRadius && <button className="button quiet" disabled={busy} onClick={() => void match(retryRadius)}>Widen search to {retryRadius} km</button>}</>}
				{canFulfill && <button className="button primary" disabled={busy} onClick={() => void act(`/api/requests/blood/${selected.id}/fulfill`)}>Mark request fulfilled</button>}
				{canReopen && <button className="button quiet" disabled={busy} onClick={() => void act(`/api/requests/blood/${selected.id}/reopen`)}>Reopen request</button>}
				{canCancel && <button className="button danger" disabled={busy} onClick={() => void act(`/api/requests/blood/${selected.id}/cancel`)}>Cancel request</button>}
			</div><OfferReview offers={offers} candidates={candidates} request={selected} role={session?.user.role ?? ""} institutionId={session?.user.institutionId} canRequesterAct={canRequesterAct} onAction={act} /></> : <div className="empty-state"><span className="empty-icon">↗</span><h2>Select a request</h2><p>Choose a request from the list to view its current workflow.</p></div>}</section></div>{error && <div className="toast-error" role="alert">{error}<button onClick={() => setError("")}>Dismiss</button></div>}</div>;
}
