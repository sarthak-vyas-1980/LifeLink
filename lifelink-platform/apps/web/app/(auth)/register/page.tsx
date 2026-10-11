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
  const [emergencySupportEnabled, setEmergencySupportEnabled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const session = getCurrentSession();
    if (session) router.replace(session.user.institutionId ? "/institution" : "/dashboard");
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
          ...(accountType === "USER" ? { role: accountRole } : { institutionType, address, ...(institutionType === "HOSPITAL" ? { bloodServiceEnabled, organServiceEnabled, emergencySupportEnabled } : {}) }),
        }),
      });
      saveCurrentSession(session);
      router.replace(session.user.institutionId ? "/institution" : "/dashboard");
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
          <span className="eyebrow">LIFESAVING NETWORK</span>
          <h1>Join the network for lifesaving services.</h1>
          <p>Create a personal account or register an institution to coordinate blood and organ services.</p>
        </div>
        <small>LifeLink · Blood &amp; Organ Services</small>
      </section>

      <section className="login-main">
        <form className="login-card auth-card" onSubmit={submit}>
          <div className="login-mark"><Droplets /></div>
          <span className="eyebrow">GET STARTED</span>
          <h2>Create your account</h2>
          <p>Create an individual account or register a hospital, blood bank, or organ centre.</p>

          <fieldset className="auth-choice-group">
            <legend>1. What type of account do you need?</legend>
            <div className="auth-choice-row">
              <button type="button" className={`auth-choice ${accountType === "USER" ? "selected" : ""}`} aria-pressed={accountType === "USER"} onClick={() => { setAccountType("USER"); setError(""); }}>
                <strong>Individual</strong><span>Personal use or platform administration</span>
              </button>
              <button type="button" className={`auth-choice ${accountType === "INSTITUTION" ? "selected" : ""}`} aria-pressed={accountType === "INSTITUTION"} onClick={() => { setAccountType("INSTITUTION"); setError(""); }}>
                <strong>Institution</strong><span>Hospitals, blood banks, and organ centres</span>
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
                  {institutionType === "HOSPITAL" && <fieldset className="auth-choice-group"><legend>Optional hospital services</legend><div className="auth-service-list"><label className="auth-service-choice"><input type="checkbox" checked={bloodServiceEnabled} onChange={(event) => setBloodServiceEnabled(event.target.checked)} /> Blood coordination</label><label className="auth-service-choice"><input type="checkbox" checked={organServiceEnabled} onChange={(event) => setOrganServiceEnabled(event.target.checked)} /> Organ coordination</label><label className="auth-service-choice"><input type="checkbox" checked={emergencySupportEnabled} onChange={(event) => setEmergencySupportEnabled(event.target.checked)} /> Emergency support</label></div></fieldset>}
                </>
              )}
              {accountType === "USER" && (
                <fieldset className="auth-choice-group">
                  <legend>2. Choose your account role</legend>
                  <div className="auth-role-list">
                    {(["USER", "ADMIN"] as const).map((role) => (
                      <button key={role} type="button" className={`auth-role ${accountRole === role ? "selected" : ""}`} aria-pressed={accountRole === role} onClick={() => { setAccountRole(role); setError(""); }}>
                        {role === "USER" ? "Individual" : "Admin"}
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
