CREATE TYPE "AssistantMessageRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "AssistantConversation" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "ownerUserId" UUID,
    "ownerInstitutionId" UUID,
    "title" VARCHAR(120) NOT NULL DEFAULT 'New chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantConversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssistantConversation_exactly_one_owner_check"
      CHECK (("ownerUserId" IS NOT NULL) <> ("ownerInstitutionId" IS NOT NULL)),
    CONSTRAINT "AssistantConversation_ownerUserId_fkey"
      FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AssistantConversation_ownerInstitutionId_fkey"
      FOREIGN KEY ("ownerInstitutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "AssistantMessage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversationId" UUID NOT NULL,
    "clientMessageId" UUID NOT NULL,
    "role" "AssistantMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AssistantMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AssistantMessage_conversationId_fkey"
      FOREIGN KEY ("conversationId") REFERENCES "AssistantConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AssistantConversation_ownerUserId_updatedAt_idx"
  ON "AssistantConversation"("ownerUserId", "updatedAt");
CREATE INDEX "AssistantConversation_ownerInstitutionId_updatedAt_idx"
  ON "AssistantConversation"("ownerInstitutionId", "updatedAt");
CREATE UNIQUE INDEX "AssistantMessage_conversationId_clientMessageId_role_key"
  ON "AssistantMessage"("conversationId", "clientMessageId", "role");
CREATE INDEX "AssistantMessage_conversationId_createdAt_idx"
  ON "AssistantMessage"("conversationId", "createdAt");
