CREATE TABLE "MedicalDocument" (
    "id" UUID NOT NULL,
    "donorId" UUID,
    "recipientId" UUID,
    "bucket" TEXT NOT NULL,
    "objectPath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "uploadedById" UUID,
    "institutionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MedicalDocument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MedicalDocument_objectPath_key" ON "MedicalDocument"("objectPath");
CREATE INDEX "MedicalDocument_donorId_deletedAt_createdAt_idx" ON "MedicalDocument"("donorId", "deletedAt", "createdAt");
CREATE INDEX "MedicalDocument_recipientId_deletedAt_createdAt_idx" ON "MedicalDocument"("recipientId", "deletedAt", "createdAt");

ALTER TABLE "MedicalDocument" ADD CONSTRAINT "MedicalDocument_donorId_fkey"
  FOREIGN KEY ("donorId") REFERENCES "OrganDonor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MedicalDocument" ADD CONSTRAINT "MedicalDocument_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "OrganRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MedicalDocument" ADD CONSTRAINT "MedicalDocument_single_parent_check"
  CHECK (("donorId" IS NULL) <> ("recipientId" IS NULL));
