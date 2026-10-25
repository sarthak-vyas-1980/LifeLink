"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiFailure, requestApi, submitWorkflowAction } from "../../lib/api-client";
import { subscribeToWorkflowEvents } from "../../lib/socket-client";

type Notification = {
  id: string;
  title: string;
  message: string;
  type: string;
  eventType?: string | null;
  status: string;
  createdAt: string;
  requestId?: string | null;
  payload?: {
    reference?: string | null;
    organType?: string | null;
    bloodGroup?: string | null;
    requiredBy?: string | null;
    institutionName?: string | null;
    requestReference?: string | null;
    component?: string | null;
    quantity?: number | null;
    priority?: string | null;
    location?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    offerStatus?: string | null;
    unitsAvailable?: number | null;
    unitsReserved?: number | null;
  } | null;
};

const PAGE_SIZE = 10;

export default function NotificationsInbox() {
  const [items, setItems] = useState<Notification[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    return requestApi<{ notifications: Notification[]; hasMore: boolean }>(
      `/api/notifications?limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`,
    )
      .then((response) => {
        setItems(response.notifications);
        setHasMore(response.hasMore);
      })
      .catch((cause) => {
        setError(cause instanceof ApiFailure ? cause.message : "Could not load notifications.");
      })
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    void load();
    return subscribeToWorkflowEvents(() => void load());
  }, [load]);

  const markRead = async (id: string) => {
    try {
      await submitWorkflowAction(`/api/notifications/${id}/read`);
      setItems((current) => current.map((item) => (item.id === id ? { ...item, status: "READ" } : item)));
      window.dispatchEvent(new Event("lifelink:notifications-changed"));
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : "Could not update notification.");
    }
  };

  const firstItem = items.length ? (page - 1) * PAGE_SIZE + 1 : 0;
  const lastItem = (page - 1) * PAGE_SIZE + items.length;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <span className="eyebrow">REAL-TIME UPDATES</span>
          <h1>Notifications</h1>
          <p>Messages scoped to your account and authorized workflow participation.</p>
        </div>
        <button className="button quiet" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh inbox"}
        </button>
      </header>
      <section className="panel inbox-list">
        {error && <p className="error">{error}</p>}
        {items.length === 0 ? (
          <p className="empty">{loading ? "Loading notifications…" : "You are all caught up."}</p>
        ) : (
          <>
            <div className="notification-rows">
              {items.map((item) => (
                <article className={`notification-row ${item.status === "UNREAD" ? "unread" : ""} ${item.eventType?.startsWith("EMERGENCY") || item.title.toUpperCase().includes("EMERGENCY") ? "emergency" : ""}`} key={item.id}>
                  <span className="notification-bullet" />
                  <div className="notification-content">
                    <div className="notification-title">
                      <strong>{item.title}</strong>
                      {(item.eventType?.startsWith("EMERGENCY") || item.title.toUpperCase().includes("EMERGENCY")) && <span className="notification-emergency-tag">Emergency</span>}
                      <time>{new Date(item.createdAt).toLocaleString()}</time>
                    </div>
                    <p>{item.message}</p>
                    {item.eventType?.startsWith("REQUEST_") || item.eventType === "OFFER_STATUS_CHANGED" || item.eventType === "RESERVATION_EXPIRED" ? (
                      item.payload?.bloodGroup && (
                        <div className="notification-workflow-details">
                          <span><small>Request</small><b>{item.payload.quantity ?? "—"} × {formatBloodGroup(item.payload.bloodGroup)} {formatComponent(item.payload.component)}</b></span>
                          {item.payload.location && <span><small>Location</small><b>{item.payload.location}</b></span>}
                          {item.payload.institutionName && <span><small>Institution</small><b>{item.payload.institutionName}</b></span>}
                          {item.payload.toStatus && <span><small>Workflow step</small><b>{humanizeStatus(item.payload.toStatus)}</b></span>}
                          {item.payload.offerStatus && <span><small>Offer status</small><b>{humanizeStatus(item.payload.offerStatus)}</b></span>}
                          {typeof item.payload.unitsAvailable === "number" && <span><small>Available stock</small><b>{item.payload.unitsAvailable} units</b></span>}
                          {typeof item.payload.unitsReserved === "number" && item.payload.unitsReserved > 0 && <span><small>Reserved stock</small><b>{item.payload.unitsReserved} units</b></span>}
                        </div>
                      )
                    ) : null}
                    {item.eventType === "EMERGENCY_ORGAN_RECIPIENT_BROADCAST" && (
                      <details className="notification-emergency-details">
                        <summary><span>View request details</span><span>Hide request details</span></summary>
                        <div>
                          <span><small>Organ required</small><b>{item.payload?.organType?.replaceAll("_", " ") ?? "Not specified"}</b></span>
                          <span><small>Blood type</small><b>{formatBloodGroup(item.payload?.bloodGroup)}</b></span>
                          <span><small>Requirement deadline</small><b>{formatDeadline(item.payload?.requiredBy)}</b></span>
                          <span><small>Request reference</small><b>{item.payload?.reference ?? "Not specified"}</b></span>
                        </div>
                      </details>
                    )}
                    {item.status === "UNREAD" && (
                      <button className="text-button" onClick={() => void markRead(item.id)}>
                        Mark as read
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
            {(page > 1 || hasMore) && (
              <nav className="notification-pagination" aria-label="Notifications pages">
                <small>
                  Showing {firstItem}–{lastItem}
                </small>
                <div>
                  <button
                    className="button quiet"
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={page === 1 || loading}
                  >
                    Previous
                  </button>
                  <span>Page {page}</span>
                  <button className="button quiet" onClick={() => setPage((current) => current + 1)} disabled={!hasMore || loading}>
                    Next
                  </button>
                </div>
              </nav>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function formatDeadline(value?: string | null) {
  if (!value) return "Not specified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not specified" : date.toLocaleString();
}

function formatBloodGroup(value?: string | null) {
  if (!value) return "Not specified";
  return value.endsWith("_POSITIVE")
    ? `${value.slice(0, -"_POSITIVE".length)}+`
    : value.endsWith("_NEGATIVE")
      ? `${value.slice(0, -"_NEGATIVE".length)}−`
      : value.replaceAll("_", " ");
}

function formatComponent(value?: string | null) {
  return value?.replaceAll("_", " ").toLowerCase() ?? "blood";
}

function humanizeStatus(value: string) {
  return value.toLowerCase().replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}
