"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BLOOD_COMPONENTS, BLOOD_GROUPS } from "@lifelink/shared";
import { ApiFailure, requestApi } from "../../../lib/api-client";
import { getCurrentSession, type Session } from "../../../lib/auth";

type InstitutionOption = { id: string; name: string; type: string; address: string };
type InstitutionProfile = {
	institution: InstitutionOption;
	capabilities: { blood: boolean; organ: boolean; emergency: boolean };
};
type StockCandidate = {
	inventoryId: string;
	bloodGroup: string;
	component: string;
	unitsAvailable: number;
	expiryDate: string | null;
	lastUpdated: string;
	distanceKm?: number;
	institution: InstitutionOption;
};
type InventoryRecord = StockCandidate & { institutionId: string; id?: string };

const label = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const today = () => new Date().toISOString().slice(0, 10);

async function fetchStockRows(institutionId: string, bloodGroup: string, component: string, quantity: number) {
	const query = new URLSearchParams({ bloodGroup, component, quantity: String(quantity) });
	const data = await requestApi<{ candidates: StockCandidate[] }>(`/api/inventory/blood/search?${query.toString()}`);
	return data.candidates.filter((item) => item.institution.id === institutionId).map((item) => ({ ...item, institutionId: item.institution.id }));
}

export default function InventoryPage() {
	const [session, setSession] = useState<Session | null>(null);
	const [institutions, setInstitutions] = useState<InstitutionOption[]>([]);
	const [institutionId, setInstitutionId] = useState("");
	const [institutionName, setInstitutionName] = useState("");
	const [authorized, setAuthorized] = useState(false);
	const [loading, setLoading] = useState(true);
	const [searching, setSearching] = useState(false);
	const [saving, setSaving] = useState(false);
	const [records, setRecords] = useState<InventoryRecord[]>([]);
	const [bloodGroup, setBloodGroup] = useState<string>(BLOOD_GROUPS[0]);
	const [component, setComponent] = useState<string>(BLOOD_COMPONENTS[0]);
	const [minimumUnits, setMinimumUnits] = useState("1");
	const [editing, setEditing] = useState<InventoryRecord | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [form, setForm] = useState<{ bloodGroup: string; component: string; unitsAvailable: string; expiryDate: string }>({ bloodGroup: BLOOD_GROUPS[0], component: BLOOD_COMPONENTS[0], unitsAvailable: "1", expiryDate: "" });
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const isAdmin = session?.user.role === "ADMINISTRATOR";
	const selectedInstitution = useMemo(() => institutions.find((item) => item.id === institutionId), [institutions, institutionId]);

	useEffect(() => {
		const current = getCurrentSession();
		setSession(current);
		if (!current) { setLoading(false); return; }
		if (current.user.role === "ADMINISTRATOR") {
			setAuthorized(true);
			void requestApi<{ institutions: InstitutionOption[] }>("/api/institutions?type=BLOOD_BANK")
				.then((data) => { setInstitutions(data.institutions); if (data.institutions[0]) { setInstitutionId(data.institutions[0].id); setInstitutionName(data.institutions[0].name); } })
				.catch((reason: Error) => setError(reason.message))
				.finally(() => setLoading(false));
			return;
		}
		if (!["BLOOD_BANK_USER", "HOSPITAL_USER"].includes(current.user.role) || !current.user.institutionId) {
			setLoading(false);
			return;
		}
		void requestApi<InstitutionProfile>("/api/institutions/me")
			.then((data) => {
				if (!data.capabilities.blood) return;
				setAuthorized(true);
				setInstitutionId(data.institution.id);
				setInstitutionName(data.institution.name);
				setInstitutions([data.institution]);
			})
			.catch((reason: Error) => setError(reason.message))
			.finally(() => setLoading(false));
	}, []);

	const loadStock = useCallback(async () => {
		if (!institutionId) return;
		const quantity = Number(minimumUnits);
		if (!Number.isInteger(quantity) || quantity < 1) {
			setError("Minimum units must be a positive whole number.");
			return;
		}
		setSearching(true);
		setError("");
		setNotice("");
		try {
			setRecords(await fetchStockRows(institutionId, bloodGroup, component, quantity));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not load blood stock.");
		} finally {
			setSearching(false);
		}
	}, [institutionId, bloodGroup, component, minimumUnits]);

	useEffect(() => {
		if (!institutionId) return;
		let current = true;
		void fetchStockRows(institutionId, BLOOD_GROUPS[0], BLOOD_COMPONENTS[0], 1)
			.then((rows) => { if (current) setRecords(rows); })
			.catch((reason: Error) => { if (current) setError(reason.message); });
		return () => { current = false; };
	}, [institutionId]);

	const resetForm = () => {
		setEditing(null);
		setShowCreate(false);
		setForm({ bloodGroup, component, unitsAvailable: "1", expiryDate: "" });
	};
	const startCreate = () => {
		setEditing(null);
		setForm({ bloodGroup, component, unitsAvailable: "1", expiryDate: "" });
		setShowCreate(true);
	};
	const startEdit = (record: InventoryRecord) => {
		setShowCreate(false);
		setEditing(record);
		setForm({
			bloodGroup: record.bloodGroup,
			component: record.component,
			unitsAvailable: String(record.unitsAvailable),
			expiryDate: record.expiryDate ? record.expiryDate.slice(0, 10) : "",
		});
	};

	const saveStock = async (event: FormEvent) => {
		event.preventDefault();
		if (!institutionId) return;
		const quantity = Number(form.unitsAvailable);
		if (!Number.isInteger(quantity) || quantity < 0) {
			setError("Units must be a non-negative whole number.");
			return;
		}
		if (form.expiryDate && form.expiryDate < today()) {
			setError("Choose an expiry date that is today or later.");
			return;
		}
		setSaving(true);
		setError("");
		setNotice("");
		const body = {
			institutionId,
			bloodGroup: form.bloodGroup,
			component: form.component,
			unitsAvailable: quantity,
			...(form.expiryDate ? { expiryDate: new Date(`${form.expiryDate}T12:00:00`).toISOString() } : {}),
		};
		try {
			if (editing) {
				await requestApi(`/api/inventory/blood/${editing.inventoryId}`, { method: "PATCH", body: JSON.stringify(body) });
			} else {
				await requestApi("/api/inventory/blood", { method: "POST", body: JSON.stringify(body) });
			}
			setBloodGroup(form.bloodGroup);
			setComponent(form.component);
			setMinimumUnits("1");
			setEditing(null);
			setShowCreate(false);
			setForm({ ...form, unitsAvailable: "1" });
			setNotice(editing ? "Stock updated." : "Stock record added.");
			setRecords(await fetchStockRows(institutionId, form.bloodGroup, form.component, 1));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not save blood stock.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) return <main className="page-stack"><section className="panel">Loading blood inventory…</section></main>;
	if (!session || !authorized) return <main className="page-stack inventory-workspace"><header className="page-heading"><div><span className="eyebrow">BLOOD INVENTORY</span><h1>Stock management</h1><p>This workspace is available to administrators and institutions with blood service access.</p></div></header>{error && <p className="error" role="alert">{error}</p>}</main>;

	return <main className="page-stack inventory-workspace">
		<header className="page-heading"><div><span className="eyebrow">BLOOD INVENTORY</span><h1>Stock management</h1><p>{isAdmin ? "Search and maintain stock for an active blood bank." : `Manage available stock for ${institutionName}.`}</p></div><button className="button primary" disabled={!institutionId} onClick={startCreate}>Add stock</button></header>
		{isAdmin && <section className="panel inventory-institution-panel"><label>Blood bank<select value={institutionId} onChange={(event) => { setInstitutionId(event.target.value); setRecords([]); setBloodGroup(BLOOD_GROUPS[0]); setComponent(BLOOD_COMPONENTS[0]); setMinimumUnits("1"); }} disabled={institutions.length === 0}>{institutions.length === 0 && <option value="">No active blood banks found</option>}{institutions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{selectedInstitution && <small className="muted">{selectedInstitution.address}</small>}</section>}
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">SEARCH STOCK</span><h2>Filter by blood type</h2><p>Searches available stock for this institution by blood group, component, and minimum units.</p></div></div><form className="inventory-filter-form inventory-search-form" onSubmit={(event) => { event.preventDefault(); void loadStock(); }}>
			<label>Blood group<select value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}>{BLOOD_GROUPS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Component<select value={component} onChange={(event) => setComponent(event.target.value)}>{BLOOD_COMPONENTS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Minimum units<input type="number" min="1" step="1" inputMode="numeric" value={minimumUnits} onChange={(event) => setMinimumUnits(event.target.value)} /></label>
			<button className="button" disabled={!institutionId || searching}>{searching ? "Searching…" : "Search stock"}</button>
		</form><p className="inventory-search-note">Only available, unexpired records with at least the selected quantity appear in these results.</p></section>
		{(showCreate || editing) && <section className="panel inventory-entry-panel"><div className="panel-heading"><div><span className="eyebrow">{editing ? "UPDATE STOCK" : "NEW STOCK RECORD"}</span><h2>{editing ? "Update inventory record" : "Add inventory record"}</h2><p>Keep the available count and expiry date current so matching can use this stock.</p></div><button type="button" className="button quiet" onClick={resetForm}>Close</button></div><form className="inventory-filter-form inventory-entry-form" onSubmit={(event) => void saveStock(event)}>
			<label>Blood group<select value={form.bloodGroup} onChange={(event) => setForm({ ...form, bloodGroup: event.target.value })}>{BLOOD_GROUPS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Component<select value={form.component} onChange={(event) => setForm({ ...form, component: event.target.value })}>{BLOOD_COMPONENTS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Units available<input required type="number" min="0" step="1" inputMode="numeric" value={form.unitsAvailable} onChange={(event) => setForm({ ...form, unitsAvailable: event.target.value })} /><small>Enter the new available total, not the amount to add.</small></label>
			<label>Expiry date<input type="date" min={today()} value={form.expiryDate} onChange={(event) => setForm({ ...form, expiryDate: event.target.value })} /><small>Optional. Existing expiry dates cannot be cleared through this API.</small></label>
			<div className="inventory-entry-actions"><button className="button primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add stock"}</button><button type="button" className="button quiet" disabled={saving} onClick={resetForm}>Cancel</button></div>
		</form></section>}
		{error && <p className="error" role="alert">{error}</p>}{notice && <p className="inventory-notice" role="status">{notice}</p>}
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">CURRENT RESULTS</span><h2>{institutionName || selectedInstitution?.name || "Blood bank stock"}</h2><p>{records.length} matching inventory record{records.length === 1 ? "" : "s"}</p></div><button className="button quiet" disabled={!institutionId || searching} onClick={() => void loadStock()}>Refresh</button></div>
			{records.length === 0 ? <p className="empty">No available records matched these filters. Try a lower minimum quantity or add stock.</p> : <div className="organ-table-wrap"><table className="organ-table inventory-table"><thead><tr><th>Blood group</th><th>Component</th><th>Available</th><th>Expiry</th><th>Last updated</th><th>Action</th></tr></thead><tbody>{records.map((record) => <tr key={record.inventoryId}><td><strong>{label(record.bloodGroup)}</strong></td><td>{label(record.component)}</td><td>{record.unitsAvailable}</td><td>{record.expiryDate ? new Date(record.expiryDate).toLocaleDateString() : "Not set"}</td><td>{new Date(record.lastUpdated).toLocaleString()}</td><td><button className="button small" onClick={() => startEdit(record)}>Edit</button></td></tr>)}</tbody></table></div>}
		</section>
	</main>;
}
