ALTER TABLE "OrganRecord"
ADD COLUMN "transplantScheduledAt" TIMESTAMP(3),
ADD COLUMN "transplantCompletedAt" TIMESTAMP(3),
ADD COLUMN "transplantResponsibleReference" TEXT;

CREATE INDEX "OrganRecord_transplantScheduledAt_idx" ON "OrganRecord"("transplantScheduledAt");
