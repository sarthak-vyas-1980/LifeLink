import { disconnectRealtime } from "./socket-client";
import { requestApi } from "./api-client";

export interface SessionUser { id: string; name: string; email: string; role: string; accountRole?: "USER" | "ADMIN"; institutionId?: string | null }
export interface Session { token: string; user: SessionUser }
const STORAGE_KEY = "lifelink.session";

export function getCurrentSession(): Session | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Session | null;
    if (!value?.token || !value.user || value.token.startsWith("demo-")) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return value;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}
export function saveCurrentSession(session: Session) { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); }
export function resolveRoleDestination(role?: string) { return role ? "/dashboard" : "/login"; }
export async function signOut() {
  try { await requestApi("/api/auth/logout", { method: "POST" }); } finally { disconnectRealtime(); localStorage.removeItem(STORAGE_KEY); }
}
