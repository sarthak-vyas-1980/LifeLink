export const ORGAN_WORKFLOW_STEPS = [
  { key: "REQUEST_CREATED", label: "Request created" },
  { key: "UNDER_REVIEW", label: "Under review" },
  { key: "MATCHING", label: "Matching search" },
  { key: "POTENTIAL_MATCHES", label: "Potential matches" },
  { key: "OFFER_SENT", label: "Offer sent" },
  { key: "OFFER_EVALUATION", label: "Offer evaluation" },
  { key: "OFFER_ACCEPTED", label: "Offer accepted" },
  { key: "PROCUREMENT_IN_PROGRESS", label: "Procurement in progress" },
  { key: "PROCUREMENT_COMPLETED", label: "Procurement completed" },
  { key: "FULFILLED", label: "Fulfilled" },
] as const;

export type OrganWorkflowStage = (typeof ORGAN_WORKFLOW_STEPS)[number]["key"] | "REJECTED" | "CANCELLED" | "EXPIRED" | "UNAVAILABLE";

type WorkflowRecord = {
  status?: string;
  consentStatus?: string;
  authorizationStatus?: string;
  organs?: Array<{ status: string; matches?: Array<{ status: string }>; offers?: Array<{ status: string }>; procurements?: Array<{ status: string }> }>;
  matches?: Array<{ status: string; organ?: { status: string } }>;
  offers?: Array<{ status: string; organ?: { status: string; procurements?: Array<{ status: string }> } }>;
};

export function donorWorkflowStage(record: WorkflowRecord): OrganWorkflowStage {
  const organ = record.organs?.[0];
  if (["REJECTED", "DECLINED"].includes(record.consentStatus ?? "") || record.authorizationStatus === "REJECTED") return "REJECTED";
  if (record.consentStatus === "WITHDRAWN" || record.authorizationStatus === "WITHDRAWN" || record.status === "CLOSED") return "CANCELLED";
  if (organ?.status === "EXPIRED") return "EXPIRED";
  if (organ?.status === "UNAVAILABLE" || organ?.status === "DISCARDED") return "UNAVAILABLE";
  if (["COMPLETED", "TRANSPLANTED"].includes(organ?.status ?? "")) return "FULFILLED";
  if (organ?.procurements?.some((item) => item.status === "COMPLETED") || ["RETRIEVED", "PRESERVING", "FINAL_ASSESSMENT", "ALLOCATED"].includes(organ?.status ?? "")) return "PROCUREMENT_COMPLETED";
  if (organ?.procurements?.some((item) => item.status === "IN_PROGRESS") || ["RETRIEVAL_SCHEDULED", "RETRIEVAL_IN_PROGRESS"].includes(organ?.status ?? "")) return "PROCUREMENT_IN_PROGRESS";
  if (organ?.offers?.some((item) => item.status === "ACCEPTED")) return "OFFER_ACCEPTED";
  if (organ?.offers?.some((item) => item.status === "UNDER_REVIEW")) return "OFFER_EVALUATION";
  if (organ?.offers?.some((item) => item.status === "SENT")) return "OFFER_SENT";
  if (organ?.matches?.some((item) => ["GENERATED", "UNDER_REVIEW", "SHORTLISTED", "CONVERTED_TO_OFFER"].includes(item.status))) return "POTENTIAL_MATCHES";
  if (["ELIGIBLE_FOR_COORDINATION", "AVAILABLE", "MATCHING"].includes(organ?.status ?? "") || record.authorizationStatus === "AUTHORIZED") return "MATCHING";
  return "UNDER_REVIEW";
}

