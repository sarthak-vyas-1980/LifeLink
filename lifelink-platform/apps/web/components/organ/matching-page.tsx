"use client";

import { useCallback, useEffect, useState } from "react";
import { OrganSectionNav } from "./index";
import { requestApi } from "../../lib/api-client";

type RecipientRow = { id: string; reference: string; organType: string; bloodGroup?: string | null; priority: string; status: string; institution: { name: string } };
type MatchRow = { id: string; status: string; canCoordinate: boolean; organ: { id: string; reference: string; organType: string; bloodGroup?: string | null; status: string; institution: { name: string } }; recipient: { id: string; reference: string; organType: string; bloodGroup?: string | null; priority: string; institution: { name: string } } };
const types = ["KIDNEY", "LIVER", "HEART", "LUNG", "PANCREAS", "INTESTINE", "CORNEA", "BONE_MARROW", "OTHER"];
const groups = ["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"];
const recipientStatuses = ["PENDING_REVIEW", "ACTIVE", "MATCHED", "CLOSED", "REJECTED", "CANCELLED"];

export function OrganMatchResourcePage() {
	const [recipients, setRecipients] = useState<RecipientRow[]>([]);
	const [matches, setMatches] = useState<MatchRow[]>([]);
	const [query, setQuery] = useState("");
	const [status, setStatus] = useState("");
	const [organType, setOrganType] = useState("");
	const [bloodGroup, setBloodGroup] = useState("");
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [loading, setLoading] = useState(true);
	const [busyId, setBusyId] = useState("");

	const loadRecipients = useCallback(async () => {
		setLoading(true);
		setError("");
		const params = new URLSearchParams();
		if (query.trim()) params.set("q", query.trim());
		if (status) params.set("status", status);
		try {
			const result = await requestApi<{ recipients: RecipientRow[] }>(`/api/organs/recipients${params.size ? `?${params}` : ""}`);
			setRecipients((result.recipients ?? []).filter((recipient) => !organType || recipient.organType === organType).filter((recipient) => !bloodGroup || recipient.bloodGroup === bloodGroup));
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setLoading(false);
		}
	}, [query, status, organType, bloodGroup]);

	const loadMatches = useCallback(async () => {
		try {
			const result = await requestApi<{ matches: MatchRow[] }>("/api/organs/matches");
			setMatches(result.matches ?? []);
		} catch (cause) {
			setError((cause as Error).message);
		}
	}, []);

	useEffect(() => { void loadRecipients(); void loadMatches(); }, [loadRecipients, loadMatches]);

	const findMatches = async (recipient: RecipientRow) => {
		setBusyId(recipient.id);
		setError("");
		setMessage("");
		try {
			const result = await requestApi<{ matches: MatchRow[] }>(`/api/organs/recipients/${recipient.id}/matches`, { method: "POST", body: JSON.stringify({}) });
			setMatches(result.matches ?? []);
			const candidates = (result.matches ?? []).filter((match) => ["GENERATED", "UNDER_REVIEW", "SHORTLISTED"].includes(match.status));
			setMessage(candidates.length ? `Inventory search found ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} for ${recipient.reference}.` : `No eligible inventory matched ${recipient.reference}.`);
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setBusyId("");
		}
	};

	const review = async (matchId: string, nextStatus: "UNDER_REVIEW" | "SHORTLISTED" | "REJECTED") => {
		setBusyId(matchId);
		setError("");
		try {
			await requestApi(`/api/organs/matches/${matchId}/review`, { method: "PATCH", body: JSON.stringify({ status: nextStatus }) });
			setMatches((current) => current.map((match) => match.id === matchId ? { ...match, status: nextStatus } : match));
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setBusyId("");
		}
	};

	const createOffer = async (match: MatchRow) => {
		setBusyId(match.id);
		setError("");
		try {
			await requestApi("/api/organs/offers", { method: "POST", body: JSON.stringify({ matchId: match.id, responseDeadline: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() }) });
			setMatches((current) => current.filter((item) => item.id !== match.id));
		} catch (cause) {
			setError((cause as Error).message);
		} finally {
			setBusyId("");
		}
	};

	return <main className="page-stack organ-workspace">
		<header className="page-heading"><div><span className="eyebrow">ORGAN COORDINATION</span><h1>Recipient matching</h1><p>Choose an approved recipient request to search available organ inventory.</p></div></header>
		<OrganSectionNav/>
		{error && <div className="error" role="alert">{error}</div>}
		<form className="panel organ-create-fields organ-filter-form" onSubmit={(event) => { event.preventDefault(); void loadRecipients(); }}>
			<label>Search recipient reference<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="RCPT-2026"/></label>
			<label>Request status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All requests</option>{recipientStatuses.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
			<label>Organ type<select value={organType} onChange={(event) => setOrganType(event.target.value)}><option value="">All types</option>{types.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
			<label>Blood group<select value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}><option value="">All groups</option>{groups.map((value) => <option key={value} value={value}>{value.replace("_", " ")}</option>)}</select></label>
			<button className="button" type="submit">Apply filters</button>
		</form>
		{loading ? <section className="panel">Loading recipient requests…</section> : recipients.length === 0 ? <section className="panel empty-state"><h3>No recipient requests to display</h3><p>Approved requests visible to your institution will appear here for inventory matching.</p></section> : <section className="panel"><div className="panel-heading"><div><span className="eyebrow">RECIPIENT REQUESTS</span><h2>Search inventory for a request</h2><p>Only approved active requests can start a search. Pending requests need approval first.</p></div></div><div className="organ-table-wrap"><table className="organ-table"><thead><tr><th>Recipient request</th><th>Organ type</th><th>Blood group</th><th>Priority</th><th>Status</th><th>Institution</th><th>Action</th></tr></thead><tbody>{recipients.map((recipient) => <tr key={recipient.id}><td>{recipient.reference}</td><td>{recipient.organType.replaceAll("_", " ")}</td><td>{recipient.bloodGroup?.replaceAll("_", " +") ?? "—"}</td><td>{recipient.priority}</td><td>{recipient.status.replaceAll("_", " ")}</td><td>{recipient.institution.name}</td><td>{recipient.status === "ACTIVE" ? <button className="button small primary" disabled={Boolean(busyId)} onClick={() => void findMatches(recipient)}>{busyId === recipient.id ? "Searching inventory…" : "Find inventory matches"}</button> : "Approve request first"}</td></tr>)}</tbody></table></div></section>}
		{message && <p role="status">{message}</p>}
		{matches.length > 0 && <section className="panel"><div className="panel-heading"><div><span className="eyebrow">INVENTORY CANDIDATES</span><h2>Potential coordination matches</h2></div></div><div className="organ-table-wrap"><table className="organ-table"><thead><tr><th>Organ case</th><th>Inventory institution</th><th>Recipient request</th><th>Recipient institution</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>{matches.map((match) => <tr key={match.id}><td><strong>{match.organ.reference}</strong><small>{match.organ.organType.replaceAll("_", " ")} · {match.organ.bloodGroup?.replaceAll("_", " +") ?? "No blood group"}</small></td><td>{match.organ.institution.name}</td><td>{match.recipient.reference}</td><td>{match.recipient.institution.name}</td><td>{match.recipient.priority}</td><td>{match.status.replaceAll("_", " ")}</td><td>{!match.canCoordinate ? "Inventory institution review" : match.status === "GENERATED" ? <button className="button small" disabled={busyId === match.id} onClick={() => void review(match.id, "UNDER_REVIEW")}>Begin review</button> : match.status === "UNDER_REVIEW" ? <span className="offer-actions"><button className="button small primary" disabled={busyId === match.id} onClick={() => void review(match.id, "SHORTLISTED")}>Shortlist</button><button className="button small danger" disabled={busyId === match.id} onClick={() => void review(match.id, "REJECTED")}>Reject</button></span> : match.status === "SHORTLISTED" ? <button className="button small primary" disabled={busyId === match.id} onClick={() => void createOffer(match)}>Create offer</button> : "—"}</td></tr>)}</tbody></table></div><p className="organ-disclaimer">These are coordination candidates, not clinical compatibility or allocation decisions. Authorized professionals make those decisions.</p></section>}
	</main>;
}
