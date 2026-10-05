"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";
import { ApiFailure, requestApi } from "../../../lib/api-client";
import { getCurrentSession, saveCurrentSession, type Session } from "../../../lib/auth";

type AccountType = "USER" | "INSTITUTION";
type AccountRole = "USER" | "ADMIN";
type InstitutionType = "HOSPITAL" | "BLOOD_BANK" | "ORGAN_CENTRE";

export default function RegisterPage() {
  const router = useRouter();
  const [accountType, setAccountType] = useState<AccountType>();
  const [institutionType, setInstitutionType] = useState<InstitutionType>();
  const [accountRole, setAccountRole] = useState<AccountRole>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [address, setAddress] = useState("");
  const [bloodServiceEnabled, setBloodServiceEnabled] = useState(false);
  const [organServiceEnabled, setOrganServiceEnabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (getCurrentSession()) router.replace("/dashboard");
  }, [router]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accountType || (accountType === "INSTITUTION" && (!institutionType || !address.trim())) || (accountType === "USER" && !accountRole)) {
      setError("Complete the account type and required details to continue.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const session = await requestApi<Session>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({
          name,
          email,
          phone,
          password,
          accountType,
          ...(accountType === "USER" ? { role: accountRole } : { institutionType, address, ...(institutionType === "HOSPITAL" ? { bloodServiceEnabled, organServiceEnabled } : {}) }),
        }),
      });
      saveCurrentSession(session);
      router.replace("/dashboard");
    } catch (cause) {
      setError(cause instanceof ApiFailure ? cause.message : "Account creation failed.");
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
          <h1>Join your care coordination network.</h1>
          <p>Create a user account or connect an account to an active institution.</p>
        </div>
        <small>LifeLink · Blood coordination</small>
      </section>

      <section className="login-main">
        <form className="login-card auth-card" onSubmit={submit}>
          <div className="login-mark"><Droplets /></div>
          <span className="eyebrow">GET STARTED</span>
          <h2>Create your account</h2>
          <p>Register as a user or create a separate organization account with its own email and phone.</p>

          <fieldset className="auth-choice-group">
            <legend>1. What type of account do you need?</legend>
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
              {accountType === "INSTITUTION" && (
                <>
                  <fieldset className="auth-choice-group">
                    <legend>2. Choose your institution type</legend>
                    <div className="auth-role-list">
                      {(["HOSPITAL", "BLOOD_BANK", "ORGAN_CENTRE"] as const).map((type) => (
                        <button key={type} type="button" className={`auth-role ${institutionType === type ? "selected" : ""}`} aria-pressed={institutionType === type} onClick={() => { setInstitutionType(type); setError(""); }}>
                          {type.replaceAll("_", " ")}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <label>Institution address<input required maxLength={300} autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
                  {institutionType === "HOSPITAL" && <fieldset className="auth-choice-group"><legend>Optional hospital services</legend><label className="auth-service-choice"><input type="checkbox" checked={bloodServiceEnabled} onChange={(event) => setBloodServiceEnabled(event.target.checked)} /> Blood coordination</label><label className="auth-service-choice"><input type="checkbox" checked={organServiceEnabled} onChange={(event) => setOrganServiceEnabled(event.target.checked)} /> Organ coordination</label></fieldset>}
                </>
              )}
              {accountType === "USER" && (
                <fieldset className="auth-choice-group">
                  <legend>2. Choose your account role</legend>
                  <div className="auth-role-list">
                    {(["USER", "ADMIN"] as const).map((role) => (
                      <button key={role} type="button" className={`auth-role ${accountRole === role ? "selected" : ""}`} aria-pressed={accountRole === role} onClick={() => { setAccountRole(role); setError(""); }}>
                        {role === "USER" ? "User" : "Admin"}
                      </button>
                    ))}
                  </div>
                </fieldset>
              )}
              <label>{accountType === "INSTITUTION" ? "Institution name" : "Full name"}<input required minLength={2} maxLength={160} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Email address<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
              <label>Phone number<input required type="tel" autoComplete="tel" inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
              <label>Password<input required type="password" minLength={6} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small className="auth-hint">Use at least 6 characters.</small></label>
            </div>
          )}

          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary login-submit" disabled={busy || !accountType || (accountType === "INSTITUTION" && (!institutionType || !address.trim())) || (accountType === "USER" && !accountRole)}>
            {busy ? "Creating account…" : "Create account"}
          </button>
          <p className="auth-register-link">Already registered? <Link href="/login">Sign in</Link></p>
        </form>
      </section>
    </main>
  );
}
