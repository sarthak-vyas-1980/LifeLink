ALTER TABLE "User"
  ADD COLUMN "address" TEXT,
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "credentialsChangedAt" TIMESTAMP(3),
  ADD COLUMN "notificationPreferences" JSONB NOT NULL DEFAULT '{"workflow":true,"emergency":true}';

ALTER TABLE "Institution"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "notificationPreferences" JSONB NOT NULL DEFAULT '{"workflow":true,"emergency":true}';

ALTER TABLE "InstitutionAccount"
  ADD COLUMN "credentialsChangedAt" TIMESTAMP(3);
