export class ApiFailure extends Error {
  constructor(message: string, public status: number, public code?: string, public fieldErrors?: Record<string, string[]>) { super(message); this.name = "ApiFailure"; }
}

export async function requestApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = typeof window === "undefined" ? undefined : (() => { try { return JSON.parse(localStorage.getItem("lifelink.session") ?? "null")?.token as string | undefined; } catch { return undefined; } })();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  let response: Response;
  try { response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}${path}`, { ...init, headers, cache: "no-store" }); }
  catch { throw new ApiFailure("Could not reach LifeLink. Check the API connection and try again.", 0, "NETWORK_ERROR"); }
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiFailure(payload.message ?? "The request could not be completed.", response.status, payload.code, payload.fieldErrors);
  return payload as T;
}

export function submitWorkflowAction<T>(path: string, body?: unknown) {
  return requestApi<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
