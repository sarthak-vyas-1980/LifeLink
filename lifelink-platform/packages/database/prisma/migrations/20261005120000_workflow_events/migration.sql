ALTER TABLE "Notification"
    ADD COLUMN "eventId" UUID,
    ADD COLUMN "eventType" TEXT,
    ADD COLUMN "requestId" UUID,
    ADD COLUMN "payload" JSONB;

CREATE UNIQUE INDEX "Notification_userId_eventId_key"
    ON "Notification"("userId", "eventId");
CREATE INDEX "Notification_requestId_createdAt_idx"
    ON "Notification"("requestId", "createdAt");

CREATE TABLE "WorkflowEvent" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "requestId" UUID,
    "actorId" UUID,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    CONSTRAINT "WorkflowEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkflowEvent_publishedAt_createdAt_idx"
    ON "WorkflowEvent"("publishedAt", "createdAt");
CREATE INDEX "WorkflowEvent_requestId_createdAt_idx"
    ON "WorkflowEvent"("requestId", "createdAt");
