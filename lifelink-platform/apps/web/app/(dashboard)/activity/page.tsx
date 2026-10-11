"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { requestApi } from "../../../lib/api-client";
import { getCurrentSession } from "../../../lib/auth";

type AuditEvent = { id: string; actorId: string | null; actorInstitutionId: string | null; action: string; entityType: string; entityId: string; metadata: unknown; createdAt: string };
type AuditResponse = { events: AuditEvent[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } };

export default function ActivityPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<"mine" | "operational">("mine");
  const [institutionAccount, setInstitutionAccount] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    setInstitutionAccount(getCurrentSession()?.user.principalType === "INSTITUTION");
    if (new URLSearchParams(window.location.search).get("scope") === "operational") setScope("operational");
  }, []);
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void requestApi<AuditResponse>(`/api/audit?page=${page}&pageSize=25&scope=${institutionAccount ? scope : "mine"}`)
      .then(setData)
      .catch((reason: Error) => setError(reason.message || "Could not load activity."))
      .finally(() => setLoading(false));
  }, [page, scope, institutionAccount]);
  useEffect(load, [load]);

  return <main className="page-stack institution-workspace admin-audit-page">
    <header className="page-heading"><div><span className="eyebrow">ACCOUNT / ACTIVITY</span><h1>{institutionAccount && scope === "operational" ? "Institution operational activity" : "Your activity"}</h1><p>{institutionAccount && scope === "operational" ? "Audit events tied to your institution’s requests, inventory, and organ workflows." : "Audit records for actions performed by your account."}</p></div><div className="offer-actions"><Link className="button" href="/dashboard"><ArrowLeft size={14}/> Overview</Link><button className="button" onClick={load} disabled={loading}><RefreshCw size={14}/> Refresh</button></div></header>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="panel">{institutionAccount && <nav className="overview-tabs admin-audit-tabs" aria-label="Activity scope"><button type="button" aria-pressed={scope === "mine"} className={scope === "mine" ? "selected" : ""} onClick={() => { setScope("mine"); setPage(1); }}>My activity</button><button type="button" aria-pressed={scope === "operational"} className={scope === "operational" ? "selected" : ""} onClick={() => { setScope("operational"); setPage(1); }}>Operational scope</button></nav>}<div className="panel-heading"><div><span className="eyebrow">AUDIT LOG</span><h2>{data?.pagination.total ?? 0} recorded events</h2><p>Showing page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}.</p></div></div>
      {loading ? <p>Loading activity…</p> : data?.events.length ? <ul className="admin-audit-full-list">{data.events.map((event) => <li key={event.id}>
        <button type="button" className="admin-audit-row" aria-expanded={expandedId === event.id} onClick={() => setExpandedId(expandedId === event.id ? null : event.id)}><span className="admin-audit-dot"/><span className="admin-audit-summary"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{event.entityType} · {auditRecordLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><span className="admin-row-hint">{expandedId === event.id ? "Hide" : "Details"}</span></button>
        {expandedId === event.id && <dl className="admin-audit-details"><div><dt>Record ID</dt><dd>{event.entityId}</dd></div><div><dt>Actor</dt><dd>{event.actorId ? "You" : "System"}</dd></div><div><dt>Institution</dt><dd>{event.actorInstitutionId ?? "—"}</dd></div><div><dt>Details</dt><dd>{formatMetadata(event.metadata)}</dd></div></dl>}
      </li>)}</ul> : <p>No activity recorded yet.</p>}
      <div className="organ-form-footer"><small>{data?.pagination.total ?? 0} events · Page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}</small><div className="offer-actions"><button className="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button><button className="button" disabled={loading || page >= (data?.pagination.totalPages ?? 1)} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
    </section>
  </main>;
}

function auditRecordLabel(event: AuditEvent) {
  if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)) {
    const metadata = event.metadata as Record<string, unknown>;
    const reference = metadata.reference ?? metadata.donorReference ?? metadata.recipientReference;
    if (reference) return String(reference);
  }
  if (event.entityType === "Institution") return "Institution record";
  if (event.entityType === "User") return "User account";
  return `${event.entityType} record`;
}

function formatMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key.replaceAll("_", " ")}: ${String(item)}`).join(" · ") || "—";
}
