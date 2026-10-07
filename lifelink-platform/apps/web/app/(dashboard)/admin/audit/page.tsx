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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    void requestApi<AuditResponse>(`/api/admin/audit?page=${page}&pageSize=50`)
      .then(setData)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [page]);
  useEffect(load, [load]);

  return <main className="page-stack institution-workspace admin-audit-page">
    <header className="page-heading"><div><span className="eyebrow">SYSTEM ADMINISTRATION / AUDIT</span><h1>Audit activity</h1><p>Recorded institution and organ coordination actions.</p></div><div className="offer-actions"><Link className="button" href="/admin"><ArrowLeft size={14}/> Administration</Link><button className="button" onClick={load}><RefreshCw size={14}/> Refresh</button></div></header>
    {error && <div className="error" role="alert">{error}</div>}
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">AUDIT LOG</span><h2>{data?.pagination.total ?? 0} recorded events</h2><p>Showing page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}.</p></div></div>
      {loading ? <p>Loading audit activity…</p> : data?.events.length ? <ul className="admin-audit-full-list">{data.events.map((event) => <li key={event.id}>
        <button type="button" className="admin-audit-row" aria-expanded={expandedEventId === event.id} onClick={() => setExpandedEventId(expandedEventId === event.id ? null : event.id)}><span className="admin-audit-dot"/><span className="admin-audit-summary"><strong>{event.action.replaceAll("_", " ").toLowerCase()}</strong><small>{event.entityType} · {auditRecordLabel(event)}</small></span><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time><span className="admin-row-hint">{expandedEventId === event.id ? "Hide" : "Details"}</span></button>
        {expandedEventId === event.id && <dl className="admin-audit-details"><div><dt>Record ID</dt><dd>{event.entityId}</dd></div><div><dt>Actor</dt><dd>{event.actorId ?? "System"}</dd></div><div><dt>Institution</dt><dd>{event.actorInstitutionId ?? "—"}</dd></div><div><dt>Details</dt><dd>{formatMetadata(event.metadata)}</dd></div></dl>}
      </li>)}</ul> : <p>No audit activity recorded yet.</p>}
      <div className="organ-form-footer"><small>{data?.pagination.total ?? 0} events · Page {page} of {Math.max(1, data?.pagination.totalPages ?? 1)}</small><div className="offer-actions"><button className="button" disabled={page <= 1 || loading} onClick={() => setPage((current) => current - 1)}>Previous</button><button className="button" disabled={loading || page >= (data?.pagination.totalPages ?? 1)} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
    </section>
  </main>;
}

function auditRecordLabel(event: AuditEvent) {
  if (event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata) && "reference" in event.metadata) {
    return String((event.metadata as Record<string, unknown>).reference);
  }
  return event.entityType === "Institution" ? "Institution record" : `${event.entityType} record`;
}

function formatMetadata(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "—";
  return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key.replaceAll("_", " ")}: ${String(item)}`).join(" · ") || "—";
}
