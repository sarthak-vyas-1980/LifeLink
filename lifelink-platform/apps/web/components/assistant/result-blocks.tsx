"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangle, BookOpen, Clock, Droplet, LocateFixed, MapPin, Phone, RotateCcw, Search, ShieldAlert } from "lucide-react";
import { safePhoneHref } from "../map/map-presentation";
import type { AssistantResult, AssistantSource, InventoryRecord, InventorySummaryRow } from "./conversation-types";
import { parseInline, parseRichText } from "./rich-text";

export function RichText({ content }: { content: string }) {
  const blocks = parseRichText(content);
  return <div className="ll-rich">{blocks.map((block, index) => {
    if (block.kind === "heading") return block.level === 2 ? <h3 key={index}><Inline text={block.text} /></h3> : <h4 key={index}><Inline text={block.text} /></h4>;
    if (block.kind === "bullets") return <ul key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><Inline text={item} /></li>)}</ul>;
    if (block.kind === "steps") return <ol key={index} className="ll-steps">{block.items.map((item, itemIndex) => <li key={itemIndex}><span className="ll-step-number" aria-hidden="true">{itemIndex + 1}</span><div><Inline text={item} /></div></li>)}</ol>;
    if (block.kind === "code") return <pre key={index} className="ll-code"><code data-language={block.language ?? undefined}>{block.code}</code></pre>;
    return <p key={index}><Inline text={block.text} /></p>;
  })}</div>;
}

function Inline({ text }: { text: string }) {
  return <>{parseInline(text).map((part, index) => part.kind === "bold" ? <strong key={index}>{part.text}</strong> : part.kind === "code" ? <code key={index}>{part.text}</code> : <span key={index}>{part.text}</span>)}</>;
}

export function SourcesBlock({ sources }: { sources: AssistantSource[] }) {
  if (!sources.length) return null;
  return <section className="ll-sources" aria-label="Sources used for this answer">
    <p><BookOpen size={13} aria-hidden="true" />From LifeLink's approved documents</p>
    <ol>{sources.map((source, index) => <li key={source.sourceKey} title={`Retrieval relevance ${source.similarity.toFixed(2)}`}>
      <span className="ll-source-index">{index + 1}</span>{source.title}{source.pageNumbers?.length ? <small> · p. {source.pageNumbers.join(", ")}</small> : null}
    </li>)}</ol>
  </section>;
}

function displayGroup(value: string) {
  return value.replace("_POSITIVE", "+").replace("_NEGATIVE", "−");
}

