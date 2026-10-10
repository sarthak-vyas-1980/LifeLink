type InstitutionActivity = {
  name: string;
  analytics: {
    donorRequests: number;
    recipientRequests: number;
    activeRequests: number;
    backlog: number;
    matchingVolume: number;
    procurementVolume: number;
  };
};

export function InstitutionAnalyticsChart({ institution }: { institution: InstitutionActivity }) {
  const metrics = [
    { label: "Donor requests", value: institution.analytics.donorRequests, color: "#087e79" },
    { label: "Recipient requests", value: institution.analytics.recipientRequests, color: "#4a78c2" },
    { label: "Active requests", value: institution.analytics.activeRequests, color: "#9a62b5" },
    { label: "Backlog", value: institution.analytics.backlog, color: "#d08a28" },
    { label: "Matching", value: institution.analytics.matchingVolume, color: "#d15b5b" },
    { label: "Procurement", value: institution.analytics.procurementVolume, color: "#4a9d67" },
  ];
  const domainMax = Math.max(1, ...metrics.map((metric) => metric.value));
  const tickStep = Math.max(1, Math.ceil(domainMax / 5));
  const axisMax = Math.ceil(domainMax / tickStep) * tickStep;
  const plotLeft = 154;
  const plotWidth = 520;
  const rowGap = 30;
  const plotTop = 18;
  const axisY = plotTop + (metrics.length - 1) * rowGap + 24;
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, index) => index * tickStep);

  return <section className="admin-institution-analytics-chart" aria-label={`${institution.name} activity snapshot`}>
    <h3>Activity snapshot</h3>
    <svg className="admin-institution-chart-svg" viewBox="0 0 720 230" role="img" aria-label={`Dot plot of institution activity counts. Horizontal axis ranges from zero to ${axisMax}.`}>
      {ticks.map((tick) => {
        const x = plotLeft + tick / axisMax * plotWidth;
        return <g key={tick}><line x1={x} y1={plotTop - 5} x2={x} y2={axisY - 8} className="admin-chart-gridline"/><text x={x} y={axisY + 15} textAnchor="middle" className="admin-chart-tick">{tick}</text></g>;
      })}
      {metrics.map((metric, index) => {
        const y = plotTop + index * rowGap;
        const x = plotLeft + metric.value / axisMax * plotWidth;
        return <g key={metric.label}><text x={0} y={y + 4} className="admin-chart-label" style={{ fill: metric.color }}>{metric.label}</text><line x1={plotLeft} y1={y} x2={plotLeft + plotWidth} y2={y} className="admin-chart-rowline"/><circle cx={x} cy={y} r={5} className="admin-chart-point" style={{ fill: metric.color }}/><text x={Math.min(x + 11, 700)} y={y + 4} className="admin-chart-value">{metric.value}</text></g>;
      })}
      <text x={plotLeft + plotWidth / 2} y={225} textAnchor="middle" className="admin-chart-axis-title">Count</text>
    </svg>
  </section>;
}
