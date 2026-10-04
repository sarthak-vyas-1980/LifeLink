"use client";
import { FormEvent,useEffect,useState } from "react";
import { useRouter } from "next/navigation";
import { Droplets } from "lucide-react";
import { ApiFailure,requestApi } from "../../../lib/api-client";
import { getCurrentSession,saveCurrentSession,type Session } from "../../../lib/auth";

export default function LoginPage(){const router=useRouter();const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);useEffect(()=>{if(getCurrentSession())router.replace("/dashboard");},[router]);
const submit=async(e:FormEvent)=>{e.preventDefault();setBusy(true);setError("");try{const session=await requestApi<Session>("/api/auth/login",{method:"POST",body:JSON.stringify({email,password})});saveCurrentSession(session);router.replace("/dashboard");}catch(err){setError(err instanceof ApiFailure?err.message:"Sign in failed.");}finally{setBusy(false);}};
return <main className="login-screen"><div className="login-aside"><div className="login-brand"><span className="brand-icon"><Droplets/></span>LifeLink</div><div><span className="eyebrow">CARE COORDINATION NETWORK</span><h1>When care can’t wait, every connection matters.</h1><p>Coordinate blood requests, confirmed offers, and delivery updates from one secure workspace.</p></div><small>LifeLink · Blood coordination</small></div><div className="login-main"><form className="login-card" onSubmit={submit}><div className="login-mark"><Droplets/></div><span className="eyebrow">WELCOME BACK</span><h2>Sign in to LifeLink</h2><p>Use the account provided by your institution or care team.</p><label>Email address<input type="email" required autoComplete="username" value={email} onChange={(e)=>setEmail(e.target.value)}/></label><label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(e)=>setPassword(e.target.value)}/></label>{error&&<p className="error">{error}</p>}<button className="button primary login-submit" disabled={busy}>{busy?"Signing in…":"Sign in"}</button>
<div style={{ marginTop: "1.25rem", paddingTop: "1rem", borderTop: "1px solid rgba(255,255,255,0.12)", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
  <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "rgba(255,255,255,0.6)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Quick Preview (Frontend Demo)</span>
  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
    <button type="button" className="button quiet" onClick={() => {
      saveCurrentSession({ token: "demo-hospital-token", user: { id: "usr_hosp_1", name: "Dr. Sarah Adams", email: "sarah.adams@hospital.test", role: "HOSPITAL_USER", institutionId: "inst_metro_hospital" } });
      router.replace("/requests");
    }}>Hospital Coordinator</button>
    <button type="button" className="button quiet" onClick={() => {
      saveCurrentSession({ token: "demo-bloodbank-token", user: { id: "usr_bank_1", name: "Marcus Vance", email: "marcus@bloodbank.test", role: "BLOOD_BANK_USER", institutionId: "inst_bloodbank-1" } });
      router.replace("/requests");
    }}>Blood Bank Coordinator</button>
  </div>
</div>
</form></div></main>;}
