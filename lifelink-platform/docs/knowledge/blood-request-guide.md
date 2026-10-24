# Blood Request and Matching Guide

## Blood request lifecycle

The documented blood-request lifecycle is:

1. Created
2. Under Review
3. Searching/Matching
4. Institutions Notified
5. Offers Received
6. Offer Evaluation
7. Offer Accepted
8. Reserved
9. In Transit
10. Fulfilled

Alternative outcomes include Rejected, Cancelled, Expired, and Re-opened for another search cycle. The current request status in the application is authoritative.

## Information used for a blood request

A request records the required blood group, component or type, quantity, location, priority, and relevant request information, including contact information. The application validates required values before submission.

## Matching and offers

The current blood matching service searches eligible, available institutional blood inventory using the request requirements and location criteria. The current matcher does not search a separate opted-in individual blood-donor source. Results are potential matches, not a promise of fulfilment. A participating institution may respond to an offer, and an authorized requester evaluates applicable offers. The workflow records status changes.

## Reservation, dispatch, and receipt

An accepted offer first moves the request to the `OFFER_ACCEPTED` stage and can then be reserved through the authorized workflow. A reservation has an expiry time; if it expires, the workflow must not treat it as a valid reservation. Authorized participants perform dispatch and receipt steps. A request is marked fulfilled only when the applicable workflow reaches that state.

## Reopening or cancelling

Reopening allows an eligible request to go through another search cycle. Cancelling ends an active request. If a request has a reservation, the system workflow is responsible for releasing it when reopening or cancellation requires that outcome. Users should use the application controls rather than assume that a conversational answer changed a request.

## Important limitations

LifeLink search and matching do not make independent clinical transfusion-compatibility decisions. Inventory shown by the application is subject to update and confirmation by the responsible institution. Do not rely on indexed documents or the FAQ assistant to determine current stock, guarantee supply, or make a medical decision.
