# Organ Coordination Guide

## Organ-coordination lifecycle

The current implementation guide describes this high-level sequence:

1. A donor record and the applicable consent/authorization information are recorded.
2. An organ record and recipient requirement are maintained by authorized participants.
3. The system generates potential coordination matches using configured filters.
4. An authorized organ-centre user reviews a candidate and may shortlist or reject it.
5. An offer can be created from a reviewed shortlist and sent to the receiving centre.
6. The receiving centre responds through the authorized offer workflow.
7. Applicable procurement and related workflow statuses are recorded.

The application is the authoritative source for the current record and status.

## Potential matches

Candidate ranking can consider organ type, a configured blood-group filter, a geographic radius, recipient distance requirements, configured priority, and distance. The result is named “Potential Coordination Matches.” It is coordination support only, not a clinical compatibility result, medical eligibility decision, or final allocation.

An organ-centre user must review and shortlist a candidate before an offer can be sent. Offer responses are restricted to the authorized receiving institution or other explicitly permitted actor.

## Donor consent and authorization

Organ donor coordination relies on recorded consent and applicable authorization. The assistant cannot create, verify, or override consent, authorize a donor, or change the status of an organ or recipient record. Those operations must be performed through the authenticated LifeLink workflow by an authorized participant.

## Procurement and preservation timing

The platform supports applicable procurement workflow records and configured preservation timing. Preservation thresholds in a demonstration configuration are operational alerts, not clinical rules and not a determination of organ viability. Qualified professionals remain responsible for clinical assessment.

## Privacy and safety

Organ donor, recipient, supporting medical documents, and coordination records are sensitive. Their availability is controlled by backend authorization. The FAQ assistant must not disclose restricted personal or medical information and must not infer missing donor or recipient details.

## Important limitation

LifeLink does not autonomously determine final medical eligibility or organ allocation. Do not describe potential matches as confirmed allocation or transplantation outcomes. If the documentation and current application differ on a workflow capability, do not guess; direct the user to the relevant authorized centre or administrator.
