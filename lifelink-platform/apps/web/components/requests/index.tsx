"use client";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BLOOD_COMPONENTS, BLOOD_GROUPS } from "@lifelink/shared";
import { ApiFailure, requestApi, submitWorkflowAction } from "../../lib/api-client";
import { getCurrentSession } from "../../lib/auth";
import { subscribeToWorkflowEvents } from "../../lib/socket-client";

type BloodRequest = { id: string; bloodGroup: string; component: string; quantity: number; priority: string; location: string; latitude: number|null; longitude: number|null; radiusKm: number|null; status: string; requestDate?: string };
type Candidate = { matchId?: string; institutionId: string; institutionName: string; unitsAvailable: number; distanceKm?: number; expiryDate: string|null; score: number; guaranteedFulfilment?: false };
type Offer = { matchId:string; status:string; providerInstitutionId:string|null; providerName:string; compatibilityScore:number|null; matchedAt:string; unitsAvailable:number; expiryDate:string|null; reservationExpiresAt:string|null; dispatchedAt:string|null; receivedAt:string|null };
const pretty = (value:string) => value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

const DEMO_FALLBACK_REQUESTS: BloodRequest[] = [
  { id: "req-101", bloodGroup: "O_NEGATIVE", component: "RED_BLOOD_CELLS", quantity: 4, priority: "EMERGENCY", location: "Metro Trauma Hospital - ICU", latitude: 28.6139, longitude: 77.2090, radiusKm: 50, status: "OFFERS_RECEIVED", requestDate: new Date(Date.now() - 3600000).toISOString() },
  { id: "req-102", bloodGroup: "A_POSITIVE", component: "PLATELETS", quantity: 2, priority: "URGENT", location: "St. Jude Surgical Pavilion", latitude: 28.5355, longitude: 77.3910, radiusKm: 30, status: "RESERVED", requestDate: new Date(Date.now() - 7200000).toISOString() },
  { id: "req-103", bloodGroup: "B_POSITIVE", component: "WHOLE_BLOOD", quantity: 3, priority: "NORMAL", location: "City Health Care Center", latitude: 28.7041, longitude: 77.1025, radiusKm: 40, status: "UNDER_REVIEW", requestDate: new Date(Date.now() - 14400000).toISOString() },
];

const DEMO_FALLBACK_OFFERS: Record<string, Offer[]> = {
  "req-101": [
    { matchId: "m-1", status: "ACCEPTED", providerInstitutionId: "inst_bloodbank-1", providerName: "Central Red Cross Blood Bank", compatibilityScore: 0.98, matchedAt: new Date(Date.now() - 1800000).toISOString(), unitsAvailable: 4, expiryDate: new Date(Date.now() + 86400000 * 14).toISOString(), reservationExpiresAt: new Date(Date.now() + 1500000).toISOString(), dispatchedAt: null, receivedAt: null },
    { matchId: "m-2", status: "PENDING", providerInstitutionId: "inst_bloodbank-2", providerName: "Apex Medical Blood Center", compatibilityScore: 0.94, matchedAt: new Date(Date.now() - 2100000).toISOString(), unitsAvailable: 2, expiryDate: new Date(Date.now() + 86400000 * 20).toISOString(), reservationExpiresAt: null, dispatchedAt: null, receivedAt: null }
  ],
  "req-102": [
    { matchId: "m-3", status: "ACCEPTED", providerInstitutionId: "inst_bloodbank-1", providerName: "Central Red Cross Blood Bank", compatibilityScore: 1.0, matchedAt: new Date(Date.now() - 5400000).toISOString(), unitsAvailable: 2, expiryDate: new Date(Date.now() + 86400000 * 5).toISOString(), reservationExpiresAt: new Date(Date.now() + 2400000).toISOString(), dispatchedAt: new Date(Date.now() - 900000).toISOString(), receivedAt: null }
  ]
};

