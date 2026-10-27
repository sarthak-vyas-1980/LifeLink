"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, ArrowUpRight, Bot, Check, ChevronDown, Droplet, HeartPulse, Hospital, Info, LoaderCircle, MapPin, MessageSquareText, PencilLine, Pill, Plus, RotateCcw, Search, ShieldCheck, Sparkles, Trash2, X, CheckCheck, BookOpen } from "lucide-react";
import { ApiFailure, requestApi } from "../../lib/api-client";
import { useAssistantConversation } from "./conversation-provider";
import type { AssistantResult, ChatMessage, DiscoveredFacility, FacilitySearchResult } from "./conversation-types";
import { isConversationNearBottom, shouldSendOnAssistantEnter } from "./conversation-behavior";
import { inferAutoFacilityCategory } from "./facility-auto-discovery";
import { FacilityResults } from "./facility-results";
import { readLocationPermission, requestFreshCoordinates, type LocationPermissionState } from "./location-manager";
import { looksLikeEmergencyOffline } from "./offline-emergency";
import { locationPromptTitle, resolveDisplay } from "./response-display";
import { EmergencyPanel, InventoryBlock, LocationPrompt, RichText, SourcesBlock, UnavailableBlock } from "./result-blocks";
import "./assistant.css";

type FacilityCategory = "blood" | "hospital" | "clinic" | "care" | "pharmacy" | "other" | "emergency" | "organ" | "all";

const starters = [
  { label: "Find hospitals near me", hint: "Map, phone numbers, directions", question: "Find hospitals near me", icon: Hospital },
  { label: "Find a pharmacy", hint: "Medical stores nearby", question: "Find a pharmacy near me", icon: Pill },
  { label: "Check blood availability", hint: "Live LifeLink inventory", question: "Show me the available blood inventory", icon: Droplet },
  { label: "Learn about organ donation", hint: "From LifeLink's documents", question: "How does organ donation work on LifeLink?", icon: HeartPulse },
  { label: "Explain the donation process", hint: "Step by step", question: "Explain the blood donation process step by step", icon: BookOpen },
];

