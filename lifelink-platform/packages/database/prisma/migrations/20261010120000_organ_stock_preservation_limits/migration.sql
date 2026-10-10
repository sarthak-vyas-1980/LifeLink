-- Operational inventory display and timer thresholds supplied for each organ type.
-- These are configurable operational values, not clinical guidance.
UPDATE "OrganPreservationPolicy" SET
    "targetHours" = CASE "organType"
        WHEN 'HEART' THEN 4
        WHEN 'LUNG' THEN 6
        WHEN 'LIVER' THEN 12
        WHEN 'KIDNEY' THEN 24
        WHEN 'PANCREAS' THEN 12
        WHEN 'INTESTINE' THEN 8
        WHEN 'CORNEA' THEN 168
        ELSE "targetHours"
    END,
    "maximumHours" = CASE "organType"
        WHEN 'HEART' THEN 4
        WHEN 'LUNG' THEN 6
        WHEN 'LIVER' THEN 12
        WHEN 'KIDNEY' THEN 24
        WHEN 'PANCREAS' THEN 12
        WHEN 'INTESTINE' THEN 8
        WHEN 'CORNEA' THEN 168
        ELSE "maximumHours"
    END,
    "warningHours" = CASE "organType"
        WHEN 'HEART' THEN 3
        WHEN 'LUNG' THEN 4
        WHEN 'LIVER' THEN 8
        WHEN 'KIDNEY' THEN 18
        WHEN 'PANCREAS' THEN 8
        WHEN 'INTESTINE' THEN 6
        WHEN 'CORNEA' THEN 120
        ELSE "warningHours"
    END,
    "criticalHours" = CASE "organType"
        WHEN 'HEART' THEN 1
        WHEN 'LUNG' THEN 2
        WHEN 'LIVER' THEN 4
        WHEN 'KIDNEY' THEN 6
        WHEN 'PANCREAS' THEN 4
        WHEN 'INTESTINE' THEN 3
        WHEN 'CORNEA' THEN 48
        ELSE "criticalHours"
    END
WHERE "organType" IN ('HEART', 'LUNG', 'LIVER', 'KIDNEY', 'PANCREAS', 'INTESTINE', 'CORNEA');

INSERT INTO "OrganPreservationPolicy" (
    "id", "institutionId", "organType", "method", "targetHours", "warningHours", "criticalHours", "maximumHours", "label", "active", "createdAt", "updatedAt"
)
SELECT gen_random_uuid(), NULL, defaults."organType", defaults."method", defaults."targetHours", defaults."warningHours", defaults."criticalHours", defaults."targetHours", 'DEMO / CONFIGURABLE - NOT A CLINICAL RULE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (VALUES
    ('HEART'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 4.0, 3.0, 1.0),
    ('LUNG'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 6.0, 4.0, 2.0),
    ('LIVER'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 12.0, 8.0, 4.0),
    ('KIDNEY'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 24.0, 18.0, 6.0),
    ('PANCREAS'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 12.0, 8.0, 4.0),
    ('INTESTINE'::"OrganType", 'STATIC_COLD_STORAGE'::"PreservationMethod", 8.0, 6.0, 3.0),
    ('CORNEA'::"OrganType", 'CORNEAL_STORAGE_MEDIUM'::"PreservationMethod", 168.0, 120.0, 48.0)
) AS defaults("organType", "method", "targetHours", "warningHours", "criticalHours")
WHERE NOT EXISTS (
    SELECT 1 FROM "OrganPreservationPolicy" existing
    WHERE existing."institutionId" IS NULL
      AND existing."organType" = defaults."organType"
      AND existing."method" = defaults."method"
);
