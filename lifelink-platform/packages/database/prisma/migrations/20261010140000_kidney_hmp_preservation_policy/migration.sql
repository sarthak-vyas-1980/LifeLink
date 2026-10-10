-- Kidney HMP is available as a configured suggestion alongside static cold storage.
-- Centres can override this shared operational policy with an institution policy.
INSERT INTO "OrganPreservationPolicy" (
    "id", "institutionId", "organType", "method", "targetHours", "warningHours", "criticalHours", "maximumHours", "label", "active", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), NULL, 'KIDNEY'::"OrganType", 'HYPOTHERMIC_MACHINE_PERFUSION'::"PreservationMethod", 24, 18, 6, 24, 'DEMO / CONFIGURABLE - NOT A CLINICAL RULE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
    SELECT 1 FROM "OrganPreservationPolicy"
    WHERE "institutionId" IS NULL
      AND "organType" = 'KIDNEY'
      AND "method" = 'HYPOTHERMIC_MACHINE_PERFUSION'
);
