"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BLOOD_COMPONENTS, BLOOD_GROUPS } from "@lifelink/shared";
import styles from "./inventory.module.css";
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
	status: string;
	expiryDate: string | null;
	lastUpdated: string;
	distanceKm?: number;
	institution: InstitutionOption;
};
type InventoryRecord = StockCandidate & { institutionId: string; id?: string };

const label = (value: string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
const today = () => new Date().toISOString().slice(0, 10);

async function fetchStockRows(institutionId: string) {
	const query = new URLSearchParams({ institutionId });
	const data = await requestApi<{ records: StockCandidate[] }>(`/api/inventory/blood?${query.toString()}`);
	return data.records.map((item) => ({ ...item, institutionId: item.institution.id }));
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
	const [editing, setEditing] = useState<InventoryRecord | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [form, setForm] = useState<{ bloodGroup: string; component: string; unitsAvailable: string; expiryDate: string }>({ bloodGroup: BLOOD_GROUPS[0], component: BLOOD_COMPONENTS[0], unitsAvailable: "1", expiryDate: "" });
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const isAdmin = session?.user.role === "ADMINISTRATOR";
	const selectedInstitution = useMemo(() => institutions.find((item) => item.id === institutionId), [institutions, institutionId]);
	const stockByGroup = useMemo(() => BLOOD_GROUPS.map((group) => {
		const groupRecords = records.filter((record) => record.bloodGroup === group);
		const available = groupRecords.filter((record) => record.status === "AVAILABLE" && (!record.expiryDate || new Date(record.expiryDate).getTime() > Date.now()));
		return {
			bloodGroup: group,
			records: groupRecords,
			units: available.reduce((total, record) => total + record.unitsAvailable, 0),
			components: BLOOD_COMPONENTS.flatMap((item) => {
				const units = available.filter((record) => record.component === item).reduce((total, record) => total + record.unitsAvailable, 0);
				return units > 0 ? [{ component: item, units }] : [];
			}),
		};
	}), [records]);
	const selectedGroupRecords = useMemo(() => records.filter((record) => record.bloodGroup === bloodGroup), [records, bloodGroup]);

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
		setSearching(true);
		setError("");
		setNotice("");
		try {
			setRecords(await fetchStockRows(institutionId));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not load blood stock.");
		} finally {
			setSearching(false);
		}
	}, [institutionId]);

	useEffect(() => {
		if (!institutionId) return;
		let current = true;
		void fetchStockRows(institutionId)
			.then((rows) => { if (current) setRecords(rows); })
			.catch((reason: Error) => { if (current) setError(reason.message); });
		return () => { current = false; };
	}, [institutionId]);

	const resetForm = () => {
		setEditing(null);
		setShowCreate(false);
		setForm({ bloodGroup, component: form.component, unitsAvailable: "1", expiryDate: "" });
	};
	const startCreate = () => {
		setEditing(null);
		setForm({ bloodGroup, component: form.component, unitsAvailable: "1", expiryDate: "" });
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
			setEditing(null);
			setShowCreate(false);
			setForm({ ...form, unitsAvailable: "1" });
			setNotice(editing ? "Stock updated." : "Stock record added.");
			setRecords(await fetchStockRows(institutionId));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not save blood stock.");
		} finally {
			setSaving(false);
		}
	};

	if (loading) return <main className="page-stack"><section className="panel">Loading blood inventory…</section></main>;
	if (!session || !authorized) return <main className="page-stack inventory-workspace"><header className="page-heading"><div><span className="eyebrow">BLOOD INVENTORY</span><h1>Stock management</h1><p>This workspace is available to administrators and institutions with blood service access.</p></div></header>{error && <p className="error" role="alert">{error}</p>}</main>;

	return <main className="page-stack inventory-workspace">
		<header className="page-heading"><div><span className="eyebrow">BLOOD INVENTORY</span><h1>Stock management</h1><p>{isAdmin ? "View and maintain blood stock by type for an active blood bank." : `View and manage available stock for ${institutionName}.`}</p></div><button className="button primary" disabled={!institutionId} onClick={startCreate}>Add stock</button></header>
		{isAdmin && <section className="panel inventory-institution-panel"><label>Blood bank<select value={institutionId} onChange={(event) => { setInstitutionId(event.target.value); setRecords([]); setBloodGroup(BLOOD_GROUPS[0]); }} disabled={institutions.length === 0}>{institutions.length === 0 && <option value="">No active blood banks found</option>}{institutions.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{selectedInstitution && <small className="muted">{selectedInstitution.address}</small>}</section>}
		<section className={`panel blood-stock-summary ${styles.stockSummary}`}><div className="panel-heading"><div><span className="eyebrow">INSTITUTION BLOOD STOCK</span><h2>Available units by blood type</h2><p>Choose a blood type to review its component stock and expiry dates.</p></div><button className="button quiet" disabled={!institutionId || searching} onClick={() => void loadStock()}>{searching ? "Refreshing…" : "Refresh stock"}</button></div>
			{loading || searching ? <p className="empty">Loading blood stock…</p> : <div className={styles.stockGrid}>{stockByGroup.map((item) => <button type="button" key={item.bloodGroup} className={`${styles.stockCard} ${bloodGroup === item.bloodGroup ? styles.selected : ""}`} onClick={() => setBloodGroup(item.bloodGroup)} aria-pressed={bloodGroup === item.bloodGroup}>
				<span className={styles.cardHeading}><strong>{item.bloodGroup.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")}</strong><span className={styles.unitCount}>{item.units} {item.units === 1 ? "unit" : "units"}</span></span>
				{item.components.length ? <span className={styles.componentBreakdown}>{item.components.map(({ component: bloodComponent, units }) => <small key={bloodComponent}>{label(bloodComponent)} <b>{units}</b></small>)}</span> : <span className={styles.emptyStock}>No available stock</span>}
			</button>)}</div>}
			<p className="inventory-search-note">Available totals exclude expired records. Operational stock only; confirm suitability through authorized clinical staff.</p>
		</section>

		{(showCreate || editing) && <section className="panel inventory-entry-panel"><div className="panel-heading"><div><span className="eyebrow">{editing ? "UPDATE STOCK" : "NEW STOCK RECORD"}</span><h2>{editing ? "Update inventory record" : "Add inventory record"}</h2><p>Keep the available count and expiry date current so matching can use this stock.</p></div><button type="button" className="button quiet" onClick={resetForm}>Close</button></div><form className="inventory-filter-form inventory-entry-form" onSubmit={(event) => void saveStock(event)}>
			<label>Blood group<select value={form.bloodGroup} onChange={(event) => setForm({ ...form, bloodGroup: event.target.value })}>{BLOOD_GROUPS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Component<select value={form.component} onChange={(event) => setForm({ ...form, component: event.target.value })}>{BLOOD_COMPONENTS.map((item) => <option key={item} value={item}>{label(item)}</option>)}</select></label>
			<label>Units available<input required type="number" min="0" step="1" inputMode="numeric" value={form.unitsAvailable} onChange={(event) => setForm({ ...form, unitsAvailable: event.target.value })} /><small>Enter the new available total, not the amount to add.</small></label>
			<label>Expiry date<input type="date" min={today()} value={form.expiryDate} onChange={(event) => setForm({ ...form, expiryDate: event.target.value })} /><small>Optional. Existing expiry dates cannot be cleared through this API.</small></label>
			<div className="inventory-entry-actions"><button className="button primary" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add stock"}</button><button type="button" className="button quiet" disabled={saving} onClick={resetForm}>Cancel</button></div>
		</form></section>}
		{error && <p className="error" role="alert">{error}</p>}{notice && <p className="inventory-notice" role="status">{notice}</p>}
		<section className="panel"><div className="panel-heading"><div><span className="eyebrow">{bloodGroup.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")} STOCK</span><h2>{institutionName || selectedInstitution?.name || "Blood bank stock"}</h2><p>{selectedGroupRecords.length} inventory record{selectedGroupRecords.length === 1 ? "" : "s"}</p></div></div>
			{selectedGroupRecords.length === 0 ? <p className="empty">No inventory records for this blood type. Use Add stock to record availability.</p> : <div className="organ-table-wrap"><table className="organ-table inventory-table"><thead><tr><th>Component</th><th>Available</th><th>Status</th><th>Expiry</th><th>Last updated</th><th>Action</th></tr></thead><tbody>{selectedGroupRecords.map((record) => <tr key={record.inventoryId}><td><strong>{label(record.component)}</strong></td><td>{record.unitsAvailable}</td><td><span className={`pill ${record.status.toLowerCase()}`}>{label(record.status)}</span></td><td>{record.expiryDate ? new Date(record.expiryDate).toLocaleDateString() : "Not set"}</td><td>{new Date(record.lastUpdated).toLocaleString()}</td><td><button className="button small" onClick={() => startEdit(record)}>Edit</button></td></tr>)}</tbody></table></div>}
		</section>
	</main>;
}