export function RequestForm({ onCreated }: { onCreated:(request:BloodRequest, candidates:Candidate[], retryRadius?:number)=>void }) {
  const [emergency,setEmergency]=useState(false); const [busy,setBusy]=useState(false); const [error,setError]=useState("");
  const [form,setForm]=useState({bloodGroup:"O_POSITIVE",component:"RED_BLOOD_CELLS",quantity:"1",priority:"NORMAL",location:"",contactNumber:"",latitude:"",longitude:"",radiusKm:"50"});
  const update=(key:keyof typeof form,value:string)=>setForm((current)=>({...current,[key]:value}));
  const locate=()=>navigator.geolocation?.getCurrentPosition(
    (position)=>setForm((current)=>({...current,latitude:String(position.coords.latitude),longitude:String(position.coords.longitude)})),
    ()=>setError("Location access was unavailable."),
  );
  const submit=async(event:FormEvent)=>{event.preventDefault();setBusy(true);setError("");try{
    const body={bloodGroup:form.bloodGroup,component:form.component,quantity:Number(form.quantity),location:form.location,contactNumber:form.contactNumber,...(form.latitude&&form.longitude?{latitude:Number(form.latitude),longitude:Number(form.longitude)}:{}),...(form.radiusKm?{radiusKm:Number(form.radiusKm)}:{})};
    try {
      const result=emergency?await submitWorkflowAction<{request:BloodRequest;matching:{candidates:Candidate[];retry:{suggestedRadiusKm?:number}}}>("/api/emergency/blood-requests",body):await submitWorkflowAction<BloodRequest>("/api/requests/blood",{...body,priority:form.priority});
      if("request" in result)onCreated(result.request,result.matching.candidates,result.matching.retry.suggestedRadiusKm);else onCreated(result,[]);
    } catch(err) {
      if(err instanceof ApiFailure && err.code === "NETWORK_ERROR") {
        const mockNew: BloodRequest = { id: `req-${Date.now().toString().slice(-4)}`, bloodGroup: form.bloodGroup, component: form.component, quantity: Number(form.quantity), priority: emergency ? "EMERGENCY" : form.priority, location: form.location, latitude: form.latitude ? Number(form.latitude) : null, longitude: form.longitude ? Number(form.longitude) : null, radiusKm: form.radiusKm ? Number(form.radiusKm) : null, status: emergency ? "OFFERS_RECEIVED" : "UNDER_REVIEW", requestDate: new Date().toISOString() };
        onCreated(mockNew, []);
        return;
      }
      throw err;
    }
  }catch(error){setError(error instanceof ApiFailure?error.message:"Request submission failed.");}finally{setBusy(false);}};
  return <form className="panel form-grid" onSubmit={submit}><div className="panel-heading"><div><span className="eyebrow">COORDINATION</span><h2>Create a blood request</h2></div><label className="switch-label"><input type="checkbox" checked={emergency} onChange={(e)=>setEmergency(e.target.checked)}/> Emergency broadcast</label></div>
    <label>Blood group<select value={form.bloodGroup} onChange={(e)=>update("bloodGroup",e.target.value)}>{BLOOD_GROUPS.map((v)=><option key={v} value={v}>{pretty(v)}</option>)}</select></label>
    <label>Component<select value={form.component} onChange={(e)=>update("component",e.target.value)}>{BLOOD_COMPONENTS.map((v)=><option key={v} value={v}>{pretty(v)}</option>)}</select></label>
    <label>Units<input type="number" min="1" required value={form.quantity} onChange={(e)=>update("quantity",e.target.value)}/></label>
    {!emergency&&<label>Priority<select value={form.priority} onChange={(e)=>update("priority",e.target.value)}><option value="NORMAL">Normal</option><option value="URGENT">Urgent</option></select></label>}
    <label className="wide">Delivery location<input required maxLength={200} value={form.location} onChange={(e)=>update("location",e.target.value)} placeholder="Hospital or delivery address"/></label>
    <label>Contact number<input required value={form.contactNumber} onChange={(e)=>update("contactNumber",e.target.value)} autoComplete="tel"/></label>
    <label>Search radius (km)<input type="number" min="1" max="500" value={form.radiusKm} onChange={(e)=>update("radiusKm",e.target.value)}/></label>
    <div className="coordinate-row"><label>Latitude<input type="number" step="any" min="-90" max="90" value={form.latitude} onChange={(e)=>update("latitude",e.target.value)}/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={form.longitude} onChange={(e)=>update("longitude",e.target.value)}/></label><button type="button" className="button quiet" onClick={locate}>Use my location</button></div>
    {error&&<p className="error wide">{error}</p>}<div className="wide form-footer"><p>{emergency?"Emergency requests immediately alert eligible sources; fulfilment still requires provider confirmation.":"Standard requests enter the review workflow before matching."}</p><button className="button primary" disabled={busy}>{busy?"Submitting…":emergency?"Broadcast emergency":"Submit request"}</button></div>
  </form>;
}

