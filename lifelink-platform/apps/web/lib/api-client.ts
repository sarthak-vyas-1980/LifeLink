export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code?: string, public fieldErrors?: Record<string, string[]>) { super(message); this.name = "ApiFailure"; }
}

export async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window === "undefined" ? undefined : (() => { try { return JSON.parse(localStorage.getItem("lifelink.session") ?? "null")?.token as string | undefined; } catch { return undefined; } })();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  // Keep browser calls same-origin by default; Next proxies /api to the API server.
  // An explicit public URL remains available for deployments with a separately hosted API.
  const apiBase = process.env.NEXT_PUBLIC_API_URL?.replace(/\/+$/, "") ?? "";
  try { response = await fetch(`${apiBase}${path}`, { ...init, headers, cache: "no-store" }); }
  catch { throw new ApiFailure("Could not reach LifeLink. Check the API connection and try again.", 0, "NETWORK_ERROR"); }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if ((payload.code === "AUTH_INVALID" || payload.code === "AUTH_REQUIRED") && typeof window !== "undefined") {
      // A stored session is only a client-side hint; discard it when the API rejects it.
      // This avoids trapping users in a dashboard with a token from an older API session.
      localStorage.removeItem("lifelink.session");
      window.dispatchEvent(new Event("lifelink:session-invalid"));
    }
    const trace = payload.code === "INTERNAL_ERROR" && typeof payload.traceId === "string" ? ` Reference: ${payload.traceId}.` : "";
    throw new ApiFailure(`${payload.message ?? "The request could not be completed."}${trace}`, response.status, payload.code, payload.fieldErrors);
  }
  return payload as T;
}

export function submitWorkflowAction<T>(path: string, body?: unknown) {
  return requestApi<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
