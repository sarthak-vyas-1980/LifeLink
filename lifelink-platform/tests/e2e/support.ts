import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// End-to-end suites talk to a running deployment over HTTP and create real accounts and requests,
// so they only run when the target is explicitly confirmed as a test deployment.
export const apiUrl = process.env.LIFELINK_E2E_API_URL?.trim().replace(/\/+$/, "");
export const e2eSkip: string | false = !apiUrl
  ? "Set LIFELINK_E2E_API_URL (for example http://127.0.0.1:4000) to run end-to-end tests."
  : process.env.LIFELINK_E2E_ALLOW_WRITES !== "YES"
    ? "Set LIFELINK_E2E_ALLOW_WRITES=YES to confirm the API uses a test database; these tests create accounts and requests."
    : false;

export const PHONE = "+91 98765 43210";
export const PASSWORD = "e2e-password-1";
const runId = randomUUID().slice(0, 8);

export interface Account { id: string; token: string; email: string; kind: "USER" | "INSTITUTION" }
const accounts: Account[] = [];

export async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as any };
}

export async function register(kind: "USER" | "HOSPITAL" | "BLOOD_BANK" | "ORGAN_CENTRE", name: string, extra: Record<string, unknown> = {}): Promise<Account> {
  const email = `e2e.${name.toLowerCase().replaceAll(" ", ".")}.${runId}@example.test`;
  const body = kind === "USER"
    ? { name, email, phone: PHONE, password: PASSWORD, accountType: "USER", role: "USER", ...extra }
    : { name: `E2E ${name} ${runId}`, email, phone: PHONE, password: PASSWORD, accountType: "INSTITUTION", institutionType: kind, address: "E2E Test Road, Indore", ...extra };
  const result = await call("POST", "/api/auth/register", { body });
  assert.equal(result.status, 201, `registration failed: ${JSON.stringify(result.body)}`);
  const account: Account = { id: result.body.user.id, token: result.body.token, email, kind: kind === "USER" ? "USER" : "INSTITUTION" };
  accounts.push(account);
  return account;
}

// Close every account this run created through the same public API a user would use.
export async function closeAccounts() {
  for (const account of accounts.splice(0)) {
    await call("DELETE", account.kind === "USER" ? "/api/users/me" : "/api/institutions/me", { token: account.token, body: { password: PASSWORD } }).catch(() => undefined);
  }
}
