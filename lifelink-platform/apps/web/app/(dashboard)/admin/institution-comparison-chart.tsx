type InstitutionPerformance = {
  id: string;
  name: string;
  analytics: { handledRequests: number; fulfilledRequests: number; completionRate: number; bloodRequests: number; bloodFulfilledRequests: number; bloodCompletionRate: number };
};

export function InstitutionComparisonChart({
  institutions,
  title,
}: {
  institutions: InstitutionPerformance[];
  title: string;
}) {
  if (!institutions.length) return null;

  const plotLeft = 250;
  const plotWidth = 500;
  const rowGap = 38;
  const plotTop = 24;
  const axisY = plotTop + (institutions.length - 1) * rowGap + 30;
  const height = axisY + 36;
  const ticks = [0, 20, 40, 60, 80, 100];

  return <section className="admin-institution-comparison-chart" aria-label={title}>
    <div className="admin-institution-chart-heading"><h3>{title}</h3><div className="admin-institution-chart-legend"><span><i style={{ backgroundColor: "#4a78c2" }}/> Blood</span><span><i style={{ backgroundColor: "#087e79" }}/> Organ</span></div></div>
    <div className="admin-institution-comparison-scroll">
      <svg viewBox={`0 0 790 ${height}`} role="img" aria-label={`${title}: blood and organ fulfillment rates by institution, on a scale from zero to one hundred percent.`}>
        {ticks.map((tick) => {
          const x = plotLeft + tick / 100 * plotWidth;
          return <g key={tick}><line x1={x} y1={plotTop - 10} x2={x} y2={axisY - 10} className="admin-chart-gridline"/><text x={x} y={axisY + 14} textAnchor="middle" className="admin-chart-tick">{tick}%</text></g>;
        })}
        {institutions.map((institution, index) => {
          const y = plotTop + index * rowGap;
          const bloodRate = institution.analytics.bloodCompletionRate;
          const organRate = institution.analytics.completionRate;
          const bloodX = plotLeft + bloodRate / 100 * plotWidth;
          const organX = plotLeft + organRate / 100 * plotWidth;
          const label = institution.name.length > 34 ? `${institution.name.slice(0, 33)}…` : institution.name;
          return <g key={institution.id}>
            <title>{institution.name}</title>
            <text x={0} y={y + 4} className="admin-chart-label">{label}</text>
            <line x1={plotLeft} y1={y} x2={plotLeft + plotWidth} y2={y} className="admin-chart-rowline"/>
            {institution.analytics.bloodRequests > 0 && <><circle cx={bloodX} cy={y - 5} r={5} className="admin-chart-point" style={{ fill: "#4a78c2" }}><title>{`${institution.name}: ${institution.analytics.bloodFulfilledRequests} of ${institution.analytics.bloodRequests} blood requests fulfilled (${bloodRate}%)`}</title></circle><text x={Math.min(bloodX + 9, 766)} y={y - 2} className="admin-comparison-value">{bloodRate}%</text></>}
            {institution.analytics.handledRequests > 0 && <><circle cx={organX} cy={y + 5} r={5} className="admin-chart-point" style={{ fill: "#087e79" }}><title>{`${institution.name}: ${institution.analytics.fulfilledRequests} of ${institution.analytics.handledRequests} organ requests fulfilled (${organRate}%)`}</title></circle><text x={Math.min(organX + 9, 766)} y={y + 8} className="admin-comparison-value">{organRate}%</text></>}
            {institution.analytics.bloodRequests === 0 && institution.analytics.handledRequests === 0 && <text x={plotLeft + 8} y={y + 4} className="admin-comparison-value">No requests</text>}
          </g>;
        })}
        <text x={plotLeft + plotWidth / 2} y={height - 4} textAnchor="middle" className="admin-chart-axis-title">Requests fulfilled</text>
      </svg>
    </div>
  </section>;
}
