-- CreateEnum
CREATE TYPE "OrganType" AS ENUM ('KIDNEY', 'LIVER', 'HEART', 'LUNG', 'PANCREAS', 'INTESTINE', 'CORNEA', 'BONE_MARROW', 'OTHER');

-- CreateEnum
CREATE TYPE "OrganStatus" AS ENUM ('REGISTERED', 'ASSESSMENT_PENDING', 'ELIGIBLE_FOR_COORDINATION', 'AVAILABLE', 'MATCHING', 'OFFERED', 'ACCEPTED', 'RETRIEVAL_SCHEDULED', 'RETRIEVAL_IN_PROGRESS', 'RETRIEVED', 'PRESERVING', 'IN_TRANSIT', 'ARRIVED', 'FINAL_ASSESSMENT', 'ALLOCATED', 'TRANSPLANTED', 'COMPLETED', 'UNAVAILABLE', 'EXPIRED', 'DISCARDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrganDonorStatus" AS ENUM ('REGISTERED', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('PENDING', 'RECORDED', 'VERIFIED', 'REJECTED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrganAuthorizationStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "OrganRecipientStatus" AS ENUM ('ACTIVE', 'MATCHED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrganMatchStatus" AS ENUM ('GENERATED', 'UNDER_REVIEW', 'SHORTLISTED', 'REJECTED', 'CONVERTED_TO_OFFER', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrganOfferStatus" AS ENUM ('DRAFT', 'SENT', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProcurementStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PreservationMethod" AS ENUM ('STATIC_COLD_STORAGE', 'HYPOTHERMIC_MACHINE_PERFUSION', 'NORMOTHERMIC_MACHINE_PERFUSION', 'CORNEAL_STORAGE_MEDIUM', 'OTHER');

-- CreateEnum
CREATE TYPE "PreservationStatus" AS ENUM ('NOT_STARTED', 'NORMAL', 'WARNING', 'CRITICAL', 'EXPIRED');

-- CreateEnum
CREATE TYPE "OrganTransportStatus" AS ENUM ('PLANNED', 'READY_FOR_DISPATCH', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED', 'HANDED_OVER', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "OrganDonor" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID,
    "institutionId" UUID NOT NULL,
    "donorType" TEXT NOT NULL,
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "authorizationStatus" "OrganAuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "consentDate" TIMESTAMP(3),
    "authorizationDate" TIMESTAMP(3),
    "consentDocumentRef" TEXT,
    "status" "OrganDonorStatus" NOT NULL DEFAULT 'REGISTERED',
    "bloodGroup" "BloodGroup",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganDonor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganConsent" (
    "id" UUID NOT NULL,
    "donorId" UUID NOT NULL,
    "status" "ConsentStatus" NOT NULL DEFAULT 'PENDING',
    "consentType" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "authorizedById" UUID,
    "documentReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganRecord" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "donorId" UUID NOT NULL,
    "institutionId" UUID NOT NULL,
    "organType" "OrganType" NOT NULL,
    "status" "OrganStatus" NOT NULL DEFAULT 'REGISTERED',
    "bloodGroup" "BloodGroup",
    "retrievalTime" TIMESTAMP(3),
    "preservationStartTime" TIMESTAMP(3),
    "preservationMethod" "PreservationMethod",
    "preservationSolution" TEXT,
    "coldIschemiaStart" TIMESTAMP(3),
    "transportDepartureTime" TIMESTAMP(3),
    "transportArrivalTime" TIMESTAMP(3),
    "currentLocationId" UUID,
    "destinationCentreId" UUID,
    "allocatedRecipientId" UUID,
    "qualityStatus" TEXT,
    "medicalAssessmentStatus" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganRecipient" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" UUID,
    "institutionId" UUID NOT NULL,
    "requestId" UUID,
    "organType" "OrganType" NOT NULL,
    "bloodGroup" "BloodGroup",
    "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "OrganRecipientStatus" NOT NULL DEFAULT 'ACTIVE',
    "registrationDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipientRequirement" (
    "id" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "organType" "OrganType" NOT NULL,
    "bloodGroup" "BloodGroup",
    "priority" "RequestPriority" NOT NULL DEFAULT 'NORMAL',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "maximumDistanceKm" DOUBLE PRECISION,
    "urgency" TEXT,
    "requiredBy" TIMESTAMP(3),
    "configuredCriteria" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecipientRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganPreservationPolicy" (
    "id" UUID NOT NULL,
    "institutionId" UUID,
    "organType" "OrganType" NOT NULL,
    "method" "PreservationMethod" NOT NULL,
    "targetHours" DOUBLE PRECISION NOT NULL,
    "warningHours" DOUBLE PRECISION NOT NULL,
    "criticalHours" DOUBLE PRECISION NOT NULL,
    "maximumHours" DOUBLE PRECISION NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'DEMO / CONFIGURABLE - NOT A CLINICAL RULE',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganPreservationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganMatch" (
    "id" UUID NOT NULL,
    "organId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "status" "OrganMatchStatus" NOT NULL DEFAULT 'GENERATED',
    "coordinationScore" DOUBLE PRECISION NOT NULL,
    "matchReasons" JSONB NOT NULL,
    "criteriaSnapshot" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganOffer" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "organId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "offeringCentreId" UUID NOT NULL,
    "receivingCentreId" UUID NOT NULL,
    "status" "OrganOfferStatus" NOT NULL DEFAULT 'DRAFT',
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responseDeadline" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "responseReason" TEXT,
    "responderId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganProcurement" (
    "id" UUID NOT NULL,
    "organId" UUID NOT NULL,
    "procurementCentreId" UUID NOT NULL,
    "status" "ProcurementStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "retrievalTime" TIMESTAMP(3),
    "responsibleReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganProcurement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganTransport" (
    "id" UUID NOT NULL,
    "organId" UUID NOT NULL,
    "originCentreId" UUID NOT NULL,
    "destinationCentreId" UUID NOT NULL,
    "status" "OrganTransportStatus" NOT NULL DEFAULT 'PLANNED',
    "transportMode" TEXT NOT NULL,
    "departureTime" TIMESTAMP(3),
    "estimatedArrivalTime" TIMESTAMP(3),
    "actualArrivalTime" TIMESTAMP(3),
    "handoverTime" TIMESTAMP(3),
    "trackingReference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganTransport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganWorkflowEvent" (
    "id" UUID NOT NULL,
    "organId" UUID NOT NULL,
    "actorId" UUID,
    "institutionId" UUID,
    "eventType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganWorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganDonor_reference_key" ON "OrganDonor"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "OrganDonor_userId_key" ON "OrganDonor"("userId");

-- CreateIndex
CREATE INDEX "OrganDonor_institutionId_status_createdAt_idx" ON "OrganDonor"("institutionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrganDonor_consentStatus_authorizationStatus_idx" ON "OrganDonor"("consentStatus", "authorizationStatus");

-- CreateIndex
CREATE INDEX "OrganConsent_donorId_status_createdAt_idx" ON "OrganConsent"("donorId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganRecord_reference_key" ON "OrganRecord"("reference");

-- CreateIndex
CREATE INDEX "OrganRecord_organType_status_bloodGroup_idx" ON "OrganRecord"("organType", "status", "bloodGroup");

-- CreateIndex
CREATE INDEX "OrganRecord_institutionId_status_createdAt_idx" ON "OrganRecord"("institutionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrganRecord_destinationCentreId_status_idx" ON "OrganRecord"("destinationCentreId", "status");

-- CreateIndex
CREATE INDEX "OrganRecord_preservationStartTime_idx" ON "OrganRecord"("preservationStartTime");

-- CreateIndex
CREATE UNIQUE INDEX "OrganRecipient_reference_key" ON "OrganRecipient"("reference");

-- CreateIndex
CREATE INDEX "OrganRecipient_institutionId_status_priority_idx" ON "OrganRecipient"("institutionId", "status", "priority");

-- CreateIndex
CREATE INDEX "OrganRecipient_organType_bloodGroup_status_idx" ON "OrganRecipient"("organType", "bloodGroup", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientRequirement_recipientId_key" ON "RecipientRequirement"("recipientId");

-- CreateIndex
CREATE INDEX "RecipientRequirement_organType_bloodGroup_priority_idx" ON "RecipientRequirement"("organType", "bloodGroup", "priority");

-- CreateIndex
CREATE INDEX "OrganPreservationPolicy_organType_method_active_idx" ON "OrganPreservationPolicy"("organType", "method", "active");

-- CreateIndex
CREATE UNIQUE INDEX "OrganPreservationPolicy_institutionId_organType_method_key" ON "OrganPreservationPolicy"("institutionId", "organType", "method");

-- CreateIndex
CREATE INDEX "OrganMatch_organId_status_coordinationScore_idx" ON "OrganMatch"("organId", "status", "coordinationScore");

-- CreateIndex
CREATE INDEX "OrganMatch_recipientId_status_idx" ON "OrganMatch"("recipientId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OrganMatch_organId_recipientId_generatedAt_key" ON "OrganMatch"("organId", "recipientId", "generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganOffer_reference_key" ON "OrganOffer"("reference");

-- CreateIndex
CREATE INDEX "OrganOffer_organId_status_responseDeadline_idx" ON "OrganOffer"("organId", "status", "responseDeadline");

-- CreateIndex
CREATE INDEX "OrganOffer_receivingCentreId_status_createdAt_idx" ON "OrganOffer"("receivingCentreId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "OrganProcurement_status_scheduledAt_idx" ON "OrganProcurement"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "OrganTransport_status_estimatedArrivalTime_idx" ON "OrganTransport"("status", "estimatedArrivalTime");

-- CreateIndex
CREATE INDEX "OrganTransport_destinationCentreId_status_idx" ON "OrganTransport"("destinationCentreId", "status");

-- CreateIndex
CREATE INDEX "OrganWorkflowEvent_organId_createdAt_idx" ON "OrganWorkflowEvent"("organId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganWorkflowEvent_eventType_createdAt_idx" ON "OrganWorkflowEvent"("eventType", "createdAt");

-- AddForeignKey
ALTER TABLE "OrganDonor" ADD CONSTRAINT "OrganDonor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganDonor" ADD CONSTRAINT "OrganDonor_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganConsent" ADD CONSTRAINT "OrganConsent_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "OrganDonor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganConsent" ADD CONSTRAINT "OrganConsent_authorizedById_fkey" FOREIGN KEY ("authorizedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecord" ADD CONSTRAINT "OrganRecord_donorId_fkey" FOREIGN KEY ("donorId") REFERENCES "OrganDonor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecord" ADD CONSTRAINT "OrganRecord_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecord" ADD CONSTRAINT "OrganRecord_currentLocationId_fkey" FOREIGN KEY ("currentLocationId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecord" ADD CONSTRAINT "OrganRecord_destinationCentreId_fkey" FOREIGN KEY ("destinationCentreId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecord" ADD CONSTRAINT "OrganRecord_allocatedRecipientId_fkey" FOREIGN KEY ("allocatedRecipientId") REFERENCES "OrganRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecipient" ADD CONSTRAINT "OrganRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecipient" ADD CONSTRAINT "OrganRecipient_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganRecipient" ADD CONSTRAINT "OrganRecipient_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientRequirement" ADD CONSTRAINT "RecipientRequirement_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "OrganRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganPreservationPolicy" ADD CONSTRAINT "OrganPreservationPolicy_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganMatch" ADD CONSTRAINT "OrganMatch_organId_fkey" FOREIGN KEY ("organId") REFERENCES "OrganRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganMatch" ADD CONSTRAINT "OrganMatch_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "OrganRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganMatch" ADD CONSTRAINT "OrganMatch_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_organId_fkey" FOREIGN KEY ("organId") REFERENCES "OrganRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "OrganRecipient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "OrganMatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_offeringCentreId_fkey" FOREIGN KEY ("offeringCentreId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_receivingCentreId_fkey" FOREIGN KEY ("receivingCentreId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganOffer" ADD CONSTRAINT "OrganOffer_responderId_fkey" FOREIGN KEY ("responderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganProcurement" ADD CONSTRAINT "OrganProcurement_organId_fkey" FOREIGN KEY ("organId") REFERENCES "OrganRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganProcurement" ADD CONSTRAINT "OrganProcurement_procurementCentreId_fkey" FOREIGN KEY ("procurementCentreId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganTransport" ADD CONSTRAINT "OrganTransport_organId_fkey" FOREIGN KEY ("organId") REFERENCES "OrganRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganTransport" ADD CONSTRAINT "OrganTransport_originCentreId_fkey" FOREIGN KEY ("originCentreId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganTransport" ADD CONSTRAINT "OrganTransport_destinationCentreId_fkey" FOREIGN KEY ("destinationCentreId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganWorkflowEvent" ADD CONSTRAINT "OrganWorkflowEvent_organId_fkey" FOREIGN KEY ("organId") REFERENCES "OrganRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganWorkflowEvent" ADD CONSTRAINT "OrganWorkflowEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganWorkflowEvent" ADD CONSTRAINT "OrganWorkflowEvent_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
