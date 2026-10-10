"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import { requestApi } from "../../lib/api-client";

type Range = "7d" | "30d" | "90d" | "365d";
type Status = "ALL" | "OPEN" | "COMPLETED" | "CLOSED";
type Interval = "DAY" | "WEEK" | "MONTH";
type View = "BOTH" | "BLOOD" | "ORGAN";
type Filters = { range: Range; status: Status; interval: Interval; view: View };
type Point = { date: string; blood: number; organ: number; total: number };
type AnalyticsResponse = { range: Range; status: Status; interval: Interval; from: string; to: string; series: Point[] };
type Line = { key: "blood" | "organ" | "total"; label: string; color: string };

const defaultFilters: Filters = { range: "30d", status: "ALL", interval: "DAY", view: "BOTH" };
const rangeLabels: Record<Range, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last 12 months" };
const statusLabels: Record<Status, string> = { ALL: "All statuses", OPEN: "Open / active", COMPLETED: "Completed", CLOSED: "Closed" };
const intervals: Record<Interval, string> = { DAY: "Daily", WEEK: "Weekly", MONTH: "Monthly" };
const bloodLine: Line = { key: "blood", label: "Blood", color: "#4a78c2" };
const organLine: Line = { key: "organ", label: "Organ", color: "#087e79" };

export function InstitutionRequestAnalytics() {
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(defaultFilters);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    const { view: _view, ...apiFilters } = appliedFilters;
    const query = new URLSearchParams(apiFilters);
    void requestApi<AnalyticsResponse>(`/api/institutions/me/request-analytics?${query.toString()}`)
      .then(setData)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [appliedFilters]);
  useEffect(load, [load]);

  const applyFilters = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedFilters(filters);
  };

  return <section className="panel institution-request-analytics">
    <div className="panel-heading"><div><span className="eyebrow">REQUEST ANALYTICS</span><h2>Blood and organ requests</h2><p>Compare requests created or handled by this institution over time.</p></div><button className="button" type="button" onClick={load} disabled={loading}><RefreshCw size={14}/> Refresh</button></div>
    <form className="institution-analytics-filters" onSubmit={applyFilters}>
      <label>Date range<select value={filters.range} onChange={(event) => setFilters((current) => ({ ...current, range: event.target.value as Range }))}>{Object.entries(rangeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Status<select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as Status }))}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Group by<select value={filters.interval} onChange={(event) => setFilters((current) => ({ ...current, interval: event.target.value as Interval }))}>{Object.entries(intervals).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Show<select value={filters.view} onChange={(event) => setFilters((current) => ({ ...current, view: event.target.value as View }))}><option value="BOTH">Both blood and organ</option><option value="BLOOD">Blood only</option><option value="ORGAN">Organ only</option></select></label>
      <button className="button primary" type="submit" disabled={loading}>Apply filters</button>
    </form>
    {error && <p className="error" role="alert">{error}</p>}
    {loading && !data ? <p>Loading request analytics…</p> : data && <div className="institution-request-chart-grid" aria-busy={loading}>
      <RequestTrendChart title={appliedFilters.view === "BOTH" ? "Blood and organ requests" : appliedFilters.view === "BLOOD" ? "Blood requests" : "Organ requests"} data={data.series} interval={data.interval} lines={appliedFilters.view === "BOTH" ? [bloodLine, organLine] : appliedFilters.view === "BLOOD" ? [bloodLine] : [organLine]}/>
    </div>}
    {data && <p className="institution-analytics-caption">Showing {rangeLabels[data.range].toLowerCase()} · {statusLabels[data.status].toLowerCase()} · grouped {intervals[data.interval].toLowerCase()} · {appliedFilters.view === "BOTH" ? "blood and organ" : appliedFilters.view === "BLOOD" ? "blood only" : "organ only"}.</p>}
  </section>;
}

function RequestTrendChart({ title, data, interval, lines, className = "" }: { title: string; data: Point[]; interval: Interval; lines: Line[]; className?: string }) {
  const width = 960;
  const height = 340;
  const left = 44;
  const right = 20;
  const top = 20;
  const bottom = 50;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const maxValue = Math.max(1, ...data.flatMap((point) => lines.map((line) => point[line.key])));
  const tickStep = Math.max(1, Math.ceil(maxValue / 4));
  const axisMax = Math.ceil(maxValue / tickStep) * tickStep;
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, index) => index * tickStep);
  const xAt = (index: number) => left + (data.length <= 1 ? plotWidth / 2 : index / (data.length - 1) * plotWidth);
  const yAt = (value: number) => top + plotHeight - value / axisMax * plotHeight;
  const labelIndices = [...new Set([0, Math.round((data.length - 1) / 3), Math.round((data.length - 1) * 2 / 3), data.length - 1])];

  return <article className={`institution-request-chart ${className}`}>
    <div className="institution-request-chart-heading"><h3>{title}</h3><div>{lines.map((line) => <span key={line.key}><i style={{ backgroundColor: line.color }}/> {line.label}</span>)}</div></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title} line graph`}>
      {ticks.map((tick) => {
        const y = yAt(tick);
        return <g key={tick}><line x1={left} y1={y} x2={width - right} y2={y} className="institution-chart-gridline"/><text x={left - 8} y={y + 3} textAnchor="end" className="institution-chart-tick">{tick}</text></g>;
      })}
      {lines.map((line) => {
        const points = data.map((point, index) => `${xAt(index)},${yAt(point[line.key])}`).join(" ");
        return <g key={line.key}>
          {data.length > 1 && <polyline points={points} fill="none" stroke={line.color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round"/>}
          {data.map((point, index) => <circle key={point.date} cx={xAt(index)} cy={yAt(point[line.key])} r={data.length > 40 ? 2 : 3.5} fill={line.color}><title>{`${formatDate(point.date, interval)}: ${line.label} ${point[line.key]}`}</title></circle>)}
        </g>;
      })}
      {labelIndices.map((index) => data[index] && <text key={data[index].date} x={xAt(index)} y={height - 22} textAnchor="middle" className="institution-chart-tick">{formatDate(data[index].date, interval)}</text>)}
      <text x={width / 2} y={height - 4} textAnchor="middle" className="institution-chart-axis-title">Date</text>
    </svg>
  </article>;
}

function formatDate(value: string, interval: Interval) {
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat(undefined, interval === "MONTH" ? { month: "short", year: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
}
