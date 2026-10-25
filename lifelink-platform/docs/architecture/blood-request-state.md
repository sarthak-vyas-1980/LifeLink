# Blood Request State Model

## States

Created -> Searching/Matching -> Institutions Notified -> Offers Received -> Offer Evaluation -> Offer Accepted -> Reserved -> In Transit -> Fulfilled.

Standard and emergency requests start matching immediately after submission. `UNDER_REVIEW` is retained as an internal transition state for compatibility; administrator approval is not required.

## Alternate Outcomes

Rejected, Cancelled, Expired, and Re-opened for another search cycle.
