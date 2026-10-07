-- A personal user may register multiple donor records, but only one active
-- request for a given organ. Existing donor records default to OTHER.
ALTER TABLE "OrganDonor" ADD COLUMN "organType" "OrganType" NOT NULL DEFAULT 'OTHER';
ALTER TABLE "OrganDonor" ALTER COLUMN "userId" DROP NOT NULL;
DROP INDEX IF EXISTS "OrganDonor_userId_key";
CREATE INDEX "OrganDonor_userId_organType_status_idx" ON "OrganDonor"("userId", "organType", "status");
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "OrganDonor"
    WHERE "userId" IS NOT NULL AND "status" IN ('REGISTERED', 'ACTIVE')
    GROUP BY "userId", "organType" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Resolve duplicate active donor records per user and organ before applying the organ donation uniqueness constraint.';
  END IF;
END $$;
CREATE UNIQUE INDEX "OrganDonor_one_active_user_organ" ON "OrganDonor"("userId", "organType")
  WHERE "userId" IS NOT NULL AND "status" IN ('REGISTERED', 'ACTIVE');

-- Earlier consent verification was institution-only. Reopen those records for
-- direct user review so legacy institutional actions do not count as consent.
UPDATE "OrganConsent"
SET "status" = 'PENDING', "recordedAt" = NULL, "verifiedAt" = NULL,
    "authorizedById" = NULL, "documentReference" = NULL
WHERE "status" IN ('RECORDED', 'VERIFIED');
UPDATE "OrganDonor"
SET "consentStatus" = 'PENDING', "consentDate" = NULL,
    "authorizationStatus" = 'PENDING', "authorizationDate" = NULL
WHERE "consentStatus" IN ('RECORDED', 'VERIFIED');

ALTER TYPE "ConsentStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "ConsentStatus" ADD VALUE IF NOT EXISTS 'DECLINED';
ALTER TABLE "OrganConsent" ADD COLUMN "respondedById" UUID;
ALTER TABLE "OrganConsent" ADD COLUMN "requestedAt" TIMESTAMP(3);
ALTER TABLE "OrganConsent" ADD COLUMN "respondedAt" TIMESTAMP(3);
ALTER TABLE "OrganConsent" ADD CONSTRAINT "OrganConsent_respondedById_fkey"
  FOREIGN KEY ("respondedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OrganConsent_respondedById_idx" ON "OrganConsent"("respondedById");

-- The organ state machine has no transport or delivery states. Require any
-- legacy records in those states to be resolved explicitly before removing them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "OrganRecord" WHERE "status" IN ('IN_TRANSIT', 'ARRIVED')) THEN
    RAISE EXCEPTION 'Resolve legacy organ transport states before applying transport-free lifecycle migration.';
  END IF;
END $$;
ALTER TYPE "OrganStatus" RENAME TO "OrganStatus_legacy";
CREATE TYPE "OrganStatus" AS ENUM (
  'REGISTERED', 'ASSESSMENT_PENDING', 'ELIGIBLE_FOR_COORDINATION', 'AVAILABLE',
  'MATCHING', 'OFFERED', 'ACCEPTED', 'RETRIEVAL_SCHEDULED', 'RETRIEVAL_IN_PROGRESS',
  'RETRIEVED', 'PRESERVING', 'FINAL_ASSESSMENT', 'ALLOCATED', 'TRANSPLANTED',
  'COMPLETED', 'UNAVAILABLE', 'EXPIRED', 'DISCARDED', 'CANCELLED'
);
ALTER TABLE "OrganRecord" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OrganRecord" ALTER COLUMN "status" TYPE "OrganStatus" USING ("status"::text::"OrganStatus");
ALTER TABLE "OrganRecord" ALTER COLUMN "status" SET DEFAULT 'REGISTERED';
DROP TYPE "OrganStatus_legacy";