export function AssistantPanel() {
  const { messages, conversations, draft, setDraft, restored, listLoading, pendingMessageId, persistenceWarning, conversationId, searchConversations, createConversation, selectConversation, renameConversation, deleteConversation, sendMessage, appendAssistantResult, removeMessage } = useAssistantConversation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const [editingConversationId, setEditingConversationId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLocation, setSearchLocation] = useState("");
  const [facilityCategory, setFacilityCategory] = useState<FacilityCategory>("all");
  const [facilityRadius, setFacilityRadius] = useState("25");
  const [bloodGroup, setBloodGroup] = useState("");
  const [bloodComponent, setBloodComponent] = useState("");
  const [facilityBusy, setFacilityBusy] = useState(false);
  const [facilityError, setFacilityError] = useState("");
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [locationPermission, setLocationPermission] = useState<LocationPermissionState | "unknown">("unknown");
  const seenAutoMessages = useRef(new Set<string>());
  const seenConversation = useRef<string | null>(null);
  const facilityBusyRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const locationInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottom = useRef(true);

  // Read the existing geolocation permission once and follow later changes; never prompt on load.
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
    field.style.height = `${Math.min(field.scrollHeight, 160)}px`;
    field.style.overflowY = field.scrollHeight > 160 ? "auto" : "hidden";
  }, [draft]);

  function handleFeedScroll() {
    const feed = feedRef.current;
    if (feed) nearBottom.current = isConversationNearBottom(feed.scrollHeight, feed.scrollTop, feed.clientHeight);
  }

  async function searchFacilities(location = searchLocation, coordinates?: { latitude: number; longitude: number }, categoryOverride: FacilityCategory = facilityCategory) {
    if (!location.trim() && !coordinates) { setFacilityError("Type a city, locality, address or landmark, or use your location."); setSearchOpen(true); return; }
    if (coordinates && (!Number.isFinite(coordinates.latitude) || !Number.isFinite(coordinates.longitude) || Math.abs(coordinates.latitude) > 90 || Math.abs(coordinates.longitude) > 180)) { setFacilityError("The current location is invalid. Type an area instead."); return; }
    if (facilityBusyRef.current) return;
    facilityBusyRef.current = true; setFacilityBusy(true); setFacilityError("");
    try {
      const params = new URLSearchParams({ category: categoryOverride, radiusKm: facilityRadius });
      if (bloodGroup) params.set("bloodGroup", bloodGroup);
      if (bloodComponent) params.set("component", bloodComponent);
      if (coordinates) { params.set("latitude", String(coordinates.latitude)); params.set("longitude", String(coordinates.longitude)); }
      else params.set("location", location.trim());
      const result = await requestApi<FacilitySearchResult>(`/api/rag/facilities?${params}`);
      const area = result.center?.displayName?.split(",").slice(0, 2).join(",") ?? (coordinates ? "your location" : location.trim());
      const answer = result.unavailableReason === "LOCATION_UNAVAILABLE" ? "I couldn't pin down that location. Try your current location again, or type a nearby city or locality."
        : (result.unavailableReason === "RATE_LIMITED" || result.unavailableReason === "LOOKUP_FAILED") && !result.facilities.length ? "The public map service didn't respond, so I couldn't search just now. That doesn't mean nothing is nearby; try again in a moment."
          : result.facilities.length ? `Here's what I found near ${area}. Tap a place to see it on the map, call, or get directions.`
            : `I didn't find any matching places near ${area}. Try a wider radius or another locality.`;
      const assistantResult: AssistantResult = {
        answer, intent: "FACILITY_DISCOVERY", knowledgeUsed: false, liveDataUsed: result.facilities.some((facility) => facility.source === "LIFELINK"),
        sources: [], limitations: ["OpenStreetMap entries are public listings, not verified LifeLink facilities. Distances are straight-line. Confirm details directly before travelling."],
        status: result.facilities.length ? "ANSWERED" : result.unavailableReason && result.unavailableReason !== "NOT_CONFIGURED" ? "UNAVAILABLE" : "NO_RESULTS",
        display: "facilities",
        suggestions: result.facilities.length > 1 ? ["Which one is closest?", "Show me more options"] : [],
        data: { facilities: result.facilities, center: result.center, facilityProvider: result.provider, searchLocationType: coordinates ? "DEVICE" : "MANUAL", facilityCategory: categoryOverride, ...(result.unavailableReason ? { providerUnavailableReason: result.unavailableReason } : {}), attribution: result.attribution },
      };
      // Saved copies keep only a rounded search centre, never exact device coordinates.
      const persistedResult: AssistantResult = { ...assistantResult, data: { ...assistantResult.data, center: result.center ? { ...result.center, latitude: Math.round(result.center.latitude * 1000) / 1000, longitude: Math.round(result.center.longitude * 1000) / 1000 } : null } };
      await appendAssistantResult(answer, assistantResult, persistedResult);
      setFacilityError("");
      setSearchOpen(false);
    } catch (cause) {
      setFacilityError(cause instanceof ApiFailure ? cause.message : "Facility search is unavailable. Please try again.");
    } finally { facilityBusyRef.current = false; setFacilityBusy(false); }
  }

  async function locateAndSearch(categoryOverride: FacilityCategory = facilityCategory) {
    if (locationPermissionDenied) { setFacilityError("Location access is off for this site. You can still search by city, locality or landmark."); openAreaSearch(categoryOverride); return; }
    if (!window.isSecureContext && location.hostname !== "localhost") { setFacilityError("Location needs a secure connection. Type an area instead."); openAreaSearch(categoryOverride); return; }
    if (!navigator.geolocation) { setFacilityError("This browser can't share location. Type an area instead."); openAreaSearch(categoryOverride); return; }
    setFacilityError("");
    try {
      const coordinates = await requestFreshCoordinates(navigator.geolocation);
      setLocationPermission("granted"); setLocationPermissionDenied(false); setSearchLocation("");
      await searchFacilities("", coordinates, categoryOverride);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "LOCATION_UNAVAILABLE";
      if (code === "LOCATION_DENIED") { setLocationPermission("denied"); setLocationPermissionDenied(true); }
      setFacilityError(code === "LOCATION_DENIED" ? "Location permission was denied. Search by city, locality or landmark instead." : code === "LOCATION_TIMEOUT" ? "Finding your location took too long. Try again or type an area." : "Your location isn't available. Type an area instead.");
      openAreaSearch(categoryOverride);
    }
  }

  function openAreaSearch(category?: FacilityCategory) {
    if (category) setFacilityCategory(category);
    setHistoryOpen(false);
    setSearchOpen(true);
    window.requestAnimationFrame(() => locationInputRef.current?.focus());
  }

  // When location is already allowed, a new care or facility answer searches once automatically.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, restored, conversationId, locationPermission]);

  function refreshFacilitySearch(result: FacilitySearchResult) {
    const category = (result.category ?? facilityCategory) as FacilityCategory;
    setFacilityCategory(category);
    if (result.searchLocationType === "DEVICE") {
      if (locationPermission === "granted") void locateAndSearch(category);
      else openAreaSearch(category);
      return;
    }
    if (result.center?.displayName) void searchFacilities(result.center.displayName, undefined, category);
    else openAreaSearch(category);
  }

  function submitDraft() { if (draft.trim() && !pendingMessageId && restored) void sendMessage(draft); }
  function handleSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submitDraft(); }
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (shouldSendOnAssistantEnter(event.key, event.shiftKey, event.nativeEvent.isComposing)) { event.preventDefault(); submitDraft(); }
  }

  async function saveConversationName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingConversationId || !editingTitle.trim()) return;
    try { await renameConversation(editingConversationId, editingTitle.trim()); setEditingConversationId(null); }
    catch (cause) { setHistoryError(cause instanceof ApiFailure ? cause.message : "The chat name could not be changed."); }
  }

  const pendingMessage = messages.find((item) => item.id === pendingMessageId);
  const status = pendingMessageId ? "Responding…" : facilityBusy ? "Searching nearby…" : "Ready";

  return (
    <section className="ll-assistant">
      <header className="ll-topbar">
        <div className="ll-identity">
          <span className="ll-identity-icon"><Bot size={20} aria-hidden="true" /></span>
          <div><h2>LifeLink Assistant</h2><p><span className={`ll-status-dot${pendingMessageId || facilityBusy ? " is-busy" : ""}`} aria-hidden="true" /><span role="status">{status}</span></p></div>
        </div>
        <div className="ll-topbar-actions">
          <button type="button" className="ll-button ghost" aria-expanded={searchOpen} onClick={() => { setSearchOpen((value) => !value); setHistoryOpen(false); }}><MapPin size={15} aria-hidden="true" /><span className="ll-hide-narrow">Search an area</span></button>
          <button type="button" className="ll-button ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen((value) => !value)}><MessageSquareText size={15} aria-hidden="true" /><span className="ll-hide-narrow">Chats</span></button>
          <button type="button" className="ll-button primary" onClick={() => { setHistoryOpen(false); void createConversation(); }} disabled={!restored}><Plus size={15} aria-hidden="true" /><span className="ll-hide-narrow">New chat</span></button>
        </div>
      </header>

      <div className={`ll-workspace${historyOpen ? " is-history-open" : ""}`}>
        <aside className="ll-history" aria-label="Conversation history">
          <div className="ll-history-head"><strong>Chats</strong><button type="button" className="ll-icon-button" aria-label="Close chat history" onClick={() => setHistoryOpen(false)}><X size={16} aria-hidden="true" /></button></div>
          <label className="ll-history-search"><Search size={14} aria-hidden="true" /><span className="ll-sr-only">Search chats and messages</span><input value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search chats" /></label>
          {historyError && <p className="ll-inline-error" role="alert">{historyError}</p>}
          <div className="ll-history-list" role="list" aria-label="Saved conversations">
            {listLoading && <p className="ll-muted" role="status">Searching…</p>}
            {!listLoading && !conversations.length && <p className="ll-muted">{historySearch ? "No matching chats." : "Your saved chats will appear here."}</p>}
            {conversations.map((conversation) => <div key={conversation.id} className={`ll-history-item${conversation.id === conversationId ? " is-active" : ""}`} role="listitem">
              {editingConversationId === conversation.id ? <form className="ll-history-rename" onSubmit={(event) => void saveConversationName(event)}><input autoFocus maxLength={120} aria-label="New chat name" value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingConversationId(null); }} /><button type="submit" aria-label="Save chat name" disabled={!editingTitle.trim()}><CheckCheck size={14} aria-hidden="true" /></button></form> : <button type="button" className="ll-history-select" aria-current={conversation.id === conversationId ? "page" : undefined} onClick={() => { setHistoryOpen(false); void selectConversation(conversation.id); }}>
                <strong>{conversation.title}</strong><span>{conversation.preview || "New conversation"}</span>
              </button>}
              <div className="ll-history-actions"><button type="button" aria-label={`Rename ${conversation.title}`} title="Rename" onClick={() => { setEditingConversationId(conversation.id); setEditingTitle(conversation.title); }}><PencilLine size={13} aria-hidden="true" /></button><button type="button" aria-label={`Delete ${conversation.title}`} title="Delete" onClick={() => setDeleteTarget({ id: conversation.id, title: conversation.title })}><Trash2 size={13} aria-hidden="true" /></button></div>
            </div>)}
          </div>
        </aside>

        <div className="ll-chat">
          {searchOpen && <section className="ll-area-search" aria-label="Search facilities by area">
            <form onSubmit={(event) => { event.preventDefault(); void searchFacilities(searchLocation); }} className="ll-area-search-row">
              <label className="ll-sr-only" htmlFor="ll-area-input">City, locality, address or landmark</label>
              <input ref={locationInputRef} id="ll-area-input" value={searchLocation} onChange={(event) => setSearchLocation(event.target.value)} placeholder="City, locality, address or landmark" maxLength={120} />
              <label className="ll-sr-only" htmlFor="ll-area-category">Facility type</label>
              <select id="ll-area-category" value={facilityCategory} onChange={(event) => setFacilityCategory(event.target.value as FacilityCategory)}><option value="all">All healthcare</option><option value="hospital">Hospitals</option><option value="care">Clinics & hospitals</option><option value="clinic">Clinics / doctors</option><option value="pharmacy">Pharmacies</option><option value="blood">Blood banks</option><option value="emergency">Emergency hospitals</option><option value="organ">Organ services</option></select>
              <button type="submit" className="ll-button primary" disabled={facilityBusy}>{facilityBusy ? <LoaderCircle size={14} className="ll-spin" aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}Search</button>
              <button type="button" className="ll-button" onClick={() => void locateAndSearch()} disabled={facilityBusy || locationPermissionDenied} title={locationPermissionDenied ? "Location permission is off; search by area" : undefined}><MapPin size={14} aria-hidden="true" />{locationPermissionDenied ? "Location off" : "Use my location"}</button>
            </form>
            <details className="ll-area-more"><summary>More filters<ChevronDown size={12} aria-hidden="true" /></summary>
              <div className="ll-area-search-row">
                <label><span>Radius</span><select value={facilityRadius} onChange={(event) => setFacilityRadius(event.target.value)}><option value="5">5 km</option><option value="10">10 km</option><option value="25">25 km</option><option value="50">50 km</option></select></label>
                <label><span>Blood group (LifeLink stock)</span><select value={bloodGroup} onChange={(event) => setBloodGroup(event.target.value)}><option value="">Any</option>{["A_POSITIVE", "A_NEGATIVE", "B_POSITIVE", "B_NEGATIVE", "AB_POSITIVE", "AB_NEGATIVE", "O_POSITIVE", "O_NEGATIVE"].map((group) => <option key={group} value={group}>{group.replace("_POSITIVE", "+").replace("_NEGATIVE", "−")}</option>)}</select></label>
                <label><span>Component</span><select value={bloodComponent} onChange={(event) => setBloodComponent(event.target.value)}><option value="">Any</option>{["WHOLE_BLOOD", "RED_BLOOD_CELLS", "PLASMA", "PLATELETS", "CRYOPRECIPITATE"].map((component) => <option key={component} value={component}>{component.replaceAll("_", " ").toLowerCase()}</option>)}</select></label>
              </div>
            </details>
            <p className="ll-fine-print">Your location is used only for this search. Exact coordinates aren't saved in chat history. Typed places are looked up with <a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noreferrer">OpenStreetMap Nominatim</a>.</p>
          </section>}
          {facilityError && <p className="ll-inline-error ll-chat-error" role="alert">{facilityError}<button type="button" aria-label="Dismiss" onClick={() => setFacilityError("")}><X size={13} aria-hidden="true" /></button></p>}
          {persistenceWarning && <p className="ll-inline-warning" role="status">{persistenceWarning}</p>}

          <div className="ll-feed" ref={feedRef} onScroll={handleFeedScroll} aria-live="polite" aria-relevant="additions text">
            {!restored ? <div className="ll-restoring" role="status"><LoaderCircle size={16} className="ll-spin" aria-hidden="true" />Restoring this conversation…</div> : messages.length === 0 ? (
              <div className="ll-welcome">
                <span className="ll-welcome-mark"><Sparkles size={24} aria-hidden="true" /></span>
                <h3>How can I help today?</h3>
                <p>Find nearby care, check LifeLink's live blood inventory, or ask about blood and organ donation. Answers about LifeLink come from its approved documents and live records.</p>
                <div className="ll-starters">
                  {starters.map(({ label, hint, question, icon: Icon }) => (
                    <button key={label} type="button" onClick={() => void sendMessage(question)} disabled={Boolean(pendingMessageId)} className="ll-starter">
                      <span className="ll-starter-icon"><Icon size={17} aria-hidden="true" /></span>
                      <span><strong>{label}</strong><small>{hint}</small></span>
                      <ArrowUpRight size={15} className="ll-starter-arrow" aria-hidden="true" />
                    </button>
                  ))}
                </div>
                <p className="ll-welcome-safety"><ShieldCheck size={13} aria-hidden="true" />In an emergency, call 112. This assistant doesn't diagnose or prescribe.</p>
              </div>
            ) : (
              <div className="ll-messages">
                {messages.map((message: ChatMessage, messageIndex) => {
                  const precedingUserMessage = message.role === "assistant" ? messages.slice(0, messageIndex).reverse().find((item) => item.role === "user") : undefined;
                  const isLatestAnswer = message.role === "assistant" && messageIndex === messages.length - 1;
                  if (message.role === "user") return <UserMessage key={message.id} message={message} pending={message.id === pendingMessageId} disabled={Boolean(pendingMessageId)}
                    locationDenied={locationPermissionDenied} onRetry={() => void sendMessage(message.content, message.id)}
                    onEdit={() => { setDraft(message.content); void removeMessage(message.id); textareaRef.current?.focus(); }}
                    onFindHospitals={() => void locateAndSearch("hospital")} />;
                  return <AssistantMessageView key={message.id} message={message} isLatest={isLatestAnswer} precedingUser={precedingUserMessage}
                    pending={Boolean(pendingMessageId)} facilityBusy={facilityBusy} locationDenied={locationPermissionDenied}
                    onSend={(text) => void sendMessage(text)} onLocate={(category) => void locateAndSearch(category)}
                    onSearchArea={(area, category) => { setFacilityCategory(category); setSearchLocation(area); void searchFacilities(area, undefined, category); }}
                    onRefresh={refreshFacilitySearch} />;
                })}
                {pendingMessageId && <div className="ll-row is-assistant" role="status" aria-label="LifeLink Assistant is responding">
                  <span className="ll-avatar"><Bot size={15} aria-hidden="true" /></span>
                  <div className="ll-answer">
                    {pendingMessage && looksLikeEmergencyOffline(pendingMessage.content) && <p className="ll-pending-emergency" role="alert">If someone may be in danger, call 112 now. Don't wait for this chat.</p>}
                    <div className="ll-typing"><span /><span /><span /><em>Thinking</em></div>
                  </div>
                </div>}
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} className="ll-composer">
            <label htmlFor="lifelink-assistant-message" className="ll-sr-only">Message LifeLink Assistant</label>
            <div className="ll-composer-box">
              <textarea ref={textareaRef} id="lifelink-assistant-message" rows={1} maxLength={2000} value={draft}
                onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown}
                placeholder="Ask about care, blood, or donation…" aria-describedby="lifelink-assistant-hint" disabled={!restored || !conversationId} />
              <button type="submit" disabled={!restored || Boolean(pendingMessageId) || !draft.trim()} aria-label={pendingMessageId ? "Sending message" : "Send message"}>
                {pendingMessageId ? <LoaderCircle size={18} className="ll-spin" aria-hidden="true" /> : <ArrowUp size={18} aria-hidden="true" />}
              </button>
            </div>
            <p id="lifelink-assistant-hint" className="ll-composer-hint"><span>Enter to send · Shift+Enter for a new line</span><span>Don't share passwords or private medical documents.</span></p>
          </form>
        </div>
      </div>
      {deleteTarget && <div className="ll-dialog-backdrop"><section className="ll-dialog" role="alertdialog" aria-modal="true" aria-labelledby="ll-delete-title" aria-describedby="ll-delete-description">
        <h3 id="ll-delete-title">Delete this chat?</h3><p id="ll-delete-description">“{deleteTarget.title}” and its saved messages will be permanently deleted.</p>
        <div><button type="button" className="ll-button" autoFocus onClick={() => setDeleteTarget(null)}>Cancel</button><button type="button" className="ll-button danger" onClick={() => { const id = deleteTarget.id; setDeleteTarget(null); void deleteConversation(id).catch((cause) => setHistoryError(cause instanceof ApiFailure ? cause.message : "The chat could not be deleted.")); }}>Delete chat</button></div>
      </section></div>}
    </section>
  );
}

