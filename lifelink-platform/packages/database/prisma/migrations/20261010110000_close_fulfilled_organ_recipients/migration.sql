UPDATE "OrganRecipient" AS recipient
SET "status" = 'CLOSED'::"OrganRecipientStatus",
    "updatedAt" = CURRENT_TIMESTAMP
WHERE recipient."status" IN ('ACTIVE'::"OrganRecipientStatus", 'MATCHED'::"OrganRecipientStatus")
  AND EXISTS (
    SELECT 1
    FROM "OrganOffer" AS offer
    JOIN "OrganRecord" AS organ ON organ."id" = offer."organId"
    WHERE offer."recipientId" = recipient."id"
      AND offer."status" = 'ACCEPTED'::"OrganOfferStatus"
      AND organ."status" IN ('TRANSPLANTED'::"OrganStatus", 'COMPLETED'::"OrganStatus")
  );
