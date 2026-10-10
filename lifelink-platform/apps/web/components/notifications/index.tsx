"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiFailure, requestApi, submitWorkflowAction } from "../../lib/api-client";
import { subscribeToWorkflowEvents } from "../../lib/socket-client";

type Notification = {
  id: string;
  title: string;
  message: string;
  type: string;
  status: string;
  createdAt: string;
  requestId?: string | null;
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
                <article className={`notification-row ${item.status === "UNREAD" ? "unread" : ""}`} key={item.id}>
                  <span className="notification-bullet" />
                  <div className="notification-content">
                    <div className="notification-title">
                      <strong>{item.title}</strong>
                      <time>{new Date(item.createdAt).toLocaleString()}</time>
                    </div>
                    <p>{item.message}</p>
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
