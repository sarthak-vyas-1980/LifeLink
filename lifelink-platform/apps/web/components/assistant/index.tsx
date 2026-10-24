"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { Activity, ArrowUpRight, BookOpen, Bot, Check, CircleHelp, HeartPulse, LoaderCircle, MapPin, RotateCcw, Send, ShieldCheck, Sparkles, Phone, Globe2, Navigation, Search, Maximize2, Minimize2, PencilLine, Plus, MessageSquareText, Trash2, X, CheckCheck, Hospital, Pill, Stethoscope, Droplet, Building2 } from "lucide-react";
import { ApiFailure, requestApi } from "../../lib/api-client";
import { useAssistantConversation } from "./conversation-provider";
import type { AssistantResult, ChatMessage, DiscoveredFacility, FacilitySearchResult } from "./conversation-types";
import { isConversationNearBottom, shouldSendOnAssistantEnter } from "./conversation-behavior";
import { inferAutoFacilityCategory } from "./facility-auto-discovery";
import { readLocationPermission, requestFreshCoordinates, type LocationPermissionState } from "./location-manager";
import "./assistant.css";

const suggestions = [
  { label: "Help me write something", question: "Help me write a clear, friendly follow-up email about a project update.", icon: PencilLine },
  { label: "Explain a technical idea", question: "Explain how a web API works, with a simple example.", icon: CircleHelp },
  { label: "Blood request workflow", question: "How does the blood request workflow work?", icon: Activity },
  { label: "Organ coordination", question: "How does organ coordination work?", icon: HeartPulse },
  { label: "Medical education", question: "Explain asthma using the medical reference book.", icon: BookOpen },
  { label: "Sample dataset", question: "What information is available in the sample dataset?", icon: CircleHelp },
  { label: "Nearby facilities", question: "Find nearby blood donation facilities in Indore.", icon: MapPin },
];
const FacilityMap = dynamic(() => import("../map/leaflet-map"), { ssr: false, loading: () => <div className="assistant-map-loading" role="status">Preparing map…</div> });