function UserMessage({ message, pending, disabled, locationDenied, onRetry, onEdit, onFindHospitals }: { message: ChatMessage; pending: boolean; disabled: boolean; locationDenied: boolean; onRetry: () => void; onEdit: () => void; onFindHospitals: () => void }) {
  return <article className="ll-row is-user">
    <div className="ll-user-bubble">
      <p>{message.content}</p>
      {message.deliveryStatus === "sending" && <small className="ll-delivery">{pending ? "Sending…" : "Waiting to send…"}</small>}
    </div>
    {message.failed && <div className="ll-failed">
      {/* Even with no connection, a clear emergency description still shows how to call 112. */}
      {looksLikeEmergencyOffline(message.content) && <EmergencyPanel locationDenied={locationDenied} onFindHospitals={onFindHospitals} />}
      <UnavailableBlock>{message.errorMessage ?? "This message wasn't sent."}</UnavailableBlock>
      <div className="ll-failed-actions"><button type="button" className="ll-button" onClick={onRetry} disabled={disabled}><RotateCcw size={13} aria-hidden="true" />Retry</button><button type="button" className="ll-button ghost" onClick={onEdit} disabled={disabled}><PencilLine size={13} aria-hidden="true" />Edit</button></div>
    </div>}
  </article>;
}

