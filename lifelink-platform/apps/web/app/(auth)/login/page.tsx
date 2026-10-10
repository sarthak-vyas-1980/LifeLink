"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";
import { ApiFailure, requestApi } from "../../../lib/api-client";
import { getCurrentSession, saveCurrentSession, type Session } from "../../../lib/auth";

type AccountType = "USER" | "INSTITUTION";

export default function LoginPage() {
  const router = useRouter();
  const [accountType, setAccountType] = useState<AccountType>();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const session = getCurrentSession();
    if (session) router.replace(session.user.institutionId ? "/institution" : "/dashboard");
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountType) {
      setError("Choose the account type before signing in.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const session = await requestApi<Session>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email,
          ...(phone.trim() ? { phone: phone.trim() } : {}),
          password,
          accountType,
        }),
      });
      saveCurrentSession(session);
      router.replace(session.user.institutionId ? "/institution" : "/dashboard");
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : "Sign in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-aside">
        <div className="login-brand"><span className="brand-icon"><Droplets /></span>LifeLink</div>
        <div>
          <span className="eyebrow">CARE COORDINATION NETWORK</span>
          <h1>When care can’t wait, every connection matters.</h1>
          <p>Coordinate blood requests, confirmed offers, and delivery updates from one secure workspace.</p>
        </div>
        <small>LifeLink · Blood coordination</small>
      </section>

      <section className="login-main">
        <form className="login-card auth-card" onSubmit={submit}>
          <div className="login-mark"><Droplets /></div>
          <span className="eyebrow">WELCOME BACK</span>
          <h2>Sign in to LifeLink</h2>
          <p>Choose your account type, then enter the credentials registered to your account.</p>

          <fieldset className="auth-choice-group">
            <legend>1. What type of account do you use?</legend>
            <div className="auth-choice-row">
              <button type="button" className={`auth-choice ${accountType === "USER" ? "selected" : ""}`} aria-pressed={accountType === "USER"} onClick={() => { setAccountType("USER"); setError(""); }}>
                <strong>User</strong><span>Use donation or recipient services</span>
              </button>
              <button type="button" className={`auth-choice ${accountType === "INSTITUTION" ? "selected" : ""}`} aria-pressed={accountType === "INSTITUTION"} onClick={() => { setAccountType("INSTITUTION"); setError(""); }}>
                <strong>Institution</strong><span>Hospital or care centre</span>
              </button>
            </div>
          </fieldset>

          {accountType && (
            <div className="auth-credentials">
              <label>Email address<input type="email" required autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label>Phone number (optional)<input type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
              <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              <p className="auth-hint">Sign in with your registered email and password. If you enter a phone number, it must match your account.</p>
            </div>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary login-submit" disabled={busy || !accountType}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <p className="auth-register-link">Need an account? <Link href="/register">Create one</Link></p>
        </form>
      </section>
    </main>
  );
}
