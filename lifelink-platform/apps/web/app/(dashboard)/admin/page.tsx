"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, Building2, HeartPulse, RefreshCw, ShieldCheck } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { WorkflowPath } from "../../../components/organ/workflow-progress";
import { InstitutionAnalyticsChart } from "./institution-analytics-chart";
import { InstitutionComparisonChart } from "./institution-comparison-chart";

type Institution = { id: string; name: string; type: string; status: string; address: string; contactNumber: string | null; account: { email: string; phone: string } | null; analytics: { donorRequests: number; recipientRequests: number; handledRequests: number; activeRequests: number; completed: number; cancelled: number; expired: number; matchingVolume: number; offerVolume: number; acceptedOffers: number; procurementVolume: number; completionRate: number; backlog: number; recentActivityCount: number } };
type AdminOverview = { institutions: Institution[]; institutionStatus: Record<string, number>; organMetrics: Record<string, number>; activity: Array<{ id: string; actorId: string | null; actorInstitutionId: string | null; action: string; entityType: string; entityId: string; createdAt: string; metadata: unknown }> };

export default function AdminPage() {
  const [data, setData] = useState<AdminOverview | null>(null); const [error, setError] = useState(""); const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null); const [expandedInstitutionId, setExpandedInstitutionId] = useState<string | null>(null);
  const load = useCallback(() => { setError(""); void requestApi<AdminOverview>("/api/admin/overview").then(setData).catch((reason: Error) => setError(reason.message)); }, []);
  useEffect(load, [load]);
  const sortedInstitutions = [...(data?.institutions ?? [])].sort((a, b) =>
    b.analytics.handledRequests - a.analytics.handledRequests || a.name.localeCompare(b.name),
  );
  if (!data && !error) return <main className="page-stack admin-workspace"><section className="panel">Loading administrator analyticsÃ¢â‚¬Â¦</section></main>;
  return <main className="page-stack institution-workspace admin-workspace"><header className="welcome-banner"><div><span className="eyebrow">SYSTEM ADMINISTRATION</span><h1>Platform operations</h1><p>Institution management, system wide organ coordination and audit activity.</p></div><button className="button" onClick={load}><RefreshCw size={14}/> Refresh</button></header><WorkflowPath/>
    {error && <div className="error" role="alert">{error}</div>}
    {!data && <section className="panel admin-institution-performance"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION MANAGEMENT</span><h2>Institution performance</h2><p>Performance preview for up to five institutions.</p></div><Link className="button" href="/admin/institutions">All institutions <ArrowRight size={14}/></Link></div><p>Institution data could not be loaded. Use Refresh to try again.</p></section>}
    {data && <><div className="metric-grid"><Metric icon={<Building2/>} title="INSTITUTIONS" value={data.institutions.length} note={`${data.institutionStatus.ACTIVE ?? 0} active Ã‚Â· ${data.institutionStatus.PENDING_VERIFICATION ?? 0} pending review`}/><Metric icon={<HeartPulse/>} title="ORGAN RECORDS" value={data.organMetrics.total ?? 0} note={`${data.organMetrics.activeWorkflows ?? 0} active workflows`}/><Metric icon={<ShieldCheck/>} title="ACTIVE OFFERS" value={data.organMetrics.activeOffers ?? 0} note={`${data.organMetrics.acceptedOffers ?? 0} accepted`}/><Metric icon={<HeartPulse/>} title="PROCUREMENT" value={data.organMetrics.procurementVolume ?? 0} note={`${data.organMetrics.completed ?? 0} organ workflows completed`}/></div>
    <section className="panel admin-institution-performance"><div className="panel-heading"><div><span className="eyebrow">INSTITUTION MANAGEMENT</span><h2>Institution performance</h2><p>Performance preview for up to five institutions.</p></div><Link className="button" href="/admin/institutions">All institutions <ArrowRight size={14}/></Link></div>
      <ul className="admin-institution-list">{sortedInstitutions.slice(0, 5).map((institution) => <li key={institution.id}>
        <button type="button" className="admin-institution-row" aria-expanded={expandedInstitutionId === institution.id} onClick={() => setExpandedInstitutionId(expandedInstitutionId === institution.id ? null : institution.id)}>
          <span className="admin-institution-name"><strong>{institution.name}</strong><small>{institution.type.replaceAll("_", " ")}</small></span>
          <span className="admin-institution-stat"><strong>{institution.analytics.handledRequests}</strong><small>requests</small></span>
          <span className="admin-institution-stat"><strong>{institution.analytics.activeRequests}</strong><small>active</small></span>
          <span className={`admin-status status-${institution.status.toLowerCase()}`}>{institution.status.replaceAll("_", " ")}</span>
          <span className="admin-row-hint">{expandedInstitutionId === institution.id ? "Hide details ↑" : "View details ↓"}</span>
        </button>
        {expandedInstitutionId === institution.id && <div className="admin-institution-details">
          <div><small>Donor / recipient</small><strong>{institution.analytics.donorRequests} / {institution.analytics.recipientRequests}</strong></div>
          <div><small>Backlog</small><strong>{institution.analytics.backlog}</strong></div>
          <div><small>Matching / offers</small><strong>{institution.analytics.matchingVolume} / {institution.analytics.offerVolume}</strong></div>
          <div><small>Procurement / completed</small><strong>{institution.analytics.procurementVolume} / {institution.analytics.completed}</strong></div>
          <div><small>Completion</small><strong>{institution.analytics.completionRate}%</strong></div>
          <div className="admin-institution-location"><small>Location</small><strong>{institution.address || "—"}</strong></div>
          <div><small>Contact number</small><strong>{institution.contactNumber || institution.account?.phone || "Not provided"}</strong></div>
          <div><small>Contact email</small><strong>{institution.account?.email || "Not provided"}</strong></div>
          <InstitutionAnalyticsChart institution={institution}/>
        </div>}
      </li>)}</ul>
      <InstitutionComparisonChart institutions={sortedInstitutions.slice(0, 5)} title="Top five institutions · requests vs active"/>
    </section>
    <section className="panel admin-recent-audit"><div className="panel-heading"><div><span className="eyebrow">SYSTEM AUDIT</span><h2>Recent activity</h2><p>Latest institution and organ coordination events.</p></div><Link className="button" href="/admin/audit">View all audit activity <ArrowRight size={14}/></Link></div>{data.activity.length ? <ul className="admin-audit-preview">{data.activity.slice(0, 5).map((event) => <li key={event.id}>
      <button type="button" className="admin-audit-row" aria-expanded={expandedAuditId === event.id} onClick={() => setExpandedAuditId(expandedAuditId === event.id ? null : event.id)}><span className="admin-audit-dot"/><span className="admin-audit-summary"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{event.entityType} Â· {auditRecordLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><span className="admin-row-hint">{expandedAuditId === event.id ? "Hide" : "Details"}</span></button>
      {expandedAuditId === event.id && <dl className="admin-audit-details"><div><dt>Record ID</dt><dd>{event.entityId}</dd></div><div><dt>Actor</dt><dd>{event.actorId ?? "System"}</dd></div><div><dt>Institution</dt><dd>{event.actorInstitutionId ?? "â€”"}</dd></div><div><dt>Details</dt><dd>{formatAuditMetadata(event.metadata)}</dd></div></dl>}
    </li>)}</ul> : <p>No audit activity recorded yet.</p>}</section></>}
  </main>;
}

function Metric({ icon, title, value, note }: { icon: React.ReactNode; title: string; value: number; note: string }) { return <article className="metric-card"><span className="metric-icon teal">{icon}</span><span className="eyebrow">{title}</span><strong>{value}</strong><small>{note}</small></article>; }

function auditRecordLabel(event: AdminOverview["activity"][number]) {
  if (event.metadata && typeof event.metadata === "object" && "reference" in event.metadata) {
    return String((event.metadata as { reference: unknown }).reference);
  }
  if (event.entityType === "Institution") return "Institution record";
  return `${event.entityType} record`;
}

function formatAuditMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "No additional details";
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length ? entries.map(([key, item]) => `${key.replaceAll("_", " ")}: ${String(item)}`).join(" Â· ") : "No additional details";
}

