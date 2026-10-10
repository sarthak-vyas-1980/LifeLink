UPDATE "OrganDonor" AS donor
SET "status" = 'FULFILLED'
WHERE donor."status" IN ('REGISTERED', 'ACTIVE', 'CLOSED')
  AND (
    (
      donor."donorType" = 'POSTHUMOUS_INTENT'
      AND EXISTS (
        SELECT 1
        FROM "OrganRecord" AS organ
        JOIN "OrganProcurement" AS procurement ON procurement."organId" = organ."id"
        WHERE organ."donorId" = donor."id"
          AND procurement."status" = 'COMPLETED'
      )
    )
    OR EXISTS (
      SELECT 1
      FROM "OrganRecord" AS organ
      WHERE organ."donorId" = donor."id"
        AND organ."status" IN ('TRANSPLANTED', 'COMPLETED')
    )
  );
