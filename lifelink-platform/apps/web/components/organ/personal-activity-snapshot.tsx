type PersonalMetrics = {
  donorRequests: number;
  recipientRequests: number;
  awaitingReview: number;
  activeRequests: number;
  potentialMatches: number;
  offersReceived: number;
  fulfilledRequests: number;
};

const rows = [
  { key: "donorRequests", label: "My donor requests", color: "#087e79" },
  { key: "recipientRequests", label: "My recipient requests", color: "#4a78c2" },
  { key: "awaitingReview", label: "Awaiting review", color: "#d08a28" },
  { key: "activeRequests", label: "Active requests", color: "#9a62b5" },
  { key: "potentialMatches", label: "Potential matches", color: "#d15b5b" },
  { key: "offersReceived", label: "Offers received", color: "#4a9d67" },
  { key: "fulfilledRequests", label: "Fulfilled requests", color: "#167eaa" },
] as const;

export function PersonalOrganActivitySnapshot({ metrics }: { metrics: PersonalMetrics }) {
  const maxValue = Math.max(1, ...rows.map(({ key }) => metrics[key]));
  const step = Math.max(1, Math.ceil(maxValue / 5));
  const axisMax = Math.ceil(maxValue / step) * step;
  const labelWidth = 190;
  const plotWidth = 720;
  const chartWidth = labelWidth + plotWidth + 30;
  const top = 20;
  const rowGap = 35;
  const axisY = top + (rows.length - 1) * rowGap + 25;
  const ticks = Array.from({ length: axisMax / step + 1 }, (_, index) => index * step);

  return <section className="panel personal-organ-snapshot" aria-label="Personal organ coordination activity snapshot">
    <div className="panel-heading"><div><span className="eyebrow">YOUR ORGAN ACTIVITY</span><h2>Activity snapshot</h2><p>Counts from your own donor and recipient records only.</p></div></div>
    <div className="personal-organ-snapshot-chart">
      <svg viewBox={`0 0 ${chartWidth} ${axisY + 35}`} role="img" aria-label="Your own organ donor and recipient request, review, match, offer, and fulfillment counts">
        {ticks.map((tick) => {
          const x = labelWidth + tick / axisMax * plotWidth;
          return <g key={tick}><line x1={x} y1={top - 6} x2={x} y2={axisY - 10} className="institution-snapshot-gridline"/><text x={x} y={axisY + 12} textAnchor="middle" className="institution-snapshot-tick">{tick}</text></g>;
        })}
        {rows.map(({ key, label, color }, index) => {
          const y = top + index * rowGap;
          const value = metrics[key];
          const x = labelWidth + value / axisMax * plotWidth;
          return <g key={key}><text x={0} y={y + 4} className="personal-organ-snapshot-label" style={{ fill: color }}>{label}</text><line x1={labelWidth} y1={y} x2={labelWidth + plotWidth} y2={y} className="institution-snapshot-rowline"/><circle cx={x} cy={y} r={6} className="institution-snapshot-point" style={{ fill: color }}/><text x={Math.min(x + 12, chartWidth - 20)} y={y + 4} className="institution-snapshot-value">{value}</text></g>;
        })}
        <text x={labelWidth + plotWidth / 2} y={axisY + 31} textAnchor="middle" className="institution-snapshot-axis-title">Count</text>
      </svg>
    </div>
  </section>;
}
