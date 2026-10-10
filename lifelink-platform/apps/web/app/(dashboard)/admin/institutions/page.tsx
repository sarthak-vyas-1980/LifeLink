"use client";

import Link from "next/link";
import { Fragment } from "react";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { requestApi } from "../../../../lib/api-client";
import { InstitutionAnalyticsChart } from "../institution-analytics-chart";
import { InstitutionComparisonChart } from "../institution-comparison-chart";

type Institution = { id: string; name: string; type: string; status: string; address: string; contactNumber: string | null; account: { email: string; phone: string } | null; analytics: { donorRequests: number; recipientRequests: number; handledRequests: number; activeRequests: number; completed: number; cancelled: number; expired: number; rejected: number; matchingVolume: number; offerVolume: number; acceptedOffers: number; procurementVolume: number; completionRate: number; backlog: number; recentActivityCount: number } };
type AdminOverview = { institutions: Institution[] };

export default function AdminInstitutionsPage() {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [expandedInstitutionId, setExpandedInstitutionId] = useState<string | null>(null);
  const load = useCallback(() => {
    setError("");
    void requestApi<AdminOverview>("/api/admin/overview").then(setData).catch((reason: Error) => setError(reason.message));
  }, []);
  useEffect(load, [load]);
  const sortedInstitutions = [...(data?.institutions ?? [])].sort((a, b) =>
    b.analytics.handledRequests - a.analytics.handledRequests || a.name.localeCompare(b.name),
  );

  const updateStatus = async (id: string, status: string) => {
    setBusy(id);
    setError("");
    try {
      await requestApi(`/api/admin/institutions/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy("");
    }
  };

  return <main className="page-stack institution-workspace admin-audit-page">
    <header className="page-heading"><div><span className="eyebrow">SYSTEM ADMINISTRATION / INSTITUTIONS</span><h1>All institutions</h1><p>Review every institution and manage its access status.</p></div><div className="offer-actions"><Link className="button" href="/admin"><ArrowLeft size={14}/> Administration</Link><button className="button" onClick={load}><RefreshCw size={14}/> Refresh</button></div></header>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="panel admin-institution-directory"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION DIRECTORY</span><h2>{data?.institutions.length ?? 0} institutions</h2><p>Manage the platform access status for each institution.</p></div></div>
      {data && <InstitutionComparisonChart institutions={sortedInstitutions} title="All institutions · requests vs active"/>}
      {!data && !error ? <p>Loading institutions…</p> : data?.institutions.length ? <div className="admin-institution-table-wrap"><table className="admin-institution-table"><thead><tr><th>Institution</th><th>Type</th><th>Requests</th><th>Active</th><th>Access status</th><th>Manage</th></tr></thead><tbody>{sortedInstitutions.map((institution) => <Fragment key={institution.id}><tr><td><div className="admin-institution-directory-name"><strong>{institution.name}</strong><small>{institution.address || "Address not provided"}</small><button type="button" className="text-button admin-institution-details-toggle" aria-expanded={expandedInstitutionId === institution.id} onClick={() => setExpandedInstitutionId(expandedInstitutionId === institution.id ? null : institution.id)}>{expandedInstitutionId === institution.id ? <>Hide details <ChevronUp size={12}/></> : <>View details <ChevronDown size={12}/></>}</button></div></td><td>{institution.type.replaceAll("_", " ")}</td><td>{institution.analytics.handledRequests}</td><td>{institution.analytics.activeRequests}</td><td><span className={`admin-status status-${institution.status.toLowerCase()}`}>{institution.status.replaceAll("_", " ")}</span></td><td><select aria-label={`Status for ${institution.name}`} disabled={busy === institution.id} value={institution.status} onChange={(event) => void updateStatus(institution.id, event.target.value)}>{["PENDING_VERIFICATION", "ACTIVE", "INACTIVE"].map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}</select></td></tr>{expandedInstitutionId === institution.id && <tr className="admin-institution-expanded-row"><td colSpan={6}><div className="admin-institution-details"><div><small>Donor / recipient requests</small><strong>{institution.analytics.donorRequests} / {institution.analytics.recipientRequests}</strong></div><div><small>Active / backlog</small><strong>{institution.analytics.activeRequests} / {institution.analytics.backlog}</strong></div><div><small>Matching volume</small><strong>{institution.analytics.matchingVolume}</strong></div><div><small>Offers / accepted</small><strong>{institution.analytics.offerVolume} / {institution.analytics.acceptedOffers}</strong></div><div><small>Procurement / completed</small><strong>{institution.analytics.procurementVolume} / {institution.analytics.completed}</strong></div><div><small>Rejected / cancelled / expired</small><strong>{institution.analytics.rejected} / {institution.analytics.cancelled} / {institution.analytics.expired}</strong></div><div><small>Completion rate</small><strong>{institution.analytics.completionRate}%</strong></div><div><small>Recent activity</small><strong>{institution.analytics.recentActivityCount}</strong></div><div><small>Contact number</small><strong>{institution.contactNumber || institution.account?.phone || "Not provided"}</strong></div><div><small>Contact email</small><strong>{institution.account?.email || "Not provided"}</strong></div><div className="admin-institution-location"><small>Address</small><strong>{institution.address || "Address not provided"}</strong></div><InstitutionAnalyticsChart institution={institution}/></div></td></tr>}</Fragment>)}</tbody></table></div> : <p>No institutions found.</p>}
    </section>
  </main>;
}
