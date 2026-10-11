"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { getCurrentSession, signOut } from "../../lib/auth";
import { ApiFailure, requestApi } from "../../lib/api-client";

type Preferences = { workflow: boolean; emergency: true };
type ProfileData = { name: string; email: string; phone?: string | null; address?: string | null; contactPerson?: string | null; contactNumber?: string | null; notificationPreferences?: Preferences; type?: string; status?: string; account?: { email: string; phone?: string } };

export default function ProfileManager() {
  const router = useRouter();
  const [isInstitution, setIsInstitution] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [preferences, setPreferences] = useState<Preferences>({ workflow: true, emergency: true });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const endpoint = isInstitution ? "/api/institutions/me" : "/api/users/me";
  useEffect(() => {
    const session = getCurrentSession();
    if (!session) { router.replace("/login"); return; }
    const institution = session.user.principalType === "INSTITUTION" || Boolean(session.user.institutionId);
    setIsInstitution(institution);
    void requestApi<{ institution?: ProfileData } & ProfileData>(institution ? "/api/institutions/me" : "/api/users/me")
      .then((payload) => {
        const data = payload.institution ?? payload;
        setProfile(data);
        setName(data.name ?? "");
        setEmail(data.email ?? data.account?.email ?? session.user.email ?? "");
        setPhone(data.contactNumber ?? data.phone ?? data.account?.phone ?? "");
        setAddress(data.address ?? "");
        setContactPerson(data.contactPerson ?? "");
        setPreferences({ workflow: data.notificationPreferences?.workflow ?? true, emergency: true });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Could not load the profile."));
  }, [router]);

  async function run(action: string, task: () => Promise<void>) {
    setBusy(action); setError(""); setMessage("");
    try { await task(); } catch (cause) { setError(cause instanceof ApiFailure ? cause.message : cause instanceof Error ? cause.message : "The change could not be saved."); }
    finally { setBusy(""); }
  }

  function saveProfile(event: FormEvent) {
    event.preventDefault();
    void run("profile", async () => {
      let data: ProfileData;
      if (isInstitution) {
        const result = await requestApi<{ institution: ProfileData }>(endpoint, { method: "PATCH", body: JSON.stringify({ name, email, address, contactPerson: contactPerson || null, contactNumber: phone || null }) });
        data = result.institution;
      } else {
        const emailChanged = email.trim().toLowerCase() !== profile?.email.toLowerCase();
        data = await requestApi<ProfileData>(endpoint, { method: "PATCH", body: JSON.stringify({ name, phone, address: address || null }) });
        setProfile({ ...profile, ...data });
        if (emailChanged) {
          try {
            const result = await requestApi<{ email: string }>("/api/users/me/email", { method: "PATCH", body: JSON.stringify({ email, currentPassword: emailPassword }) });
            data = { ...data, email: result.email };
            setEmail(result.email);
            setEmailPassword("");
          } catch (cause) {
            setEmailPassword("");
            setError(cause instanceof ApiFailure ? cause.message : cause instanceof Error ? cause.message : "Email was not changed.");
            setMessage("Your other profile details were saved. The email address was not changed.");
            return;
          }
        }
      }
      setProfile({ ...profile, ...data, email: data.email ?? email });
      setMessage("Profile details saved.");
    });
  }

  function savePreferences(event: FormEvent) {
    event.preventDefault();
    void run("preferences", async () => {
      await requestApi(isInstitution ? "/api/institutions/me/notification-preferences" : "/api/users/me/notification-preferences", { method: "PATCH", body: JSON.stringify(preferences) });
      setMessage("Notification preferences saved.");
    });
  }

  function changePassword(event: FormEvent) {
    event.preventDefault();
    void run("password", async () => {
      await requestApi(isInstitution ? "/api/institutions/me/password" : "/api/users/me/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      await signOut().catch(() => {}); router.replace("/login");
    });
  }

  function deleteProfile(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm("Close this account? Your profile will be deactivated and retained as a soft-deleted record.")) return;
    void run("delete", async () => {
      await requestApi(isInstitution ? "/api/institutions/me" : "/api/users/me", { method: "DELETE", body: JSON.stringify({ password: deletePassword }) });
      await signOut().catch(() => {}); router.replace("/login");
    });
  }

  if (!profile && !error) return <main className="page-stack"><section className="panel">Loading profile…</section></main>;
  return <main className="page-stack profile-page">
    <header className="page-heading"><div><span className="eyebrow">ACCOUNT SETTINGS</span><h1>Profile</h1><p>Manage your details, security, and notification preferences.</p></div></header>
    {message && <div className="profile-notice success" role="status">{message}</div>}{error && <div className="profile-notice error" role="alert">{error}</div>}
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">PROFILE DETAILS</span><h2>{isInstitution ? "Institution contact details" : "Personal details"}</h2><p>Keep the information used to contact you or your organization up to date.</p></div></div>
      <form className="profile-form" onSubmit={saveProfile}>
        <label>{isInstitution ? "Institution name" : "Full name"}<input required minLength={2} maxLength={160} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>{isInstitution ? "Account email" : "Login email"}<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /><small>{isInstitution ? "Changing this also changes the institution login email." : "Changing your login email requires your current password."}</small></label>
        {!isInstitution && email.trim().toLowerCase() !== profile?.email.toLowerCase() && <label>Current password to authorize email change<input type="password" autoComplete="current-password" required value={emailPassword} onChange={(e) => setEmailPassword(e.target.value)} /></label>}
        {isInstitution && <label>Contact person<input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} /></label>}
        <label>{isInstitution ? "Contact number" : "Phone number"}<input type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        <label className="profile-wide">Address<textarea rows={3} value={address} onChange={(e) => setAddress(e.target.value)} /></label>
        <div className="profile-wide profile-actions"><button className="button primary" disabled={busy === "profile"}>{busy === "profile" ? "Saving…" : "Save details"}</button></div>
      </form>
    </section>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">NOTIFICATIONS</span><h2>Notification preferences</h2><p>Emergency broadcasts stay enabled so urgent requests can reach every account.</p></div></div>
      <form className="profile-preferences" onSubmit={savePreferences}><label><span><strong>Workflow updates</strong><small>Receive routine request and coordination notifications.</small></span><input type="checkbox" checked={preferences.workflow} onChange={(e) => setPreferences({ workflow: e.target.checked, emergency: true })} /></label><label><span><strong>Emergency broadcasts</strong><small>Always on for verified emergency requests.</small></span><input type="checkbox" checked disabled aria-label="Emergency broadcasts always enabled" /></label><button className="button primary" disabled={busy === "preferences"}>{busy === "preferences" ? "Saving…" : "Save preferences"}</button></form>
    </section>
    <section className="panel"><div className="panel-heading"><div><span className="eyebrow">SECURITY</span><h2>Change password</h2><p>Enter your current password to set a new one. You will be signed out on success.</p></div></div>
      <form className="profile-form profile-password" onSubmit={changePassword}><label>Current password<input type="password" autoComplete="current-password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></label><label>New password<input type="password" autoComplete="new-password" minLength={6} required value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /><small>Use at least 6 characters.</small></label><div className="profile-wide profile-actions"><button className="button primary" disabled={busy === "password"}>{busy === "password" ? "Updating…" : "Update password"}</button></div></form>
    </section>
    <section className="panel profile-danger"><div className="panel-heading"><div><span className="eyebrow">ACCOUNT CLOSURE</span><h2>Delete {isInstitution ? "institution profile" : "account"}</h2><p>This deletes your {isInstitution ? "institution profile" : "account"} from active use and releases its login email for reuse. Records needed for existing workflows and audit history are retained.</p></div></div>
      <form className="profile-delete" onSubmit={deleteProfile}><label>Confirm with your password<input type="password" autoComplete="current-password" required value={deletePassword} onChange={(e) => setDeletePassword(e.target.value)} /></label><button className="button danger" disabled={busy === "delete"}>{busy === "delete" ? "Deleting…" : isInstitution ? "Delete institution profile" : "Delete account"}</button></form>
    </section>
  </main>;
}
