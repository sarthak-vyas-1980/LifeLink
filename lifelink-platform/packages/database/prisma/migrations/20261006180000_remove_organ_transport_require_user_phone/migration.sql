-- Remove the transport entity from organ coordination.
ALTER TABLE "OrganTransport" DROP CONSTRAINT "OrganTransport_organId_fkey";
ALTER TABLE "OrganTransport" DROP CONSTRAINT "OrganTransport_originCentreId_fkey";
ALTER TABLE "OrganTransport" DROP CONSTRAINT "OrganTransport_destinationCentreId_fkey";
DROP TABLE "OrganTransport";
DROP TYPE "OrganTransportStatus";
ALTER TABLE "OrganRecord" DROP COLUMN "transportDepartureTime";
ALTER TABLE "OrganRecord" DROP COLUMN "transportArrivalTime";

-- Require real phone numbers for personal user accounts. Populate any legacy
-- null values before applying this migration; do not fabricate contact data.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "phone" IS NULL) THEN
    RAISE EXCEPTION 'Cannot require User.phone: populate phone values for existing users first.';
  END IF;
END $$;
ALTER TABLE "User" ALTER COLUMN "phone" SET NOT NULL;