-- Backfill timers for posthumous organs retrieved before automatic timer start
-- was enabled. Use the recorded retrieval timestamp as the timer start.
WITH completed_retrievals AS (
    SELECT "organId", MAX(COALESCE("retrievalTime", "completedAt")) AS "retrievedAt"
    FROM "OrganProcurement"
    WHERE "status" = 'COMPLETED'
    GROUP BY "organId"
)
UPDATE "OrganRecord" organ
SET "status" = 'PRESERVING',
    "preservationMethod" = CASE WHEN organ."organType" = 'CORNEA' THEN 'CORNEAL_STORAGE_MEDIUM'::"PreservationMethod" ELSE 'STATIC_COLD_STORAGE'::"PreservationMethod" END,
    "preservationStartTime" = COALESCE(organ."retrievalTime", retrievals."retrievedAt"),
    "coldIschemiaStart" = COALESCE(organ."coldIschemiaStart", organ."retrievalTime", retrievals."retrievedAt")
FROM "OrganDonor" donor, completed_retrievals retrievals
WHERE donor."id" = organ."donorId"
  AND retrievals."organId" = organ."id"
  AND donor."donorType" = 'POSTHUMOUS_INTENT'
  AND organ."status" IN ('RETRIEVED', 'PRESERVING')
  AND organ."preservationStartTime" IS NULL
  AND COALESCE(organ."retrievalTime", retrievals."retrievedAt") IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM "OrganPreservationPolicy" policy
      WHERE policy."organType" = organ."organType"
        AND policy."method" = CASE WHEN organ."organType" = 'CORNEA' THEN 'CORNEAL_STORAGE_MEDIUM'::"PreservationMethod" ELSE 'STATIC_COLD_STORAGE'::"PreservationMethod" END
        AND policy."active" = true
        AND (policy."institutionId" = organ."institutionId" OR policy."institutionId" IS NULL)
  );
