"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { requestApi } from "../../../../lib/api-client";

type AuditEvent = { id: string; actorId: string | null; actorInstitutionId: string | null; action: string; entityType: string; entityId: string; metadata: unknown; createdAt: string };
type AuditResponse = { events: AuditEvent[]; pagination: { page: number; pageSize: number; total: number; totalPages: number } };

export default function AdminAuditPage() {
  const [data, setData] = useState<AuditResponse | null>(null);
  const [page, setPage] = useState(1);
  const [scope, setScope] = useState<"mine" | "operational">("operational");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void requestApi<AuditResponse>(`/api/admin/audit?page=${page}&pageSize=50&scope=${scope}`)
      .then(setData)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [page, scope]);
  useEffect(load, [load]);

  return <main className="page-stack institution-workspace admin-audit-page">
    <header className="page-heading"><div><span className="eyebrow">SYSTEM ADMINISTRATION / AUDIT</span><h1>Audit activity</h1><p>Review your own actions and activity across users, institutions, and operational workflows.</p></div><div className="offer-actions"><Link className="button" href="/admin"><ArrowLeft size={14}/> Administration</Link><button className="button" onClick={load}><RefreshCw size={14}/> Refresh</button></div></header>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="panel"><nav className="overview-tabs admin-audit-tabs" aria-label="Audit activity scope"><button type="button" aria-pressed={scope === "mine"} className={scope === "mine" ? "selected" : ""} onClick={() => { setScope("mine"); setPage(1); }}>My activity</button><button type="button" aria-pressed={scope === "operational"} className={scope === "operational" ? "selected" : ""} onClick={() => { setScope("operational"); setPage(1); }}>Operational scope</button></nav><div className="panel-heading"><div><span className="eyebrow">{scope === "mine" ? "ADMIN ACTIVITY" : "PLATFORM ACTIVITY"}</span><h2>{data?.pagination.total ?? 0} recorded events</h2><p>{scope === "mine" ? "Actions performed by your administrator account." : "User and institution account activity, plus blood and organ workflow events."} Showing page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}.</p></div></div>
      {loading ? <p>Loading audit activity…</p> : data?.events.length ? <ul className="admin-audit-full-list">{data.events.map((event) => <li key={event.id}>
        <button type="button" className="admin-audit-row" aria-expanded={expandedEventId === event.id} onClick={() => setExpandedEventId(expandedEventId === event.id ? null : event.id)}><span className="admin-audit-dot"/><span className="admin-audit-summary"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{event.entityType} · {auditRecordLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><span className="admin-row-hint">{expandedEventId === event.id ? "Hide" : "Details"}</span></button>
        {expandedEventId === event.id && <dl className="admin-audit-details"><div><dt>Record ID</dt><dd>{event.entityId}</dd></div><div><dt>Actor</dt><dd>{event.actorId ?? "System"}</dd></div><div><dt>Institution</dt><dd>{event.actorInstitutionId ?? "—"}</dd></div><div><dt>Details</dt><dd>{formatMetadata(event.metadata)}</dd></div></dl>}
      </li>)}</ul> : <p>{scope === "mine" ? "No actions have been recorded for your account yet." : "No operational activity has been recorded yet."}</p>}
      <div className="organ-form-footer"><small>{data?.pagination.total ?? 0} events · Page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}</small><div className="offer-actions"><button className="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button><button className="button" disabled={loading || page >= (data?.pagination.totalPages ?? 1)} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
    </section>
  </main>;
}

function auditRecordLabel(event: AuditEvent) {
  if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) && "reference" in event.metadata) {
    return String((event.metadata as Record<string, unknown>).reference);
  }
  if (event.entityType === "Institution") return "Institution record";
  if (event.entityType === "User") return "User account";
  return `${event.entityType} record`;
}

function formatMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key.replaceAll("_", " ")}: ${String(item)}`).join(" · ") || "—";
}
