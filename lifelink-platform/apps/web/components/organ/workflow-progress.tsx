export const ORGAN_WORKFLOW_STEPS = [
  { key: "REQUEST_CREATED", label: "Request created" },
  { key: "UNDER_REVIEW", label: "Under review" },
  { key: "MATCHING", label: "Matching search" },
  { key: "POTENTIAL_MATCHES", label: "Potential matches" },
  { key: "OFFER_SENT", label: "Offer sent" },
  { key: "OFFER_EVALUATION", label: "Offer evaluation" },
  { key: "OFFER_ACCEPTED", label: "Offer accepted" },
  { key: "PROCUREMENT_IN_PROGRESS", label: "Procurement coordination" },
  { key: "PROCUREMENT_COMPLETED", label: "Procurement completed" },
  { key: "TRANSPLANT_COORDINATION", label: "Transplant coordination" },
  { key: "FULFILLED", label: "Transplant completed" },
] as const;

export const RECIPIENT_WORKFLOW_STEPS = ORGAN_WORKFLOW_STEPS.map((step) => step.key === "MATCHING" ? { ...step, label: "Waiting for eligible organ" } : step);

export const DONOR_WORKFLOW_STEPS = [
  { key: "REQUEST_CREATED", label: "Donor interest submitted" },
  { key: "UNDER_REVIEW", label: "Consent review" },
  { key: "DONOR_AUTHORIZATION", label: "Donor authorized" },
  { key: "ORGAN_REGISTRATION", label: "Organ case registration" },
  { key: "ORGAN_ASSESSMENT", label: "Organ assessment" },
  { key: "MATCHING", label: "Matching search" },
  { key: "POTENTIAL_MATCHES", label: "Potential recipients" },
  { key: "OFFER_COORDINATION", label: "Offer sent & reviewed" },
  { key: "DONOR_PROCUREMENT", label: "Retrieval in progress" },
  { key: "DONOR_RETRIEVED", label: "Retrieval completed" },
  { key: "DONOR_TRANSPLANT", label: "Transplant coordination" },
  { key: "FULFILLED", label: "Transplant completed" },
] as const;

export const DECEASED_DONOR_WORKFLOW_STEPS = [
  { key: "REQUEST_CREATED", label: "Donor interest submitted" },
  { key: "UNDER_REVIEW", label: "Consent review" },
  { key: "DONOR_AUTHORIZATION", label: "Donor authorized" },
  { key: "ORGAN_REGISTRATION", label: "Organ case registration" },
  { key: "ORGAN_ASSESSMENT", label: "Organ assessment" },
  { key: "DONOR_RETRIEVAL_PENDING", label: "Awaiting retrieval" },
  { key: "DONOR_PROCUREMENT", label: "Retrieval in progress" },
  { key: "FULFILLED", label: "Retrieval completed · added to stock" },
] as const;

export type OrganWorkflowStage = (typeof ORGAN_WORKFLOW_STEPS)[number]["key"] | "DONOR_AUTHORIZATION" | "ORGAN_REGISTRATION" | "ORGAN_ASSESSMENT" | "DONOR_RETRIEVAL_PENDING" | "OFFER_COORDINATION" | "DONOR_PROCUREMENT" | "DONOR_RETRIEVED" | "DONOR_TRANSPLANT" | "REJECTED" | "CANCELLED" | "EXPIRED" | "UNAVAILABLE";

type WorkflowRecord = {
  status?: string;
  consentStatus?: string;
  authorizationStatus?: string;
  donorType?: string;
  organs?: Array<{ status: string; matches?: Array<{ status: string }>; offers?: Array<{ status: string }>; procurements?: Array<{ status: string }> }>;
  matches?: Array<{ status: string; organ?: { status: string } }>;
  offers?: Array<{ status: string; organ?: { status: string; procurements?: Array<{ status: string }> } }>;
};