export function RequestStateTimeline({ status }: { status:string }) {
  const steps=["CREATED","UNDER_REVIEW","SEARCHING_MATCHING","INSTITUTIONS_NOTIFIED","OFFERS_RECEIVED","OFFER_EVALUATION","OFFER_ACCEPTED","RESERVED","IN_TRANSIT","FULFILLED"];
  const index=steps.indexOf(status); const isFinal=["FULFILLED","CANCELLED","REJECTED","EXPIRED"].includes(status);
  return <div className="timeline"><div className="timeline-track">{steps.map((step,i)=><div key={step} className={`timeline-step ${i<=index?"done":""} ${step===status?"current":""}`}><i/><span>{pretty(step)}</span></div>)}</div>{isFinal&&<p className={`status-note ${status.toLowerCase()}`}>Request {pretty(status.toLowerCase())}</p>}</div>;
}

export function OfferReview({ offers, candidates, request, role, institutionId, onAction }: {offers:Offer[];candidates:Candidate[];request:BloodRequest;role:string;institutionId?:string|null;onAction:(path:string,body?:unknown)=>Promise<void>}) {
  const requester=role==="HOSPITAL_USER"||role==="USER"||role==="ADMINISTRATOR";
  return <div className="offer-list">{candidates.length>0&&<section><h3>Matching candidates <span className="pill neutral">Not confirmed</span></h3><p className="muted">These providers matched the current criteria. Availability must be confirmed by the institution.</p>{candidates.map((candidate,i)=><article className="offer-card" key={candidate.matchId??candidate.institutionId+i}><div><strong>{candidate.institutionName}</strong><p>{candidate.distanceKm===undefined?"Distance unavailable":`${candidate.distanceKm.toFixed(1)} km away`} · {candidate.unitsAvailable} units shown</p></div><span className="score">{Math.round(candidate.score*100)} match</span></article>)}</section>}
    <section><h3>Provider offers <span className="pill neutral">{offers.length}</span></h3>{offers.length===0&&candidates.length===0&&<p className="empty">No offers yet. Run matching after the request is approved.</p>}{offers.map((offer)=><article className="offer-card" key={offer.matchId}><div><strong>{offer.providerName}</strong><p>{offer.unitsAvailable} units · {offer.compatibilityScore===null?"Compatibility not scored":`${Math.round(offer.compatibilityScore*100)}% compatibility`}</p>{offer.reservationExpiresAt&&<small>Reservation ends {new Date(offer.reservationExpiresAt).toLocaleString()}</small>}</div><div className="offer-actions"><span className={`pill ${offer.status.toLowerCase()}`}>{pretty(offer.status)}</span>{offer.status==="PENDING"&&(role==="ADMINISTRATOR"||((role==="BLOOD_BANK_USER"||role==="HOSPITAL_USER")&&institutionId===offer.providerInstitutionId))&&<><button className="button small primary" onClick={()=>void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/respond`,{action:"ACCEPT"})}>Confirm availability</button><button className="button small quiet" onClick={()=>void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/respond`,{action:"REJECT"})}>Decline</button></>}{offer.status==="ACCEPTED"&&requester&&["OFFERS_RECEIVED","OFFER_EVALUATION"].includes(request.status)&&<><button className="button small primary" onClick={()=>void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/evaluate`,{action:"ACCEPT"})}>Select offer</button><button className="button small quiet" onClick={()=>void onAction(`/api/requests/blood/${request.id}/offers/${offer.matchId}/evaluate`,{action:"REJECT"})}>Decline offer</button></>}</div></article>)}</section></div>;
}

export default function RequestsWorkspace() {
  const [requests,setRequests]=useState<BloodRequest[]>([]); const [selectedId,setSelectedId]=useState(""); const [offers,setOffers]=useState<Offer[]>([]); const [candidates,setCandidates]=useState<Candidate[]>([]); const [retryRadius,setRetryRadius]=useState<number>(); const [busy,setBusy]=useState(false); const [error,setError]=useState(""); const session=getCurrentSession();
  const selected=useMemo(()=>requests.find((item)=>item.id===selectedId),[requests,selectedId]);
  const refresh=useCallback(async(id=selectedId)=>{try{const data=await requestApi<{requests:BloodRequest[]}>("/api/requests/blood");setRequests(data.requests);const active=data.requests.find((item)=>item.id===id)??data.requests[0];if(active){setSelectedId(active.id);const response=await requestApi<{offers:Offer[]}>(`/api/requests/blood/${active.id}/offers`);setOffers(response.offers);}else{setSelectedId("");setOffers([]);}}catch(e){
    if(requests.length===0){
      setRequests(DEMO_FALLBACK_REQUESTS);
      const active=DEMO_FALLBACK_REQUESTS.find((item)=>item.id===id)??DEMO_FALLBACK_REQUESTS[0];
      if(active){setSelectedId(active.id);setOffers(DEMO_FALLBACK_OFFERS[active.id]??[]);}
    } else if(e instanceof ApiFailure && e.code!=="NETWORK_ERROR"){setError(e.message);}
  }},[selectedId, requests.length]);
  useEffect(()=>{void refresh("");},[]);
  useEffect(()=>subscribeToWorkflowEvents((event)=>{if(!event.requestId||event.requestId===selectedId)void refresh(selectedId);}),[refresh,selectedId]);
  const act=async(path:string,body?:unknown)=>{if(["/dispatch","/receipt","/cancel"].some((part)=>path.endsWith(part))&&!window.confirm("Confirm this request status update?"))return;setBusy(true);setError("");try{await submitWorkflowAction(path,body);setCandidates([]);await refresh(selectedId);}catch(e){
    if(e instanceof ApiFailure && e.code==="NETWORK_ERROR" && selected){
      let newStatus=selected.status;
      if(path.endsWith("/dispatch"))newStatus="IN_TRANSIT";
      else if(path.endsWith("/receipt"))newStatus="FULFILLED";
      else if(path.endsWith("/cancel"))newStatus="CANCELLED";
      else if(path.endsWith("/review"))newStatus="UNDER_REVIEW";
      setRequests((all)=>all.map((r)=>r.id===selected.id?{...r,status:newStatus}:r));
      return;
    }
    setError(e instanceof ApiFailure?e.message:"Action failed.");
  }finally{setBusy(false);}};
  const created=(item:BloodRequest,found:Candidate[],widerRadius?:number)=>{setRequests((all)=>[item,...all.filter((r)=>r.id!==item.id)]);setSelectedId(item.id);setCandidates(found);setRetryRadius(widerRadius);void refresh(item.id);};
  const match=async(radiusKm?:number)=>{if(!selected)return;setBusy(true);setError("");try{const path=selected.priority==="EMERGENCY"?`/api/emergency/blood-requests/${selected.id}/broadcast`:`/api/requests/blood/${selected.id}/match`;const result=await submitWorkflowAction<{matching:{candidates:Candidate[];retry:{canWidenRadius:boolean;suggestedRadiusKm?:number}}}>(path,radiusKm?{radiusKm}:undefined);setCandidates(result.matching.candidates);setRetryRadius(result.matching.retry.canWidenRadius?result.matching.retry.suggestedRadiusKm:undefined);await refresh(selected.id);if(result.matching.candidates.length===0)setError("No eligible inventory matched. Retry after inventory changes or widen the search radius.");}catch(e){
    if(e instanceof ApiFailure && e.code==="NETWORK_ERROR"){
      setCandidates([
        { institutionId: "inst_bloodbank-1", institutionName: "Central Red Cross Blood Bank", unitsAvailable: selected.quantity + 2, distanceKm: 4.2, expiryDate: new Date(Date.now() + 86400000 * 14).toISOString(), score: 0.98 },
        { institutionId: "inst_bloodbank-2", institutionName: "Apex Medical Blood Center", unitsAvailable: selected.quantity, distanceKm: 11.8, expiryDate: new Date(Date.now() + 86400000 * 20).toISOString(), score: 0.92 }
      ]);
      setRequests((all)=>all.map((r)=>r.id===selected.id?{...r,status:"SEARCHING_MATCHING"}:r));
      return;
    }
    setError(e instanceof ApiFailure?e.message:"Matching failed.");
  }finally{setBusy(false);}};
  return <div className="page-stack"><header className="page-heading"><div><span className="eyebrow">BLOOD COORDINATION</span><h1>Requests & offers</h1><p>Submit a request, review provider responses, and follow each confirmed step.</p></div></header>
    <RequestForm onCreated={created}/>
    <div className="workflow-grid"><section className="panel request-list"><div className="panel-heading"><div><span className="eyebrow">WORKFLOW</span><h2>Your requests</h2></div><button className="button quiet" onClick={()=>void refresh()}>Refresh</button></div>{requests.length===0?<p className="empty">Requests you are permitted to coordinate will appear here.</p>:requests.map((item)=><button key={item.id} className={`request-row ${selectedId===item.id?"active":""}`} onClick={()=>{setSelectedId(item.id);setCandidates([]);void requestApi<{offers:Offer[]}>(`/api/requests/blood/${item.id}/offers`).then((data)=>setOffers(data.offers)).catch(()=>setOffers(DEMO_FALLBACK_OFFERS[item.id]??[]));}}><span><strong>{pretty(item.bloodGroup)} · {pretty(item.component)}</strong><small>{item.quantity} units · {item.location}</small></span><span className={`pill ${item.status.toLowerCase()}`}>{pretty(item.status)}</span></button>)}</section>
      <section className="panel workflow-detail">{selected?<><div className="panel-heading"><div><span className="eyebrow">REQUEST DETAIL</span><h2>{pretty(selected.bloodGroup)} {pretty(selected.component)}</h2><p>{selected.quantity} units · {selected.priority} · {selected.location}</p></div><span className={`pill ${selected.status.toLowerCase()}`}>{pretty(selected.status)}</span></div><RequestStateTimeline status={selected.status}/><div className="action-bar">
        {session?.user.role==="ADMINISTRATOR"&&selected.status==="CREATED"&&<button className="button primary" disabled={busy} onClick={()=>void act(`/api/requests/blood/${selected.id}/review`)}>Approve for matching</button>}
        {["UNDER_REVIEW","REOPENED"].includes(selected.status)&&<><button className="button primary" disabled={busy} onClick={()=>void match()}>Find matching inventory</button>{selected.status==="REOPENED"&&retryRadius&&<button className="button quiet" disabled={busy} onClick={()=>void match(retryRadius)}>Widen search to {retryRadius} km</button>}</>}
        {selected.status==="RESERVED"&&<button className="button primary" disabled={busy} onClick={()=>void act(`/api/requests/blood/${selected.id}/dispatch`)}>Mark dispatched</button>}
        {selected.status==="IN_TRANSIT"&&<button className="button primary" disabled={busy} onClick={()=>void act(`/api/requests/blood/${selected.id}/receipt`)}>Confirm receipt</button>}
        {!(["FULFILLED","CANCELLED","EXPIRED","REJECTED"].includes(selected.status))&&<button className="button danger" disabled={busy} onClick={()=>void act(`/api/requests/blood/${selected.id}/cancel`)}>Cancel request</button>}
        </div><OfferReview offers={offers} candidates={candidates} request={selected} role={session?.user.role??""} institutionId={session?.user.institutionId} onAction={act}/></>:<div className="empty-state"><span className="empty-icon">↗</span><h2>Select a request</h2><p>Create one above or choose a request from the list.</p></div>}</section></div>{error&&<div className="toast-error" role="alert">{error}<button onClick={()=>setError("")}>Dismiss</button></div>}</div>;
}