export function AssistantPanel() {
  const { messages, conversations, draft, setDraft, restored, listLoading, pendingMessageId, persistenceWarning, conversationId, searchConversations, createConversation, selectConversation, renameConversation, deleteConversation, sendMessage, appendAssistantResult, removeMessage } = useAssistantConversation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [searchLocation, setSearchLocation] = useState("");
  const [facilityCategory, setFacilityCategory] = useState<"blood" | "hospital" | "clinic" | "care" | "pharmacy" | "other" | "emergency" | "organ" | "all">("all");
  const [facilityRadius, setFacilityRadius] = useState("25");
  const [bloodGroup, setBloodGroup] = useState("");
  const [bloodComponent, setBloodComponent] = useState("");
  const [facilityLocationCoordinates, setFacilityLocationCoordinates] = useState<{ latitude: number; longitude: number } | null>(null);
  const [facilityBusy, setFacilityBusy] = useState(false);
  const [facilityError, setFacilityError] = useState("");
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [locationPermission, setLocationPermission] = useState<LocationPermissionState | "unknown">("unknown");
  const seenAutoMessages = useRef(new Set<string>());
  const seenConversation = useRef<string | null>(null);
  const facilityBusyRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const discoveryRef = useRef<HTMLDetailsElement>(null);
  const locationInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);

  useEffect(() => {
    let active = true;
    let status: PermissionStatus | undefined;
    const permissions = navigator.permissions;
    void readLocationPermission(permissions).then((state) => {
      if (!active) return;
      setLocationPermission(state);
      setLocationPermissionDenied(state === "denied");
      if (permissions && state !== "unsupported") {
        void permissions.query({ name: "geolocation" }).then((current) => {
          if (!active) return;
          status = current;
          current.onchange = () => {
            if (!active || !status) return;
            const next = status.state === "granted" || status.state === "denied" ? status.state : "prompt";
            setLocationPermission(next);
            setLocationPermissionDenied(next === "denied");
          };
        }).catch(() => undefined);
      }
    });
    return () => { active = false; if (status) status.onchange = null; };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void searchConversations(historySearch); }, historySearch ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [historySearch, searchConversations]);

  useEffect(() => {
    const feed = feedRef.current;
    if (!feed || !nearBottom.current) return;
    feed.scrollTo({ top: feed.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [messages, pendingMessageId]);

  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, 132)}px`;
    field.style.overflowY = field.scrollHeight > 132 ? "auto" : "hidden";
  }, [draft]);

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (feed) nearBottom.current = isConversationNearBottom(feed.scrollHeight, feed.scrollTop, feed.clientHeight);
  }

  async function searchFacilities(location = searchLocation, coordinates?: { latitude: number; longitude: number }, categoryOverride = facilityCategory) {
    if (!location.trim() && !coordinates) { setFacilityError("Enter a locality, address, or landmark, or choose Locate me."); return; }
    if (coordinates && (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) || Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180)) { setFacilityError("The current location is invalid. Enter a locality instead."); return; }
    if (facilityBusyRef.current) return;
    facilityBusyRef.current = true; setFacilityBusy(true); setFacilityError("");
    try {
      const params = new URLSearchParams({ category: categoryOverride, radiusKm: facilityRadius });
      if (bloodGroup) params.set("bloodGroup", bloodGroup);
      if (bloodComponent) params.set("component", bloodComponent);
      if (coordinates) { params.set("latitude", String(coordinates.latitude)); params.set("longitude", String(coordinates.longitude)); }
      else params.set("location", location.trim());
      const result = await requestApi<FacilitySearchResult>(`/api/rag/facilities?${params}`);
      const area = result.center?.displayName ?? (coordinates ? "your selected location" : location.trim() || "the selected area");
      const answer = result.unavailableReason === "NOT_CONFIGURED" ? "External facility search is not configured. LifeLink facility records, if available, are shown below." : result.unavailableReason === "LOCATION_UNAVAILABLE" ? "I couldn't determine a reliable search location. Try your current location again or enter a city or locality." : result.unavailableReason === "RATE_LIMITED" && !result.facilities.length ? "The external facility provider is temporarily rate-limiting searches. This does not mean there are no facilities nearby; retry shortly or use a local directory." : result.unavailableReason === "LOOKUP_FAILED" && !result.facilities.length ? "The external facility provider is temporarily unavailable. This does not mean there are no facilities nearby; please retry or use a local directory." : result.unavailableReason === "RATE_LIMITED" ? `The external facility provider is rate-limiting searches. Partial results for ${area} are shown below.` : result.unavailableReason === "LOOKUP_FAILED" ? `Some facility sources were unavailable. Partial results for ${area} are shown below.` : result.facilities.length ? `Nearby facilities for ${area}. See the facility list and map below.` : `No facilities were found for ${area}. Try another locality or a wider search area.`;
      const assistantResult: AssistantResult = {
        answer, intent: "FACILITY_DISCOVERY", knowledgeUsed: false, liveDataUsed: result.facilities.some((facility) => facility.source === "LIFELINK"),
        sources: [], limitations: ["OpenStreetMap entries are public listings, not verified LifeLink facilities. Distances are straight-line. Confirm details directly before travelling."],
        data: { facilities: result.facilities, center: result.center, facilityProvider: result.provider, searchLocationType: coordinates ? "DEVICE" : "MANUAL", facilityCategory: categoryOverride, ...(result.unavailableReason ? { providerUnavailableReason: result.unavailableReason } : {}), attribution: result.attribution },
      };
      const persistedResult: AssistantResult = { ...assistantResult, data: { ...assistantResult.data, center: result.center ? { ...result.center, latitude: Math.round(result.center.latitude * 1000) / 1000, longitude: Math.round(result.center.longitude * 1000) / 1000 } : null } };
      await appendAssistantResult(answer, assistantResult, persistedResult);
      setFacilityError("");
    } catch (cause) {
      setFacilityError(cause instanceof ApiFailure ? cause.message : "Facility search is unavailable. Please retry.");
    } finally { facilityBusyRef.current = false; setFacilityBusy(false); }
  }

  async function locateAndSearch(categoryOverride = facilityCategory) {
    if (locationPermissionDenied) { setFacilityError("Location access was denied earlier. You can still search by city, locality, address, or landmark."); return; }
    if (!window.isSecureContext && location.hostname !== "localhost") { setFacilityError("Location access requires a secure connection. Enter a locality instead."); return; }
    if (!navigator.geolocation) { setFacilityError("Location access is unavailable in this browser. Enter a locality instead."); return; }
    setFacilityError("");
    try {
      const coordinates = await requestFreshCoordinates(navigator.geolocation);
      setLocationPermission("granted"); setLocationPermissionDenied(false); setSearchLocation("My current location");
      await searchFacilities("", coordinates, categoryOverride);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "LOCATION_UNAVAILABLE";
      if (code === "LOCATION_DENIED") { setLocationPermission("denied"); setLocationPermissionDenied(true); }
      setFacilityError(code === "LOCATION_DENIED" ? "Location permission was denied. You can still search by city, locality, address, or landmark." : code === "LOCATION_TIMEOUT" ? "Location lookup timed out. Try again or search by locality." : "Your location is unavailable. You can still search by city, locality, address, or landmark.");
      if (discoveryRef.current) discoveryRef.current.open = true;
      window.requestAnimationFrame(() => locationInputRef.current?.focus());
    }
  }

  useEffect(() => {
    if (!restored || !conversationId) return;
    if (seenConversation.current !== conversationId) {
      seenConversation.current = conversationId;
      seenAutoMessages.current = new Set(messages.filter((message) => message.role === "assistant").map((message) => message.id));
      return;
    }
    const additions = messages.filter((message) => message.role === "assistant" && !seenAutoMessages.current.has(message.id));
    if (locationPermission !== "granted" || !additions.length) return;
    for (const message of additions) seenAutoMessages.current.add(message.id);
    for (const message of additions) {
      if (!message.result) continue;
      const index = messages.findIndex((item) => item.id === message.id);
      const userMessage = messages.slice(0, index).reverse().find((item) => item.role === "user");
      if (!userMessage) continue;
      const category = inferAutoFacilityCategory(userMessage.content, message.result);
      if (category) void locateAndSearch(category);
    }
  }, [messages, restored, conversationId, locationPermission]);

  function openEmergencyHospitalSearch() {
    openCareSearch("hospital");
  }

  function refreshFacilitySearch(result: FacilitySearchResult) {
    const category = result.category ?? facilityCategory;
    setFacilityCategory(category as typeof facilityCategory);
    if (result.searchLocationType === "DEVICE") {
      if (locationPermission === "granted") void locateAndSearch(category as typeof facilityCategory);
      else setFacilityError("Choose Use My Current Location to get a fresh position, or search by locality.");
      return;
    }
    void searchFacilities(result.center?.displayName ?? searchLocation, undefined, category as typeof facilityCategory);
  }

  function openCareSearch(category: "clinic" | "hospital" | "care") {
    setFacilityCategory(category);
    setHistoryOpen(false);
    if (discoveryRef.current) discoveryRef.current.open = true;
    window.requestAnimationFrame(() => locationInputRef.current?.focus());
  }

  function openSuggestedFacilitySearch(category: NonNullable<ReturnType<typeof inferAutoFacilityCategory>>) {
    if (category === "clinic" || category === "hospital" || category === "care") { openCareSearch(category); return; }
    setFacilityCategory(category);
    setHistoryOpen(false);
    if (discoveryRef.current) discoveryRef.current.open = true;
    window.requestAnimationFrame(() => locationInputRef.current?.focus());
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (draft.trim() && !pendingMessageId && restored) void sendMessage(draft); }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnAssistantEnter(event.key, event.shiftKey, event.nativeEvent.isComposing)) { event.preventDefault(); if (draft.trim() && !pendingMessageId && restored) void sendMessage(draft); }
  }

  async function saveConversationName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingConversationId || !editingTitle.trim()) return;
    try { await renameConversation(editingConversationId, editingTitle.trim()); setEditingConversationId(null); }
    catch (cause) { setHistoryError(cause instanceof ApiFailure ? cause.message : "The chat name could not be changed."); }
  }

  const pendingMessage = messages.find((item) => item.id === pendingMessageId);

  return (
    <section className="assistant-frame">
      <header className="assistant-topbar">
        <div className="assistant-brand">
          <div className="assistant-brand-icon"><Bot size={23} aria-hidden="true" /></div>
          <div className="assistant-brand-copy">
            <div className="assistant-brand-title"><h2>LifeLink Assistant</h2><span className="assistant-ai-pill">AI</span></div>
            <p>General AI · LifeLink tools</p>
          </div>
        </div>
        <div className="assistant-topbar-actions">
          <button type="button" className="assistant-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}><MessageSquareText size={15} aria-hidden="true" />Chats</button>
          <button type="button" className="assistant-new-chat" onClick={() => { setHistoryOpen(false); void createConversation(); }} disabled={!restored}><Plus size={16} aria-hidden="true" />New chat</button>
        </div>
      </header>

      <div className={`assistant-workspace${historyOpen ? " is-history-open" : ""}`}>
        <aside className="assistant-history" aria-label="Conversation history">
          <div className="assistant-history-header"><strong>Chats</strong><button type="button" className="assistant-history-close" aria-label="Close chat history" onClick={() => setHistoryOpen(false)}><X size={17} aria-hidden="true" /></button><button type="button" className="assistant-new-chat compact" onClick={() => { setHistoryOpen(false); void createConversation(); }} disabled={!restored}><Plus size={15} aria-hidden="true" />New chat</button></div>
          <label className="assistant-history-search"><Search size={15} aria-hidden="true" /><span className="assistant-sr-only">Search chats and messages</span><input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search chats and messages" /></label>
          {historyError && <p className="assistant-history-error" role="alert">{historyError}</p>}
          <div className="assistant-history-list" role="list" aria-label="Saved conversations">
            {listLoading && <p className="assistant-history-state" role="status">Searching history…</p>}
            {!listLoading && !conversations.length && <p className="assistant-history-state">{historySearch ? "No matching conversations." : "Your saved chats will appear here."}</p>}
            {conversations.map((conversation) => <div key={conversation.id} className={`assistant-history-item${conversation.id === conversationId ? " is-active" : ""}`} role="listitem">
              {editingConversationId === conversation.id ? <form className="assistant-history-rename" onSubmit={(event) => void saveConversationName(event)}><input autoFocus maxLength={120} aria-label="New chat name" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingConversationId(null); }} /><button type="submit" aria-label="Save chat name" disabled={!editingTitle.trim()}><CheckCheck size={14} aria-hidden="true" /></button></form> : <button type="button" className="assistant-history-select" aria-current={conversation.id === conversationId ? "page" : undefined} onClick={() => { setHistoryOpen(false); void selectConversation(conversation.id); }}>
                <strong>{conversation.title}</strong><span>{conversation.preview || "New conversation"}</span><small>{conversation.messageCount ? new Date(conversation.updatedAt).toLocaleDateString() : "No messages yet"}</small>
              </button>}
              <div className="assistant-history-actions"><button type="button" aria-label={`Rename ${conversation.title}`} title="Rename chat" onClick={() => { setEditingConversationId(conversation.id); setEditingTitle(conversation.title); }}><PencilLine size={13} aria-hidden="true" /></button><button type="button" aria-label={`Delete ${conversation.title}`} title="Delete chat" onClick={() => setDeleteTarget({ id: conversation.id, title: conversation.title })}><Trash2 size={13} aria-hidden="true" /></button></div>
            </div>)}
          </div>
        </aside>
        <div className="assistant-chat-panel">
      <details ref={discoveryRef} className="assistant-discovery">
        <summary><Search size={14} aria-hidden="true" />Find facilities by area</summary>
        <div className="assistant-discovery-controls">
          <label className="assistant-sr-only" htmlFor="assistant-facility-location">Search locality, address, or landmark</label>
          <input ref={locationInputRef} id="assistant-facility-location" value={searchLocation === "My current location" ? "" : searchLocation} onChange={(event) => { setSearchLocation(event.target.value); setFacilityLocationCoordinates(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void searchFacilities(searchLocation, facilityLocationCoordinates ?? undefined); } }} placeholder="City, locality, address, or landmark" maxLength={120} />
          <label className="assistant-sr-only" htmlFor="assistant-facility-category">Facility type</label>
          <select id="assistant-facility-category" value={facilityCategory} onChange={(event) => setFacilityCategory(event.target.value as typeof facilityCategory)}><option value="all">All healthcare facilities</option><option value="care">Clinics and hospitals</option><option value="hospital">Hospitals</option><option value="clinic">Clinics / doctors</option><option value="pharmacy">Pharmacies / medical stores</option><option value="blood">Blood banks</option><option value="emergency">Emergency-support hospitals</option><option value="organ">Organ services</option><option value="other">Other healthcare</option></select>
          <label className="assistant-sr-only" htmlFor="assistant-facility-radius">Search radius in kilometres</label>
          <select id="assistant-facility-radius" value={facilityRadius} onChange={(event) => setFacilityRadius(event.target.value)}><option value="5">5 km</option><option value="10">10 km</option><option value="25">25 km</option><option value="50">50 km</option></select>
          <label className="assistant-sr-only" htmlFor="assistant-facility-blood-group">Blood group filter for internal inventory</label>
          <select id="assistant-facility-blood-group" value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}><option value="">Any blood group</option>{["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"].map((group) => <option key={group} value={group}>{group.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")}</option>)}</select>
          <label className="assistant-sr-only" htmlFor="assistant-facility-component">Blood component filter for internal inventory</label>
          <select id="assistant-facility-component" value={bloodComponent} onChange={(event) => setBloodComponent(event.target.value)}><option value="">Any component</option>{["WHOLE_BLOOD", "RED_BLOOD_CELLS", "PLASMA", "PLATELETS", "CRYOPRECIPITATE"].map((component) => <option key={component} value={component}>{component.replaceAll("_", " ").toLowerCase()}</option>)}</select>
          <button type="button" onClick={() => void searchFacilities(searchLocation, undefined)} disabled={facilityBusy}><Search size={15} aria-hidden="true" />{facilityBusy ? "Searching…" : "Search"}</button>
          <button type="button" className="assistant-locate" onClick={() => void locateAndSearch()} disabled={facilityBusy || locationPermissionDenied} title={locationPermissionDenied ? "Location permission was denied; use manual search" : undefined}><MapPin size={15} aria-hidden="true" />{locationPermissionDenied ? "Location denied" : "Locate me"}</button>
        </div>
        <p className="assistant-location-note">Location is used only for facility searches. If permission is already granted, a relevant new request may use one fresh position lookup; otherwise choose Locate me. Exact device coordinates are not saved in chat history; saved map centers are rounded. A typed locality is sent to <a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noreferrer">OpenStreetMap Nominatim</a> for geocoding.</p>
        {facilityError && <p className="assistant-discovery-error" role="alert">{facilityError}</p>}
        {facilityBusy && <p className="assistant-provider-note" role="status">Searching the selected area…</p>}
      </details>

      {persistenceWarning && <p className="assistant-persistence-warning" role="status">{persistenceWarning}</p>}
      <div className="assistant-feed" ref={feedRef} onScroll={handleFeedScroll} aria-live="polite" aria-relevant="additions text">
        {!restored ? <p className="assistant-restore-state" role="status">Restoring this conversation…</p> : messages.length === 0 ? (
          <div className="assistant-empty">
            <div className="assistant-empty-icon"><Sparkles size={30} strokeWidth={1.7} aria-hidden="true" /></div>
            <div className="assistant-empty-copy">
              <p className="assistant-eyebrow">Here to help</p>
              <h3>What can I help you with?</h3>
              <p>Ask anything: get help with code, writing, general questions, healthcare, or LifeLink.</p>
            </div>
            <div className="assistant-suggestions">
              {suggestions.map(({ label, question, icon: Icon }) => (
                <button key={label} type="button" onClick={() => void sendMessage(question)} disabled={Boolean(pendingMessageId)} className="assistant-suggestion">
                  <span className="assistant-suggestion-icon"><Icon size={17} aria-hidden="true" /></span>
                  <span>{label}</span><ArrowUpRight size={15} className="assistant-suggestion-arrow" aria-hidden="true" />
                </button>
              ))}
            </div>
            <p className="assistant-trust"><ShieldCheck size={13} aria-hidden="true" />LifeLink facts and live results use the relevant approved sources and services.</p>
          </div>
        ) : (
          <div className="assistant-messages">
            {messages.map((message: ChatMessage) => {
              const synthetic = message.result?.sources?.some((source) => source.sourceKey === "lifelink-sample-data") ?? false;
              const messageIndex = messages.findIndex((item) => item.id === message.id);
              const precedingUserMessage = message.role === "assistant"
                ? messages.slice(0, messageIndex).reverse().find((item) => item.role === "user")
                : undefined;
              const suggestedFacilityCategory = message.result && precedingUserMessage
                ? inferAutoFacilityCategory(precedingUserMessage.content, message.result)
                : null;
              return (
                <article key={message.id} className={`assistant-message-row ${message.role === "user" ? "is-user" : "is-assistant"}`}>
                  {message.role === "assistant" && <div className="assistant-avatar"><Bot size={16} aria-hidden="true" /></div>}
                  <div className={`assistant-bubble ${message.role === "user" ? "user-bubble" : "reply-bubble"}${message.result && getFacilityResult(message.result) ? " facility-response-bubble" : ""}`}>
                    <div className="assistant-answer">{renderAssistantText(message.content)}</div>
                    {isEmergencyResult(message.result) && <EmergencyActionPanel locationPermissionDenied={locationPermissionDenied} onFindHospitals={openEmergencyHospitalSearch} onUseLocation={() => locateAndSearch("hospital")} />}
                    {isAssessmentRecommendation(message.result) && <section className="assistant-care-panel" aria-label="Prompt medical assessment recommendation"><p><ShieldCheck size={15} aria-hidden="true" />Prompt medical assessment recommended</p><button type="button" onClick={() => openCareSearch("clinic")}><Search size={14} aria-hidden="true" />Find a nearby clinic</button><button type="button" onClick={() => locateAndSearch("clinic")}><MapPin size={14} aria-hidden="true" />Use My Current Location</button></section>}
                    {suggestedFacilityCategory && (message.result?.intent === "FACILITY_DISCOVERY" || message.result?.intent === "FIRST_AID" && suggestedFacilityCategory === "pharmacy") && !Array.isArray(message.result.data?.facilities) && <section className="assistant-care-panel" aria-label="Nearby care options"><p><Stethoscope size={15} aria-hidden="true" />{suggestedFacilityCategory === "pharmacy" ? "Nearby pharmacies can help with wound supplies" : "I can look for nearby care options"}</p><button type="button" onClick={() => openSuggestedFacilitySearch(suggestedFacilityCategory)}><Search size={14} aria-hidden="true" />Search by city or locality</button><button type="button" onClick={() => void locateAndSearch(suggestedFacilityCategory)} disabled={facilityBusy || locationPermissionDenied}><MapPin size={14} aria-hidden="true" />{locationPermissionDenied ? "Location denied · search manually" : "Use My Current Location"}</button></section>}
                    {message.role === "user" && message.deliveryStatus === "sending" && <small className="assistant-delivery-state">{message.id === pendingMessageId ? "Sending…" : "Waiting to send…"}</small>}
                    {message.failed && <div className="assistant-message-error" role="alert"><p>{message.errorMessage ?? "This message wasn't sent."}</p><button type="button" onClick={() => void sendMessage(message.content, message.id)} disabled={Boolean(pendingMessageId)} className="assistant-retry"><RotateCcw size={13} aria-hidden="true" />Retry</button><button type="button" onClick={() => { setDraft(message.content); removeMessage(message.id); textareaRef.current?.focus(); }} disabled={Boolean(pendingMessageId)} className="assistant-edit-retry"><PencilLine size={13} aria-hidden="true" />Edit text</button></div>}
                    {message.result && (
                      <div className="assistant-result">
                        <div className="assistant-badges">
                          {message.result.knowledgeUsed && <span className="assistant-badge badge-knowledge"><BookOpen size={11} aria-hidden="true" />Approved documentation</span>}
                          {message.result.liveDataUsed && <span className="assistant-badge badge-live"><Check size={11} aria-hidden="true" />Live LifeLink records checked</span>}
                          {message.result.intent === "MEDICAL_OR_CLINICAL" && <span className="assistant-badge badge-medical"><ShieldCheck size={11} aria-hidden="true" />Medical education · not personal advice</span>}
                          {message.result.intent === "FIRST_AID" && <span className="assistant-badge badge-medical"><ShieldCheck size={11} aria-hidden="true" />First-aid guidance</span>}
                          {synthetic && <span className="assistant-badge badge-synthetic"><CircleHelp size={11} aria-hidden="true" />Fictional test data</span>}
                        </div>
                        {message.result.sources?.length > 0 && (
                          <div className="assistant-sources">
                            <p>Sources</p><ul>{message.result.sources.map((source) => (
                              <li key={source.sourceKey} title={`Retrieval relevance ${source.similarity.toFixed(3)}`}>
                                {source.title}{source.pageNumbers?.length ? <span> · p. {source.pageNumbers.join(", ")}</span> : null}
                              </li>
                            ))}</ul>
                          </div>
                        )}
                        {message.result.handoff && <div className="assistant-handoff">
                          <p>{message.result.handoff.reason}</p>
                          <Link href={message.result.handoff.href}>{message.result.handoff.label}<ArrowUpRight size={14} aria-hidden="true" /></Link>
                        </div>}
                        {message.result.limitations?.length > 0 && <details className="assistant-limitations">
                          <summary>Safety and limitations</summary>
                          <ul>{message.result.limitations.map((limitation, limitationIndex) => <li key={limitationIndex}>{limitation}</li>)}</ul>
                        </details>}
                        {getFacilityResult(message.result) && <FacilityResultCard result={getFacilityResult(message.result)!} messageId={message.id} onRefresh={refreshFacilitySearch} refreshing={facilityBusy} />}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
            {pendingMessageId && <div className="assistant-message-row is-assistant" role="status" aria-label="LifeLink Assistant is responding">
              <div className="assistant-avatar"><Bot size={16} aria-hidden="true" /></div>
              <div>{pendingMessage && /\b(urgent(?:ly)?|immediately|right now|asap)\b/i.test(pendingMessage.content) && /\b(blood|transfusion)\b/i.test(pendingMessage.content) && <p className="assistant-emergency-note" role="alert">If someone may be in immediate danger, contact local emergency services and the treating hospital team now. Don’t wait for this chat.</p>}<div className="assistant-thinking"><LoaderCircle size={14} aria-hidden="true" />Thinking…</div></div>
            </div>}
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="assistant-composer-wrap">
        <div className="assistant-composer">
          <label htmlFor="lifelink-assistant-message" className="assistant-sr-only">Ask LifeLink a question</label>
          <div className="assistant-input-shell">
            <textarea ref={textareaRef} id="lifelink-assistant-message" rows={1} maxLength={2000} value={draft}
              onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown}
              placeholder="Message LifeLink Assistant…" aria-describedby="lifelink-assistant-hint" disabled={!restored || !conversationId} />
            <button type="submit" disabled={!restored || Boolean(pendingMessageId) || !draft.trim()} aria-label={pendingMessageId ? "Sending question" : "Send question"}>
              {pendingMessageId ? <LoaderCircle size={18} aria-hidden="true" /> : <Send size={17} aria-hidden="true" />}
            </button>
          </div>
          <p id="lifelink-assistant-hint" className="assistant-input-hint"><span>Enter to send · Shift+Enter for a new line</span><span>Don’t share passwords or private medical documents.</span></p>
        </div>
      </form>
        </div>
      </div>
      {deleteTarget && <div className="assistant-confirm-backdrop"><section className="assistant-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="assistant-delete-title" aria-describedby="assistant-delete-description">
        <h3 id="assistant-delete-title">Delete this chat?</h3><p id="assistant-delete-description">“{deleteTarget.title}” and its saved messages will be permanently deleted.</p>
        <div><button type="button" onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="danger" onClick={() => { const id = deleteTarget.id; setDeleteTarget(null); void deleteConversation(id).catch((cause) => setHistoryError(cause instanceof ApiFailure ? cause.message : "The chat could not be deleted.")); }}>Delete chat</button></div>
      </section></div>}
    </section>
  );
}

function getFacilityResult(result: AssistantResult): FacilitySearchResult | null {
  const data = result.data;
  if (!data || !Array.isArray(data.facilities)) return null;
  const center = data.center && typeof data.center === "object" ? data.center as FacilitySearchResult["center"] : null;
  const facilities = data.facilities.filter((item): item is DiscoveredFacility => Boolean(item && typeof item === "object" && typeof (item as DiscoveredFacility).name === "string"));
  return {
    facilities,
    center: center && Number.isFinite(center.latitude) && Number.isFinite(center.longitude) ? center : null,
    provider: typeof data.facilityProvider === "string" ? data.facilityProvider : "UNAVAILABLE",
    ...(data.providerUnavailableReason === "NOT_CONFIGURED" || data.providerUnavailableReason === "LOCATION_UNAVAILABLE" || data.providerUnavailableReason === "RATE_LIMITED" || data.providerUnavailableReason === "LOOKUP_FAILED" ? { unavailableReason: data.providerUnavailableReason } : {}),
    ...(typeof data.attribution === "string" ? { attribution: data.attribution } : {}),
    ...(data.searchLocationType === "DEVICE" || data.searchLocationType === "MANUAL" ? { searchLocationType: data.searchLocationType } : {}),
    ...(typeof data.facilityCategory === "string" ? { category: data.facilityCategory } : {}),
  };
}

function isEmergencyResult(result?: AssistantResult): boolean {
  const emergency = result?.data?.emergency;
  return result?.intent === "EMERGENCY" && Boolean(emergency && typeof emergency === "object" && (emergency as { severity?: unknown }).severity === "CRITICAL");
}

function isAssessmentRecommendation(result?: AssistantResult): boolean {
  return result?.intent === "FIRST_AID" && result?.data?.careRecommendation === "PROMPT_ASSESSMENT";
}

function EmergencyActionPanel({ onFindHospitals, onUseLocation, locationPermissionDenied }: { onFindHospitals: () => void; onUseLocation: () => void; locationPermissionDenied: boolean }) {
  return <section className="assistant-emergency-panel" aria-labelledby="assistant-emergency-title">
    <p className="assistant-sr-only" role="alert">Emergency: call 112 immediately if in India.</p>
    <div className="assistant-emergency-heading"><span aria-hidden="true">!</span><div><h3 id="assistant-emergency-title">Emergency help now</h3><p>Call emergency services first. Nearby hospitals are an additional option.</p></div></div>
    <a className="assistant-emergency-call" href="tel:112"><Phone size={17} aria-hidden="true" /><span>Call Emergency Services</span><strong>112</strong></a>
    <p className="assistant-emergency-fallback">If this link does not open a calling app, dial <strong>112</strong> on a phone or ask someone nearby to call. Calling depends on your device and network; this app cannot confirm that a call connected.</p>
    <div className="assistant-emergency-secondary"><button type="button" onClick={onFindHospitals}><Search size={14} aria-hidden="true" />Find Nearby Hospitals</button><button type="button" onClick={onUseLocation} disabled={locationPermissionDenied}><MapPin size={14} aria-hidden="true" />{locationPermissionDenied ? "Location denied · search manually" : "Use My Current Location"}</button></div>
    <p className="assistant-emergency-privacy">A fresh location lookup is used only for nearby facility search. If permission has not been granted, choose Use My Current Location or search by city or locality.</p>
  </section>;
}

function renderAssistantText(content: string): ReactNode[] {
  const blocks = content.split(/```([^\n`]*)\n([\s\S]*?)```/g);
  const rendered: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index += 3) {
    const text = blocks[index] ?? "";
    const language = blocks[index + 1]?.trim();
    const code = blocks[index + 2];
    if (text) {
      const inline = text.split(/(`[^`\n]+`)/g);
      rendered.push(<span key={`text-${index}`}>{inline.map((part, partIndex) => part.startsWith("`") && part.endsWith("`")
        ? <code key={partIndex}>{part.slice(1, -1)}</code>
        : <span key={partIndex}>{part}</span>)}</span>);
    }
    if (code !== undefined) rendered.push(<pre key={`code-${index}`} className="assistant-code"><code data-language={language || undefined}>{code.replace(/\n$/, "")}</code></pre>);
  }
  return rendered;
}

function safeExternalUrl(value: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return !url.username && !url.password && (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : null; }
  catch { return null; }
}

function safeOpenStreetMapUrl(value: string | null) {
  const safe = safeExternalUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  return url.hostname === "www.openstreetmap.org" || url.hostname === "openstreetmap.org" ? url.toString() : null;
}

function safePhoneHref(value: string | null) {
  if (!value || !/^[+\d().\-\s]+$/.test(value.trim())) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? `tel:${value.trim().replace(/[^+\d]/g, "")}` : null;
}

function facilityCategoryName(type: string) {
  return ({ HOSPITAL: "Hospital", EMERGENCY_DEPARTMENT: "Emergency department", CLINIC: "Clinic / doctors", PHARMACY: "Pharmacy / medical store", BLOOD_BANK: "Blood bank", ORGAN_CENTRE: "Organ centre", OTHER_HEALTHCARE_FACILITY: "Other healthcare facility" } as Record<string, string>)[type] ?? "Healthcare facility";
}

function facilityIcon(type: string) {
  if (type === "PHARMACY") return Pill;
  if (type === "CLINIC") return Stethoscope;
  if (type === "BLOOD_BANK") return Droplet;
  if (type === "HOSPITAL" || type === "EMERGENCY_DEPARTMENT") return Hospital;
  return Building2;
}

function FacilityResultCard({ result, messageId, onRefresh, refreshing }: { result: FacilitySearchResult; messageId: string; onRefresh: (result: FacilitySearchResult) => void; refreshing: boolean }) {
  const [largeMap, setLargeMap] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const markers = useMemo(() => result.facilities.map((facility) => ({
    id: facility.id, name: facility.name, type: facility.type, address: facility.address,
    latitude: facility.latitude, longitude: facility.longitude, distanceKm: facility.distanceKm ?? undefined,
    phone: facility.phone, directionsUrl: facility.directionsUrl,
  })), [result.facilities]);
  const selectedFacility = result.facilities.find((facility) => facility.id === selectedId);
  const selectedPhoneHref = selectedFacility ? safePhoneHref(selectedFacility.phone) : null;
  return <section className="assistant-facility-result-card" aria-label="Nearby facility results">
    <header className="assistant-facility-result-heading"><div><strong>Nearby healthcare facilities</strong><span>{result.facilities.length} {result.facilities.length === 1 ? "facility" : "facilities"}</span></div>
      {result.center && result.facilities.length > 0 && <button type="button" aria-expanded={largeMap} onClick={() => setLargeMap((value) => !value)}>{largeMap ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}{largeMap ? "Compact map" : "View larger map"}</button>}
    </header>
    {selectedFacility && selectedPhoneHref && <a className="assistant-selected-facility-call" href={selectedPhoneHref}><Phone size={13} aria-hidden="true" />Call Selected {facilityCategoryName(selectedFacility.type)}</a>}
    <button type="button" className="assistant-facility-refresh" onClick={() => onRefresh(result)} disabled={refreshing}><RotateCcw size={13} aria-hidden="true" />Refresh search</button>
    {result.unavailableReason === "NOT_CONFIGURED" && <p className="assistant-provider-note">External facility search is not configured. LifeLink records, if shown, remain separate.</p>}
    {result.unavailableReason === "LOCATION_UNAVAILABLE" && <p className="assistant-provider-note">A reliable location was unavailable, so nearby facilities could not be ranked. Use a fresh location or search by locality.</p>}
    {result.unavailableReason === "RATE_LIMITED" && <p className="assistant-provider-note">The external facility provider is rate-limiting searches. This does not mean there are no nearby facilities; retry shortly. LifeLink records, if shown, remain separate.</p>}
    {result.unavailableReason === "LOOKUP_FAILED" && <p className="assistant-provider-note">The external facility provider is temporarily unavailable. This does not mean there are no facilities nearby; LifeLink records, if shown, remain separate.</p>}
    {!result.facilities.length && !result.unavailableReason && <p className="assistant-provider-note">No facilities were found for this search area. Try another locality or a wider search radius.</p>}
    {result.facilities.length > 0 && <details className="assistant-facility-list" open>
      <summary>Facility details ({result.facilities.length})</summary>
      <ul>{result.facilities.map((facility) => {
        const website = safeExternalUrl(facility.website);
        const directions = safeOpenStreetMapUrl(facility.directionsUrl);
        const sourceUrl = safeOpenStreetMapUrl(facility.sourceUrl);
        const photoValue = safeExternalUrl(facility.photoUrl);
        const photo = photoValue?.startsWith("https://") ? photoValue : null;
        const callHref = safePhoneHref(facility.phone);
        const CategoryIcon = facilityIcon(facility.type);
        return <li key={facility.id} className={selectedId === facility.id ? "selected" : ""}>
          <button type="button" className="assistant-facility-select" aria-pressed={selectedId === facility.id} onClick={() => setSelectedId(facility.id)}>
            <span className="assistant-facility-title"><CategoryIcon size={16} aria-hidden="true" /><strong>{facility.name}</strong></span>
            <span>{facilityCategoryName(facility.type)} · {facility.distanceKm === null ? "Distance unavailable" : `${facility.distanceKm.toFixed(1)} km straight-line`}</span>
            <small>{facility.address || "Address not listed"}</small>
            <span className="assistant-view-on-map">View on map</span>
          </button>
          <div className="assistant-facility-meta">
            <span className={facility.source === "LIFELINK" ? "source-lifelink" : "source-osm"}>{facility.source === "LIFELINK" ? "Active LifeLink facility" : "OpenStreetMap listing · not LifeLink registered"}</span>
            {facility.emergencyServiceStatus !== "UNKNOWN" && <span>{facility.emergencyServiceStatus === "REGISTERED" ? "Emergency support registered with LifeLink" : "Emergency service listed on OpenStreetMap; confirm by phone"} · current operation is not confirmed</span>}
            {facility.retrievedAt && <span>Listing fetched {new Date(facility.retrievedAt).toLocaleString()}</span>}
            {facility.inventory.status === "CONFIRMED" ? <span className="inventory-confirmed">Recent record: {facility.inventory.units} {facility.inventory.bloodGroup?.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")}{facility.inventory.component ? ` ${facility.inventory.component.replaceAll("_", " ").toLowerCase()}` : ""} · updated {facility.inventory.updatedAt ? new Date(facility.inventory.updatedAt).toLocaleString() : "within 24 hours"}</span> : facility.inventory.status === "STALE" ? <span className="inventory-unknown">Inventory record is stale; availability is unconfirmed.</span> : facility.inventory.status === "UNAVAILABLE" ? <span className="inventory-unknown">Inventory lookup unavailable.</span> : facility.source === "LIFELINK" ? <span className="inventory-unknown">No matching current inventory record.</span> : <span className="inventory-unknown">External listing; LifeLink inventory is not confirmed.</span>}
            {facility.openingHours && <span>Hours listed: {facility.openingHours}</span>}
          </div>
          {photo ? <img className="assistant-facility-photo" src={photo} alt={`Facility photo for ${facility.name}`} loading="lazy" /> : <div className="assistant-facility-placeholder" aria-label={`${facilityCategoryName(facility.type)} icon`}><CategoryIcon size={20} aria-hidden="true" /><span>Photo not provided</span></div>}
          <div className="assistant-facility-actions">{callHref && <a href={callHref}><Phone size={13} aria-hidden="true" />{facility.source === "LIFELINK" ? "Call" : "Call listed number"}</a>}{website && <a href={website} target="_blank" rel="noreferrer"><Globe2 size={13} aria-hidden="true" />Website</a>}{directions && <a href={directions} target="_blank" rel="noreferrer"><Navigation size={13} aria-hidden="true" />Directions</a>}{sourceUrl && facility.source === "OPENSTREETMAP" && <a href={sourceUrl} target="_blank" rel="noreferrer">Source details</a>}</div>
        </li>;
      })}</ul>
    </details>}
    {result.center && <div className={`assistant-map-preview${largeMap ? " is-large" : ""}`} aria-label="Interactive map preview">
      <FacilityMap key={messageId} institutions={markers} center={[result.center.latitude, result.center.longitude]} selectedInstitutionId={selectedId} onSelectInstitution={setSelectedId} centerLabel={result.searchLocationType === "DEVICE" ? "Location used for this search" : "Search area"} />
    </div>}
    <p className="assistant-map-attribution">Map © OpenStreetMap contributors · distances are straight-line. Confirm services and availability directly before travelling. {result.attribution}</p>
  </section>;
}

export function AssistantMessage() { return <AssistantPanel />; }
