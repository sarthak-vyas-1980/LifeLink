type Metrics = {
  donorRequests: number;
  recipientRequests: number;
  activeRequests: number;
  backlog: number;
  matching: number;
  procurement: number;
};

const metricColors = ["#087e79", "#4a78c2", "#9a62b5", "#d08a28", "#d15b5b", "#4a9d67"];

export function InstitutionOrganActivitySnapshot({ metrics, title = "Activity snapshot" }: { metrics: Metrics; title?: string }) {
  const rows = [
    { label: "Donor requests", value: metrics.donorRequests },
    { label: "Recipient requests", value: metrics.recipientRequests },
    { label: "Active requests", value: metrics.activeRequests },
    { label: "Backlog", value: metrics.backlog },
    { label: "Matching", value: metrics.matching },
    { label: "Procurement", value: metrics.procurement },
  ];
  const maxValue = Math.max(1, ...rows.map((row) => row.value));
  const step = Math.max(1, Math.ceil(maxValue / 5));
  const axisMax = Math.ceil(maxValue / step) * step;
  const labelWidth = 190;
  const plotWidth = 720;
  const chartWidth = labelWidth + plotWidth + 30;
  const top = 20;
  const rowGap = 38;
  const axisY = top + (rows.length - 1) * rowGap + 25;
  const ticks = Array.from({ length: axisMax / step + 1 }, (_, index) => index * step);

  return <section className="institution-organ-snapshot" aria-label="Organ coordination activity snapshot">
    <h3>{title}</h3>
    <svg viewBox={`0 0 ${chartWidth} ${axisY + 35}`} role="img" aria-label="Organ coordination request and workflow activity counts">
      {ticks.map((tick) => {
        const x = labelWidth + tick / axisMax * plotWidth;
        return <g key={tick}><line x1={x} y1={top - 6} x2={x} y2={axisY - 10} className="institution-snapshot-gridline"/><text x={x} y={axisY + 12} textAnchor="middle" className="institution-snapshot-tick">{tick}</text></g>;
      })}
      {rows.map((row, index) => {
        const y = top + index * rowGap;
        const x = labelWidth + row.value / axisMax * plotWidth;
        const color = metricColors[index];
        return <g key={row.label}><text x={0} y={y + 4} className="institution-snapshot-label" style={{ fill: color }}>{row.label}</text><line x1={labelWidth} y1={y} x2={labelWidth + plotWidth} y2={y} className="institution-snapshot-rowline"/><circle cx={x} cy={y} r={6} className="institution-snapshot-point" style={{ fill: color }}/><text x={Math.min(x + 12, chartWidth - 20)} y={y + 4} className="institution-snapshot-value">{row.value}</text></g>;
      })}
      <text x={labelWidth + plotWidth / 2} y={axisY + 31} textAnchor="middle" className="institution-snapshot-axis-title">Count</text>
    </svg>
  </section>;
}
