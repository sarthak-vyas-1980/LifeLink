-- Separate user/admin accounts from institution-scoped access.
ALTER TYPE "UserRole" RENAME TO "UserRole_legacy";
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

ALTER TABLE "User" ADD COLUMN "role_new" "UserRole";
UPDATE "User" AS u
SET "role_new" = CASE
  WHEN u."role"::text = 'ADMINISTRATOR' THEN 'ADMIN'::"UserRole"
  ELSE 'USER'::"UserRole"
END;
UPDATE "User" SET "status" = 'INACTIVE'
WHERE "role"::text IN ('HOSPITAL_USER', 'BLOOD_BANK_USER', 'ORGAN_CENTRE_USER');
ALTER TABLE "User" DROP COLUMN "role";
ALTER TABLE "User" RENAME COLUMN "role_new" TO "role";
ALTER TABLE "User" ALTER COLUMN "role" SET NOT NULL;
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");
DROP TYPE "UserRole_legacy";

-- Move organization credentials out of personal User records.
CREATE TABLE "InstitutionAccount" (
  "id" UUID NOT NULL,
  "institutionId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstitutionAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InstitutionAccount_institutionId_key" ON "InstitutionAccount"("institutionId");
CREATE UNIQUE INDEX "InstitutionAccount_email_key" ON "InstitutionAccount"("email");
ALTER TABLE "InstitutionAccount" ADD CONSTRAINT "InstitutionAccount_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "InstitutionAccount" ("id", "institutionId", "email", "phone", "passwordHash", "createdAt", "updatedAt")
SELECT DISTINCT ON (u."institutionId") gen_random_uuid(), u."institutionId", u."email", u."phone", u."passwordHash", u."createdAt", CURRENT_TIMESTAMP
FROM "User" u
WHERE u."institutionId" IS NOT NULL AND u."phone" IS NOT NULL
ORDER BY u."institutionId", u."createdAt", u."id";
ALTER TABLE "User" DROP CONSTRAINT "User_institutionId_fkey";
DROP INDEX IF EXISTS "User_institutionId_role_status_idx";
ALTER TABLE "User" DROP COLUMN "institutionId";

-- Keep the old personal profile data and split recipient demographics out.
ALTER TABLE "DonorRecipient" RENAME TO "DonorProfile";
CREATE TABLE "RecipientProfile" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "dateOfBirth" TIMESTAMP(3),
  "address" TEXT,
  CONSTRAINT "RecipientProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecipientProfile_userId_key" ON "RecipientProfile"("userId");
INSERT INTO "RecipientProfile" ("id", "userId", "dateOfBirth", "address")
SELECT gen_random_uuid(), u."id", d."dateOfBirth", d."address"
FROM "User" u
LEFT JOIN "DonorProfile" d ON d."userId" = u."id"
WHERE EXISTS (SELECT 1 FROM "RequestRecipient" rr WHERE rr."userId" = u."id")
   OR EXISTS (SELECT 1 FROM "OrganRecipient" orc WHERE orc."userId" = u."id");
ALTER TABLE "RecipientProfile" ADD CONSTRAINT "RecipientProfile_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Institutional coordinator details are not personal user roles.
DROP TABLE "HospitalUser";

-- Allow a request to be created by either a person or an institution account.
ALTER TABLE "Request" ALTER COLUMN "createdById" DROP NOT NULL;
ALTER TABLE "Request" ADD COLUMN "createdByInstitutionId" UUID;
ALTER TABLE "Request" ADD CONSTRAINT "Request_createdByInstitutionId_fkey"
  FOREIGN KEY ("createdByInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Institution inbox and actor references use the organization identity directly.
ALTER TABLE "Notification" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "Notification" ADD COLUMN "institutionId" UUID;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Notification_institutionId_eventId_key" ON "Notification"("institutionId", "eventId");
CREATE INDEX "Notification_institutionId_status_createdAt_idx" ON "Notification"("institutionId", "status", "createdAt");

ALTER TABLE "WorkflowEvent" ADD COLUMN "actorInstitutionId" UUID;
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_actorInstitutionId_fkey"
  FOREIGN KEY ("actorInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkflowEvent" ADD CONSTRAINT "WorkflowEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD COLUMN "actorInstitutionId" UUID;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorInstitutionId_fkey"
  FOREIGN KEY ("actorInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Specialize each institution by its declared type. Hospital service rows are
-- deliberately absent until the hospital enables that optional capability.
CREATE TABLE "HospitalProfile" (
  "id" UUID NOT NULL,
  "institutionId" UUID NOT NULL,
  "hospitalType" TEXT,
  "emergencySupport" BOOLEAN NOT NULL DEFAULT false,
  "icuAvailable" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "HospitalProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospitalProfile_institutionId_key" ON "HospitalProfile"("institutionId");
ALTER TABLE "HospitalProfile" ADD CONSTRAINT "HospitalProfile_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "HospitalProfile" ("id", "institutionId")
SELECT gen_random_uuid(), "id" FROM "Institution" WHERE "type" = 'HOSPITAL';

CREATE TABLE "HospitalBloodService" (
  "id" UUID NOT NULL,
  "hospitalId" UUID NOT NULL,
  "operatingHours" TEXT,
  "serviceContact" TEXT,
  CONSTRAINT "HospitalBloodService_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospitalBloodService_hospitalId_key" ON "HospitalBloodService"("hospitalId");
ALTER TABLE "HospitalBloodService" ADD CONSTRAINT "HospitalBloodService_hospitalId_fkey"
  FOREIGN KEY ("hospitalId") REFERENCES "HospitalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "HospitalBloodService" ("id", "hospitalId")
SELECT gen_random_uuid(), hp."id"
FROM "HospitalProfile" hp
JOIN "Institution" i ON i."id" = hp."institutionId"
WHERE EXISTS (SELECT 1 FROM "BloodInventory" bi WHERE bi."institutionId" = i."id");

CREATE TABLE "HospitalOrganService" (
  "id" UUID NOT NULL,
  "hospitalId" UUID NOT NULL,
  "transplantFacility" BOOLEAN NOT NULL DEFAULT false,
  "transplantPrograms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT "HospitalOrganService_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospitalOrganService_hospitalId_key" ON "HospitalOrganService"("hospitalId");
ALTER TABLE "HospitalOrganService" ADD CONSTRAINT "HospitalOrganService_hospitalId_fkey"
  FOREIGN KEY ("hospitalId") REFERENCES "HospitalProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "HospitalOrganService" ("id", "hospitalId")
SELECT gen_random_uuid(), hp."id"
FROM "HospitalProfile" hp
JOIN "Institution" i ON i."id" = hp."institutionId"
WHERE EXISTS (SELECT 1 FROM "OrganRecord" o WHERE o."institutionId" = i."id")
   OR EXISTS (SELECT 1 FROM "OrganRecipient" r WHERE r."institutionId" = i."id");

CREATE TABLE "BloodBankProfile" (
  "id" UUID NOT NULL,
  "institutionId" UUID NOT NULL,
  "storageCapacity" INTEGER,
  "operatingHours" TEXT,
  CONSTRAINT "BloodBankProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BloodBankProfile_institutionId_key" ON "BloodBankProfile"("institutionId");
ALTER TABLE "BloodBankProfile" ADD CONSTRAINT "BloodBankProfile_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "BloodBankProfile" ("id", "institutionId")
SELECT gen_random_uuid(), "id" FROM "Institution" WHERE "type" = 'BLOOD_BANK';

CREATE TABLE "OrganCentreProfile" (
  "id" UUID NOT NULL,
  "institutionId" UUID NOT NULL,
  "centreType" TEXT,
  "transplantPrograms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT "OrganCentreProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OrganCentreProfile_institutionId_key" ON "OrganCentreProfile"("institutionId");
ALTER TABLE "OrganCentreProfile" ADD CONSTRAINT "OrganCentreProfile_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
INSERT INTO "OrganCentreProfile" ("id", "institutionId")
SELECT gen_random_uuid(), "id" FROM "Institution" WHERE "type" = 'ORGAN_CENTRE';
