CREATE TABLE "KnowledgeDocument" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "knowledgeSourceId" TEXT NOT NULL,
  "version" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'ready', "contentText" TEXT NOT NULL,
  "checksum" TEXT NOT NULL, "indexedAt" TIMESTAMP(3), "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "KnowledgeProcessingJob" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "knowledgeSourceId" TEXT NOT NULL,
  "operation" TEXT NOT NULL, "attempt" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'processing',
  "errorCode" TEXT, "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "KnowledgeProcessingJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "KnowledgeDocument_knowledgeSourceId_version_key" ON "KnowledgeDocument"("knowledgeSourceId", "version");
CREATE INDEX "KnowledgeDocument_organizationId_createdAt_idx" ON "KnowledgeDocument"("organizationId", "createdAt");
CREATE UNIQUE INDEX "KnowledgeProcessingJob_knowledgeSourceId_operation_attempt_key" ON "KnowledgeProcessingJob"("knowledgeSourceId", "operation", "attempt");
CREATE INDEX "KnowledgeProcessingJob_organizationId_startedAt_idx" ON "KnowledgeProcessingJob"("organizationId", "startedAt");
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_knowledgeSourceId_fkey" FOREIGN KEY ("knowledgeSourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeProcessingJob" ADD CONSTRAINT "KnowledgeProcessingJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "KnowledgeProcessingJob" ADD CONSTRAINT "KnowledgeProcessingJob_knowledgeSourceId_fkey" FOREIGN KEY ("knowledgeSourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
