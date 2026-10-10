import { InstitutionOrganActivitySnapshot } from "../../../components/institution/organ-activity-snapshot";

type InstitutionActivity = {
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
  return <div className="admin-institution-analytics-chart">
    <InstitutionOrganActivitySnapshot title="Organ activity snapshot" metrics={{
      donorRequests: institution.analytics.donorRequests,
      recipientRequests: institution.analytics.recipientRequests,
      activeRequests: institution.analytics.activeRequests,
      backlog: institution.analytics.backlog,
      matching: institution.analytics.matchingVolume,
      procurement: institution.analytics.procurementVolume,
    }}/>
  </div>;
}