export function donorWorkflowStage(record: WorkflowRecord): OrganWorkflowStage {
  const organ = record.organs?.[0];
  const posthumous = record.donorType === "POSTHUMOUS_INTENT";
  const retrievalCompleted = organ?.procurements?.some((item) => item.status === "COMPLETED") ?? false;
  if (posthumous && retrievalCompleted) return "FULFILLED";
  if (["REJECTED", "DECLINED"].includes(record.consentStatus ?? "") || record.authorizationStatus === "REJECTED") return "REJECTED";
  if (organ?.status === "EXPIRED") return "EXPIRED";
  if (organ?.status === "UNAVAILABLE" || organ?.status === "DISCARDED") return "UNAVAILABLE";
  if (["COMPLETED", "TRANSPLANTED"].includes(organ?.status ?? "")) return "FULFILLED";
  if (record.consentStatus === "WITHDRAWN" || record.authorizationStatus === "WITHDRAWN" || record.status === "CLOSED") return "CANCELLED";
  if (organ?.procurements?.some((item) => ["SCHEDULED", "IN_PROGRESS"].includes(item.status)) || ["RETRIEVAL_SCHEDULED", "RETRIEVAL_IN_PROGRESS"].includes(organ?.status ?? "")) return "DONOR_PROCUREMENT";
  if (posthumous && ["ELIGIBLE_FOR_COORDINATION", "AVAILABLE", "MATCHING", "RETRIEVED", "PRESERVING", "FINAL_ASSESSMENT", "ALLOCATED"].includes(organ?.status ?? "")) return "DONOR_RETRIEVAL_PENDING";
  if (["RETRIEVED", "PRESERVING", "FINAL_ASSESSMENT", "ALLOCATED"].includes(organ?.status ?? "")) return "DONOR_TRANSPLANT";
  if (organ?.offers?.some((item) => item.status === "ACCEPTED")) return "OFFER_COORDINATION";
  if (organ?.offers?.some((item) => ["UNDER_REVIEW", "SENT"].includes(item.status))) return "OFFER_COORDINATION";
  if (organ?.matches?.some((item) => ["GENERATED", "UNDER_REVIEW", "SHORTLISTED", "CONVERTED_TO_OFFER"].includes(item.status))) return "POTENTIAL_MATCHES";
  if (record.authorizationStatus === "AUTHORIZED" && !organ) return "ORGAN_REGISTRATION";
	if (["REGISTERED", "ASSESSMENT_PENDING"].includes(organ?.status ?? "")) return "ORGAN_ASSESSMENT";
	if (["ELIGIBLE_FOR_COORDINATION", "AVAILABLE", "MATCHING"].includes(organ?.status ?? "")) return "MATCHING";
  if (record.consentStatus === "VERIFIED" && record.authorizationStatus === "PENDING") return "DONOR_AUTHORIZATION";
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
  if (["RETRIEVED", "PRESERVING", "FINAL_ASSESSMENT", "ALLOCATED"].includes(organStatus ?? "")) return "TRANSPLANT_COORDINATION";
  if (offer?.organ?.procurements?.some((item) => item.status === "COMPLETED")) return "TRANSPLANT_COORDINATION";
  if (offer) return "PROCUREMENT_IN_PROGRESS";
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

function GraphRows({ stage, compact = false, steps = ORGAN_WORKFLOW_STEPS }: { stage?: OrganWorkflowStage; compact?: boolean; steps?: readonly { key: OrganWorkflowStage; label: string }[] }) {
  const fulfilled = stage === "FULFILLED";
  const currentIndex = fulfilled ? steps.length : stage ? steps.findIndex((step) => step.key === stage) : -1;
  const splitAt = Math.ceil(steps.length / 2);
  const firstRow = steps.slice(0, splitAt);
  const secondRow = steps.slice(splitAt);
  const renderNode = (step: { key: OrganWorkflowStage; label: string }, index: number, row: number) => (
    <li key={step.key} className={`flow-node${index < currentIndex ? " complete" : ""}${index === currentIndex ? " current" : ""}`} aria-current={index === currentIndex ? "step" : undefined}>
      <span className="flow-node-number">{index < currentIndex ? "✓" : String(index + 1).padStart(2, "0")}</span>
      <strong>{step.label}</strong>
      {row === 0 && index === splitAt - 1 && <span className="flow-turn" aria-hidden="true">↓</span>}
    </li>
  );

  return <div className={`flow-graph${compact ? " compact" : ""}`}>
    <ol className="flow-graph-row forward" style={{ gridTemplateColumns: `repeat(${firstRow.length}, minmax(0, 1fr))` }}>{firstRow.map((step, index) => renderNode(step, index, 0))}</ol>
    <ol className="flow-graph-row returning" style={{ gridTemplateColumns: `repeat(${secondRow.length}, minmax(0, 1fr))` }}>{secondRow.map((step) => {
      const index = steps.findIndex((item) => item.key === step.key);
      return renderNode(step, index, 1);
    })}</ol>
  </div>;
}

export function WorkflowProgress({ stage, compact = false }: { stage: OrganWorkflowStage; compact?: boolean }) {
  const terminalLabel = terminalLabels[stage];
  return <div className={`workflow-progress${compact ? " compact" : ""}${terminalLabel ? " terminal" : ""}`} aria-label={`Recipient workflow: ${terminalLabel ?? RECIPIENT_WORKFLOW_STEPS.find((step) => step.key === stage)?.label}`}>
    {terminalLabel ? <span className={`workflow-terminal workflow-terminal-${stage.toLowerCase()}`}>{terminalLabel}</span> : <GraphRows stage={stage} compact={compact} steps={RECIPIENT_WORKFLOW_STEPS}/>}
  </div>;
}

export function DonorWorkflowProgress({ stage, donorType = "LIVING", compact = false }: { stage: OrganWorkflowStage; donorType?: string; compact?: boolean }) {
  const terminalLabel = terminalLabels[stage];
  const steps = donorType === "POSTHUMOUS_INTENT" ? DECEASED_DONOR_WORKFLOW_STEPS : DONOR_WORKFLOW_STEPS;
  const currentStage = stage;
  return <div className={`workflow-progress donor-workflow-progress${compact ? " compact" : ""}${terminalLabel ? " terminal" : ""}`} aria-label={`Donor workflow: ${terminalLabel ?? steps.find((step) => step.key === currentStage)?.label}`}>
    {terminalLabel ? <span className={`workflow-terminal workflow-terminal-${stage.toLowerCase()}`}>{terminalLabel}</span> : <GraphRows stage={currentStage} compact={compact} steps={steps}/>}
  </div>;
}

export function WorkflowPath() {
  return <section className="workflow-path panel" aria-label="Organ coordination stages">
    <details className="workflow-path-accordion"><summary><div><span className="eyebrow">RECIPIENT PATHWAY</span><p>A recipient requirement is reviewed, then waits for an eligible organ-specific match.</p></div><span className="workflow-path-key">Recipient request</span></summary><GraphRows steps={RECIPIENT_WORKFLOW_STEPS}/></details>
    <details className="workflow-path-accordion"><summary><div><span className="eyebrow">DONOR PATHWAY</span><p>Consent and authorization come first; an organ case must be registered and assessed before matching.</p></div><span className="workflow-path-key">Donor interest to organ case</span></summary><GraphRows steps={DONOR_WORKFLOW_STEPS}/></details>
    <details className="workflow-path-accordion"><summary><div><span className="eyebrow">POSTHUMOUS DONOR PATHWAY</span><p>After authorization and assessment, complete retrieval. The recovered organ enters timed inventory stock; recipient matching and transplant proceed through the recipient workflow.</p></div><span className="workflow-path-key">Retrieve to stock to recipient coordination</span></summary><GraphRows steps={DECEASED_DONOR_WORKFLOW_STEPS}/></details>
    <div className="workflow-path-alternates"><span>Alternative outcomes</span><b>Rejected</b><b>Cancelled</b><b>Expired</b><b>Unavailable</b><b>No suitable match - reopen or retry search</b></div>
  </section>;
}