function AssistantMessageView({ message, isLatest, precedingUser, pending, facilityBusy, locationDenied, onSend, onLocate, onSearchArea, onRefresh }: {
  message: ChatMessage; isLatest: boolean; precedingUser?: ChatMessage; pending: boolean; facilityBusy: boolean; locationDenied: boolean;
  onSend: (text: string) => void; onLocate: (category: FacilityCategory) => void; onSearchArea: (area: string, category: FacilityCategory) => void; onRefresh: (result: FacilitySearchResult) => void;
}) {
  const result = message.result;
  const display = resolveDisplay(result);
  const facilityResult = result ? getFacilityResult(result) : null;
  const autoCategory = result && precedingUser ? inferAutoFacilityCategory(precedingUser.content, result) : null;
  const needsLocation = !facilityResult && autoCategory && (result?.intent === "FACILITY_DISCOVERY" || result?.data?.careRecommendation === "PROMPT_ASSESSMENT" || (result?.intent === "FIRST_AID" && autoCategory === "pharmacy"));
  const followUps = isLatest && !pending ? (result?.suggestions ?? []).filter((item) => typeof item === "string" && item.trim()).slice(0, 3) : [];
  const badges = result ? [
    result.liveDataUsed && { key: "live", icon: Check, text: "Live LifeLink records" },
    result.intent === "MEDICAL_OR_CLINICAL" && { key: "medical", icon: Info, text: "General education, not personal advice" },
    result.intent === "FIRST_AID" && { key: "first-aid", icon: Info, text: "General first aid" },
    result.sources?.some((source) => source.sourceKey === "lifelink-sample-data") && { key: "sample", icon: Info, text: "Fictional sample data" },
  ].filter(Boolean) as Array<{ key: string; icon: typeof Check; text: string }> : [];

  return <article className={`ll-row is-assistant display-${display}`}>
    <span className="ll-avatar"><Bot size={15} aria-hidden="true" /></span>
    <div className="ll-answer">
      {display === "emergency" && <EmergencyPanel result={result} locationDenied={locationDenied} onFindHospitals={() => onLocate("hospital")} />}
      <div className={`ll-answer-text${display === "emergency" ? " is-emergency" : ""}`}><RichText content={message.content} /></div>
      {badges.length > 0 && <div className="ll-badges">{badges.map(({ key, icon: Icon, text }) => <span key={key} className="ll-badge"><Icon size={11} aria-hidden="true" />{text}</span>)}</div>}
      {display === "inventory" && result?.data && <InventoryBlock data={result.data} />}
      {facilityResult && <FacilityResults result={facilityResult} messageId={message.id} onRefresh={onRefresh} refreshing={facilityBusy} />}
      {needsLocation && <LocationPrompt title={result?.data?.careRecommendation === "PROMPT_ASSESSMENT" ? "Find a clinic near you" : locationPromptTitle(autoCategory)} locationDenied={locationDenied} busy={facilityBusy}
        onUseLocation={() => onLocate(autoCategory as FacilityCategory)} onSearchArea={(area) => onSearchArea(area, autoCategory as FacilityCategory)} />}
      {display === "unavailable" && isLatest && precedingUser && <UnavailableBlock onRetry={() => onSend(precedingUser.content)} disabled={pending} />}
      {result?.sources?.length ? <SourcesBlock sources={result.sources} /> : null}
      {result?.handoff && <div className="ll-handoff"><p>{result.handoff.reason}</p><Link href={result.handoff.href}>{result.handoff.label}<ArrowUpRight size={13} aria-hidden="true" /></Link></div>}
      {result?.limitations?.length ? <details className="ll-about"><summary>About this answer</summary><ul>{result.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></details> : null}
      {followUps.length > 0 && <div className="ll-followups" aria-label="Suggested follow-ups">{followUps.map((item) => <button key={item} type="button" onClick={() => onSend(item)} disabled={pending}>{item}</button>)}</div>}
    </div>
  </article>;
}

function getFacilityResult(result: AssistantResult): FacilitySearchResult | null {
  const data = result.data;
  if (!data || !Array.isArray(data.facilities)) return null;
  const center = data.center && typeof data.center === "object" ? data.center as FacilitySearchResult["center"] : null;
  const facilities = data.facilities.filter((item): item is DiscoveredFacility => Boolean(item && typeof item === "object" && typeof (item as DiscoveredFacility).name === "string" && typeof (item as DiscoveredFacility).id === "string"));
  return {
    facilities,
    center: center && Number.isFinite(center.latitude) && Number.isFinite(center.longitude) ? center : null,
    provider: typeof data.facilityProvider === "string" ? data.facilityProvider : "UNAVAILABLE",
    ...(data.providerUnavailableReason === "NOT_CONFIGURED" || data.providerUnavailableReason === "LOCATION_UNAVAILABLE" || data.providerUnavailableReason === "RATE_LIMITED" || data.providerUnavailableReason === "LOOKUP_FAILED" ? { unavailableReason: data.providerUnavailableReason } : {}),
    ...(typeof data.attribution === "string" ? { attribution: data.attribution } : {}),
    ...(data.searchLocationType === "DEVICE" || data.searchLocationType === "MANUAL" ? { searchLocationType: data.searchLocationType } : {}),
    ...(typeof data.facilityCategory === "string" ? { category: data.facilityCategory } : {}),
    ...(typeof data.facilityListTitle === "string" ? { title: data.facilityListTitle } : {}),
    ...(data.directory === true || data.inventoryNotRechecked === true ? { hideInventory: true } : {}),
    ...(typeof data.selectedFacilityId === "string" && facilities.some((facility) => facility.id === data.selectedFacilityId) ? { selectedId: data.selectedFacilityId } : {}),
  };
}

export function AssistantMessage() { return <AssistantPanel />; }
