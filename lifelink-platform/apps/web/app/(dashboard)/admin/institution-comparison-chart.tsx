type InstitutionPerformance = {
  id: string;
  name: string;
  analytics: { handledRequests: number; activeRequests: number };
};

const series = [
  { key: "handledRequests", label: "Total requests", color: "#087e79" },
  { key: "activeRequests", label: "Active requests", color: "#4a78c2" },
] as const;

export function InstitutionComparisonChart({
  institutions,
  title,
}: {
  institutions: InstitutionPerformance[];
  title: string;
}) {
  if (!institutions.length) return null;

  const maximum = Math.max(1, ...institutions.flatMap((institution) => [institution.analytics.handledRequests, institution.analytics.activeRequests]));
  const tickStep = Math.max(1, Math.ceil(maximum / 5));
  const axisMax = Math.ceil(maximum / tickStep) * tickStep;
  const plotLeft = 250;
  const plotWidth = 500;
  const rowGap = 34;
  const plotTop = 20;
  const axisY = plotTop + (institutions.length - 1) * rowGap + 28;
  const height = axisY + 34;
  const ticks = Array.from({ length: axisMax / tickStep + 1 }, (_, index) => index * tickStep);

  return <section className="admin-institution-comparison-chart" aria-label={title}>
    <div className="admin-institution-chart-heading"><h3>{title}</h3><div className="admin-institution-chart-legend">{series.map((item) => <span key={item.key}><i style={{ backgroundColor: item.color }}/> {item.label}</span>)}</div></div>
    <div className="admin-institution-comparison-scroll">
      <svg viewBox={`0 0 790 ${height}`} role="img" aria-label={`${title}: total and active requests by institution, on a scale from zero to ${axisMax}.`}>
        {ticks.map((tick) => {
          const x = plotLeft + tick / axisMax * plotWidth;
          return <g key={tick}><line x1={x} y1={plotTop - 8} x2={x} y2={axisY - 10} className="admin-chart-gridline"/><text x={x} y={axisY + 13} textAnchor="middle" className="admin-chart-tick">{tick}</text></g>;
        })}
        {institutions.map((institution, index) => {
          const y = plotTop + index * rowGap;
          const label = institution.name.length > 34 ? `${institution.name.slice(0, 33)}…` : institution.name;
          return <g key={institution.id}>
            <title>{institution.name}</title>
            <text x={0} y={y + 4} className="admin-chart-label">{label}</text>
            <line x1={plotLeft} y1={y} x2={plotLeft + plotWidth} y2={y} className="admin-chart-rowline"/>
            {series.map((item, seriesIndex) => {
              const value = institution.analytics[item.key];
              const x = plotLeft + value / axisMax * plotWidth;
              const pointY = y + (seriesIndex === 0 ? -4 : 4);
              return <g key={item.key}><circle cx={x} cy={pointY} r={5} className="admin-chart-point" style={{ fill: item.color }}><title>{`${institution.name}: ${item.label.toLowerCase()} ${value}`}</title></circle><text x={Math.min(x + 9, 766)} y={pointY + 3} className="admin-comparison-value">{value}</text></g>;
            })}
          </g>;
        })}
        <text x={plotLeft + plotWidth / 2} y={height - 4} textAnchor="middle" className="admin-chart-axis-title">Requests</text>
      </svg>
    </div>
  </section>;
}