export function recipientWorkflowStage(record: WorkflowRecord): OrganWorkflowStage {
  if (record.status === "REJECTED") return "REJECTED";
  if (record.status === "CANCELLED") return "CANCELLED";
  if (record.status === "CLOSED") return "FULFILLED";
  if (record.offers?.some((item) => item.organ?.status === "EXPIRED")) return "EXPIRED";
  if (record.offers?.some((item) => item.organ?.status === "UNAVAILABLE")) return "UNAVAILABLE";
  const offer = record.offers?.find((item) => item.status === "ACCEPTED");
  const organStatus = offer?.organ?.status;
  if (organStatus && ["COMPLETED", "TRANSPLANTED"].includes(organStatus)) return "FULFILLED";
  if (offer?.organ?.procurements?.some((item) => item.status === "COMPLETED") || ["RETRIEVED", "PRESERVING", "FINAL_ASSESSMENT", "ALLOCATED"].includes(organStatus ?? "")) return "PROCUREMENT_COMPLETED";
  if (offer?.organ?.procurements?.some((item) => item.status === "IN_PROGRESS") || ["RETRIEVAL_SCHEDULED", "RETRIEVAL_IN_PROGRESS"].includes(organStatus ?? "")) return "PROCUREMENT_IN_PROGRESS";
  if (offer) return "OFFER_ACCEPTED";
  if (record.offers?.some((item) => item.status === "UNDER_REVIEW")) return "OFFER_EVALUATION";
  if (record.offers?.some((item) => item.status === "SENT")) return "OFFER_SENT";
  if (record.matches?.some((item) => ["GENERATED", "UNDER_REVIEW", "SHORTLISTED", "CONVERTED_TO_OFFER"].includes(item.status))) return "POTENTIAL_MATCHES";
  return record.status === "ACTIVE" ? "MATCHING" : "UNDER_REVIEW";
}

const terminalLabels: Partial<Record<OrganWorkflowStage, string>> = {
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  UNAVAILABLE: "Unavailable",
};

function GraphRows({ stage, compact = false }: { stage?: OrganWorkflowStage; compact?: boolean }) {
  const currentIndex = stage ? ORGAN_WORKFLOW_STEPS.findIndex((step) => step.key === stage) : -1;
  const firstRow = ORGAN_WORKFLOW_STEPS.slice(0, 5);
  const secondRow = ORGAN_WORKFLOW_STEPS.slice(5);
  const renderNode = (step: (typeof ORGAN_WORKFLOW_STEPS)[number], index: number, row: number) => (
    <li key={step.key} className={`flow-node${index < currentIndex ? " complete" : ""}${index === currentIndex ? " current" : ""}`} aria-current={index === currentIndex ? "step" : undefined}>
      <span className="flow-node-number">{index < currentIndex ? "✓" : String(index + 1).padStart(2, "0")}</span>
      <strong>{step.label}</strong>
      {row === 0 && index === 4 && <span className="flow-turn" aria-hidden="true">↓</span>}
    </li>
  );

  return <div className={`flow-graph${compact ? " compact" : ""}`}>
    <ol className="flow-graph-row forward">{firstRow.map((step, index) => renderNode(step, index, 0))}</ol>
    <ol className="flow-graph-row returning">{secondRow.map((step) => {
      const index = ORGAN_WORKFLOW_STEPS.findIndex((item) => item.key === step.key);
      return renderNode(step, index, 1);
    })}</ol>
  </div>;
}

export function WorkflowProgress({ stage, compact = false }: { stage: OrganWorkflowStage; compact?: boolean }) {
  const terminalLabel = terminalLabels[stage];
  return <div className={`workflow-progress${compact ? " compact" : ""}${terminalLabel ? " terminal" : ""}`} aria-label={`Organ workflow: ${terminalLabel ?? ORGAN_WORKFLOW_STEPS.find((step) => step.key === stage)?.label}`}>
    {terminalLabel ? <span className={`workflow-terminal workflow-terminal-${stage.toLowerCase()}`}>{terminalLabel}</span> : <GraphRows stage={stage} compact={compact}/>}
  </div>;
}

export function WorkflowPath() {
  return <section className="workflow-path panel" aria-label="Organ coordination stages">
    <div className="workflow-path-heading"><div><span className="eyebrow">COORDINATION LIFECYCLE</span><p>Requests move through a reviewed, authorized sequence.</p></div><span className="workflow-path-key">Main request path</span></div>
    <GraphRows/>
    <div className="workflow-path-alternates"><span>Alternative outcomes</span><b>Rejected</b><b>Cancelled</b><b>Expired</b><b>Unavailable</b><b>No suitable match · reopen or retry search</b></div>
  </section>;
}