function relativeTime(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

/** Inventory comes from structured records: per-group totals or per-facility records, never from prose. */
export function InventoryBlock({ data }: { data: Record<string, unknown> }) {
  const summary = Array.isArray(data.summary) ? data.summary as InventorySummaryRow[] : [];
  const records = Array.isArray(data.candidates) ? (data.candidates as InventoryRecord[]).filter((record) => typeof record?.institution === "string" && typeof record.unitsAvailable === "number") : [];
  if (summary.length) {
    return <section className="ll-inventory" aria-label="Blood inventory by group">
      <div className="ll-inventory-grid">{summary.map((row) => <div key={row.bloodGroup} className="ll-group-tile">
        <span className="ll-group-name"><Droplet size={13} aria-hidden="true" />{displayGroup(row.bloodGroup)}</span>
        <strong>{row.units}<small> units</small></strong>
        <span>{row.facilityCount} {row.facilityCount === 1 ? "facility" : "facilities"} · {relativeTime(row.latestUpdate)}</span>
        {row.staleRecords > 0 && <span className="ll-stale">{row.staleRecords} older than 24 h</span>}
      </div>)}</div>
    </section>;
  }
  if (!records.length) return null;
  return <section className="ll-inventory" aria-label="Matching inventory records">
    <ul className="ll-inventory-list">{records.map((record, index) => {
      const call = safePhoneHref(record.contactNumber);
      return <li key={`${record.institutionId ?? record.institution}-${record.group}-${record.component}-${index}`}>
        <div className="ll-inventory-units"><strong>{record.unitsAvailable}</strong><span>{record.group}</span></div>
        <div className="ll-inventory-main">
          <strong>{record.institution}</strong>
          <span>{record.component.toLowerCase()}{record.distanceKm !== null ? ` · ${record.distanceKm} km straight-line` : ""}</span>
          <small>{record.address}</small>
          <small className={record.stale ? "ll-stale" : "ll-fresh"}><Clock size={11} aria-hidden="true" />Updated {relativeTime(record.lastUpdated)}{record.stale ? " · confirm by phone" : ""}</small>
        </div>
        {call && <a className="ll-chip-action" href={call} aria-label={`Call ${record.institution}`}><Phone size={13} aria-hidden="true" />Call</a>}
      </li>;
    })}</ul>
  </section>;
}

export function EmergencyPanel({ result, locationDenied, onFindHospitals }: { result?: AssistantResult; locationDenied: boolean; onFindHospitals: () => void }) {
  const helplines = Array.isArray(result?.data?.helplines) ? (result!.data!.helplines as Array<{ label: string; phoneNumber: string }>).filter((item) => safePhoneHref(item.phoneNumber)) : [];
  return <section className="ll-emergency" aria-labelledby="ll-emergency-title" role="region">
    <p className="ll-sr-only" role="alert">Emergency: call 112 now if you are in India.</p>
    <div className="ll-emergency-head"><ShieldAlert size={20} aria-hidden="true" /><div><h3 id="ll-emergency-title">Call emergency services now</h3><p>Don't wait for this chat. Nearby hospitals are an extra option.</p></div></div>
    <div className="ll-emergency-actions">
      <a className="ll-emergency-call" href="tel:112"><Phone size={18} aria-hidden="true" /><span>Call 112</span></a>
      {helplines.map((line) => <a key={line.phoneNumber} className="ll-emergency-secondary" href={safePhoneHref(line.phoneNumber)!}><Phone size={14} aria-hidden="true" />{line.label} {line.phoneNumber}</a>)}
      <button type="button" className="ll-emergency-secondary" onClick={onFindHospitals}><MapPin size={14} aria-hidden="true" />{locationDenied ? "Find hospitals by area" : "Find nearby hospitals"}</button>
    </div>
    <p className="ll-emergency-fallback">If the button doesn't open your phone app, dial <strong>112</strong> yourself or ask someone nearby to call. This app can't confirm that a call connected.</p>
  </section>;
}

/** Shown when a facility search needs a place: one tap for device location, or type an area. */
export function LocationPrompt({ title, locationDenied, busy, onUseLocation, onSearchArea }: { title: string; locationDenied: boolean; busy: boolean; onUseLocation: () => void; onSearchArea: (area: string) => void }) {
  const [area, setArea] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (area.trim()) onSearchArea(area.trim()); }
  return <section className="ll-location-prompt" aria-label={title}>
    <p className="ll-location-title"><MapPin size={15} aria-hidden="true" />{title}</p>
    <div className="ll-location-row">
      {!locationDenied && <button type="button" className="ll-button primary" onClick={onUseLocation} disabled={busy}><LocateFixed size={14} aria-hidden="true" />Use my location</button>}
      <form onSubmit={submit} className="ll-location-form">
        <label className="ll-sr-only" htmlFor={`ll-area-${title.length}`}>City, locality or landmark</label>
        <input id={`ll-area-${title.length}`} value={area} onChange={(event) => setArea(event.target.value)} placeholder="Or type a city, locality or landmark" maxLength={120} />
        <button type="submit" className="ll-button" disabled={busy || !area.trim()}><Search size={14} aria-hidden="true" />Search</button>
      </form>
    </div>
    <small>{locationDenied ? "Location access is off for this site, so search by area instead." : "Your location is used once for this search and isn't saved in the chat."}</small>
  </section>;
}

export function UnavailableBlock({ onRetry, disabled, children }: { onRetry?: () => void; disabled?: boolean; children?: ReactNode }) {
  return <div className="ll-unavailable" role="status">
    <AlertTriangle size={15} aria-hidden="true" />
    <span>{children ?? "A service this answer needed didn't respond, so nothing was guessed."}</span>
    {onRetry && <button type="button" className="ll-button" onClick={onRetry} disabled={disabled}><RotateCcw size={13} aria-hidden="true" />Try again</button>}
  </div>;
}
