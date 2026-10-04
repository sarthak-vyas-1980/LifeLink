-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('HOSPITAL_USER', 'BLOOD_BANK_USER', 'ORGAN_CENTRE_USER', 'DONOR_RECIPIENT', 'ADMINISTRATOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('HOSPITAL', 'BLOOD_BANK', 'ORGAN_CENTRE');

-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING_VERIFICATION');

-- CreateEnum
CREATE TYPE "BloodGroup" AS ENUM ('A_POSITIVE', 'A_NEGATIVE', 'B_POSITIVE', 'B_NEGATIVE', 'AB_POSITIVE', 'AB_NEGATIVE', 'O_POSITIVE', 'O_NEGATIVE');

-- CreateEnum
CREATE TYPE "BloodComponent" AS ENUM ('WHOLE_BLOOD', 'RED_BLOOD_CELLS', 'PLASMA', 'PLATELETS', 'CRYOPRECIPITATE');

-- CreateEnum
CREATE TYPE "BloodInventoryStatus" AS ENUM ('AVAILABLE', 'RESERVED', 'UNAVAILABLE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RequestType" AS ENUM ('BLOOD', 'ORGAN');

-- CreateEnum
CREATE TYPE "RequestPriority" AS ENUM ('NORMAL', 'URGENT', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "RequestStatus" AS ENUM ('CREATED', 'UNDER_REVIEW', 'SEARCHING_MATCHING', 'INSTITUTIONS_NOTIFIED', 'OFFERS_RECEIVED', 'OFFER_EVALUATION', 'OFFER_ACCEPTED', 'RESERVED', 'IN_TRANSIT', 'FULFILLED', 'REOPENED', 'CANCELLED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DonationType" AS ENUM ('BLOOD', 'ORGAN');

-- CreateEnum
CREATE TYPE "DonationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrganInventoryStatus" AS ENUM ('AVAILABLE', 'ALLOCATED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "AllocationStatus" AS ENUM ('CONFIRMED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('EMAIL', 'SMS', 'IN_APP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('UNREAD', 'READ', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "institutionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Institution" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "InstitutionType" NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "contactPerson" TEXT,
    "contactNumber" TEXT,
    "status" "InstitutionStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospitalUser" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "hospitalId" UUID NOT NULL,
    "department" TEXT,
    "licenseNumber" TEXT,

    CONSTRAINT "HospitalUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DonorRecipient" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "bloodGroup" "BloodGroup",
    "donorType" TEXT,
    "medicalHistory" TEXT,
    "address" TEXT,

    CONSTRAINT "DonorRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Administrator" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "employeeId" TEXT,
    "designation" TEXT,

    CONSTRAINT "Administrator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BloodInventory" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "bloodGroup" "BloodGroup" NOT NULL,
    "component" "BloodComponent" NOT NULL,
    "unitsAvailable" INTEGER NOT NULL,
    "reservedUnits" INTEGER NOT NULL DEFAULT 0,
    "lastUpdated" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "status" "BloodInventoryStatus" NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "BloodInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganInventory" (
    "id" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "organType" TEXT NOT NULL,
    "bloodGroupCompatibility" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "OrganInventoryStatus" NOT NULL DEFAULT 'AVAILABLE',
    "lastUpdated" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" UUID NOT NULL,
    "requestType" "RequestType" NOT NULL,
    "bloodGroup" "BloodGroup",
    "component" "BloodComponent",
    "organType" TEXT,
    "quantity" INTEGER NOT NULL,
    "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "location" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "radiusKm" DOUBLE PRECISION,
    "contactNumber" TEXT NOT NULL,
    "requestDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "RequestStatus" NOT NULL DEFAULT 'CREATED',
    "createdById" UUID NOT NULL,

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestRecipient" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "userId" UUID,
    "patientName" TEXT NOT NULL,
    "age" INTEGER,
    "gender" TEXT,
    "medicalDetails" TEXT,

    CONSTRAINT "RequestRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Match" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "providerInstitutionId" UUID,
    "bloodInventoryId" UUID,
    "organInventoryId" UUID,
    "compatibilityScore" DOUBLE PRECISION,
    "status" "MatchStatus" NOT NULL DEFAULT 'PENDING',
    "matchedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reservedAt" TIMESTAMP(3),
    "reservationExpiresAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Donation" (
    "id" UUID NOT NULL,
    "requestId" UUID,
    "matchId" UUID,
    "donorId" UUID NOT NULL,
    "providerInstitutionId" UUID,
    "donationType" "DonationType" NOT NULL,
    "bloodGroup" "BloodGroup",
    "organType" TEXT,
    "status" "DonationStatus" NOT NULL DEFAULT 'PENDING',
    "remarks" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DonationInventory" (
    "id" UUID NOT NULL,
    "donationId" UUID NOT NULL,
    "bloodInventoryId" UUID,
    "bloodGroup" "BloodGroup",
    "organType" TEXT,
    "quantity" INTEGER NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "status" "BloodInventoryStatus" NOT NULL DEFAULT 'AVAILABLE',

    CONSTRAINT "DonationInventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Allocation" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "allocatedQuantity" INTEGER NOT NULL,
    "allocationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "AllocationStatus" NOT NULL DEFAULT 'CONFIRMED',

    CONSTRAINT "Allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'UNREAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDocument" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "category" TEXT NOT NULL,
    "sourceDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RagKnowledgeBase" (
    "id" UUID NOT NULL,
    "documentName" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embeddedVector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RagKnowledgeBase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "bloodGroup" "BloodGroup",
    "component" "BloodComponent",
    "location" TEXT,
    "forecastPeriod" TEXT,
    "result" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_institutionId_role_status_idx" ON "User"("institutionId", "role", "status");

-- CreateIndex
CREATE INDEX "Institution_type_status_idx" ON "Institution"("type", "status");

-- CreateIndex
CREATE INDEX "Institution_latitude_longitude_idx" ON "Institution"("latitude", "longitude");

-- CreateIndex
CREATE UNIQUE INDEX "HospitalUser_userId_key" ON "HospitalUser"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DonorRecipient_userId_key" ON "DonorRecipient"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Administrator_userId_key" ON "Administrator"("userId");

-- CreateIndex
CREATE INDEX "BloodInventory_bloodGroup_component_status_idx" ON "BloodInventory"("bloodGroup", "component", "status");

-- CreateIndex
CREATE INDEX "BloodInventory_bloodGroup_component_reservedUnits_idx" ON "BloodInventory"("bloodGroup", "component", "reservedUnits");

-- CreateIndex
CREATE INDEX "BloodInventory_institutionId_expiryDate_idx" ON "BloodInventory"("institutionId", "expiryDate");

-- CreateIndex
CREATE INDEX "OrganInventory_organType_status_idx" ON "OrganInventory"("organType", "status");

-- CreateIndex
CREATE INDEX "Request_requestType_status_priority_idx" ON "Request"("requestType", "status", "priority");

-- CreateIndex
CREATE INDEX "Request_bloodGroup_component_status_idx" ON "Request"("bloodGroup", "component", "status");

-- CreateIndex
CREATE INDEX "Request_latitude_longitude_idx" ON "Request"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "RequestRecipient_requestId_idx" ON "RequestRecipient"("requestId");

-- CreateIndex
CREATE INDEX "Match_requestId_status_idx" ON "Match"("requestId", "status");

-- CreateIndex
CREATE INDEX "Match_providerInstitutionId_status_idx" ON "Match"("providerInstitutionId", "status");

-- CreateIndex
CREATE INDEX "Match_status_reservationExpiresAt_idx" ON "Match"("status", "reservationExpiresAt");

-- CreateIndex
CREATE INDEX "Donation_requestId_status_idx" ON "Donation"("requestId", "status");

-- CreateIndex
CREATE INDEX "Donation_donorId_donationType_idx" ON "Donation"("donorId", "donationType");

-- CreateIndex
CREATE INDEX "Notification_userId_status_createdAt_idx" ON "Notification"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_createdAt_idx" ON "AuditLog"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalUser" ADD CONSTRAINT "HospitalUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospitalUser" ADD CONSTRAINT "HospitalUser_hospitalId_fkey" FOREIGN KEY ("hospitalId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DonorRecipient" ADD CONSTRAINT "DonorRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Administrator" ADD CONSTRAINT "Administrator_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BloodInventory" ADD CONSTRAINT "BloodInventory_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganInventory" ADD CONSTRAINT "OrganInventory_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_providerInstitutionId_fkey" FOREIGN KEY ("providerInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_bloodInventoryId_fkey" FOREIGN KEY ("bloodInventoryId") REFERENCES "BloodInventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Match" ADD CONSTRAINT "Match_organInventoryId_fkey" FOREIGN KEY ("organInventoryId") REFERENCES "OrganInventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_providerInstitutionId_fkey" FOREIGN KEY ("providerInstitutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DonationInventory" ADD CONSTRAINT "DonationInventory_donationId_fkey" FOREIGN KEY ("donationId") REFERENCES "Donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DonationInventory" ADD CONSTRAINT "DonationInventory_bloodInventoryId_fkey" FOREIGN KEY ("bloodInventoryId") REFERENCES "BloodInventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Allocation" ADD CONSTRAINT "Allocation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDocument" ADD CONSTRAINT "UserDocument_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
