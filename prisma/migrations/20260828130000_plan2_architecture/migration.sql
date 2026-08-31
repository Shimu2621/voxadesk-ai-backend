CREATE TABLE "ContactMerge" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "sourceContactId" TEXT NOT NULL,
  "targetContactId" TEXT NOT NULL, "mergedById" TEXT NOT NULL, "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMerge_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContactMerge_organizationId_sourceContactId_key" ON "ContactMerge"("organizationId", "sourceContactId");
CREATE INDEX "ContactMerge_organizationId_createdAt_idx" ON "ContactMerge"("organizationId", "createdAt");

CREATE TABLE "ProviderHealth" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "provider" TEXT NOT NULL, "status" TEXT NOT NULL,
  "latencyMs" INTEGER, "errorCode" TEXT, "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderHealth_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderHealth_organizationId_checkedAt_idx" ON "ProviderHealth"("organizationId", "checkedAt");
CREATE INDEX "ProviderHealth_provider_checkedAt_idx" ON "ProviderHealth"("provider", "checkedAt");

CREATE TABLE "ExternalReference" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "provider" TEXT NOT NULL, "resourceType" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL, "externalId" TEXT NOT NULL, "metadataSafeJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalReference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalReference_organizationId_provider_resourceType_externalId_key" ON "ExternalReference"("organizationId", "provider", "resourceType", "externalId");
CREATE INDEX "ExternalReference_organizationId_resourceType_resourceId_idx" ON "ExternalReference"("organizationId", "resourceType", "resourceId");

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "channel" TEXT NOT NULL, "template" TEXT NOT NULL,
  "destinationMasked" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued', "idempotencyKey" TEXT NOT NULL,
  "providerMessageId" TEXT, "attemptCount" INTEGER NOT NULL DEFAULT 0, "errorCode" TEXT, "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDelivery_organizationId_idempotencyKey_key" ON "NotificationDelivery"("organizationId", "idempotencyKey");
CREATE INDEX "NotificationDelivery_organizationId_createdAt_idx" ON "NotificationDelivery"("organizationId", "createdAt");

CREATE TABLE "OutboundWebhook" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "url" TEXT NOT NULL, "eventTypesJson" JSONB NOT NULL,
  "secretRef" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OutboundWebhook_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboundWebhook_organizationId_createdAt_idx" ON "OutboundWebhook"("organizationId", "createdAt");

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "outboundWebhookId" TEXT NOT NULL, "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL, "payloadSafeJson" JSONB NOT NULL, "status" TEXT NOT NULL DEFAULT 'queued',
  "responseStatus" INTEGER, "attemptCount" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3), "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookDelivery_outboundWebhookId_eventId_key" ON "WebhookDelivery"("outboundWebhookId", "eventId");
CREATE INDEX "WebhookDelivery_organizationId_createdAt_idx" ON "WebhookDelivery"("organizationId", "createdAt");
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

CREATE TABLE "JobAttempt" (
  "id" TEXT NOT NULL, "organizationId" TEXT, "queue" TEXT NOT NULL, "jobId" TEXT NOT NULL, "attempt" INTEGER NOT NULL,
  "status" TEXT NOT NULL, "errorCode" TEXT, "durationMs" INTEGER, "metadataSafeJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JobAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "JobAttempt_queue_jobId_attempt_key" ON "JobAttempt"("queue", "jobId", "attempt");
CREATE INDEX "JobAttempt_organizationId_createdAt_idx" ON "JobAttempt"("organizationId", "createdAt");
CREATE INDEX "JobAttempt_queue_createdAt_idx" ON "JobAttempt"("queue", "createdAt");

ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_sourceContactId_fkey" FOREIGN KEY ("sourceContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_targetContactId_fkey" FOREIGN KEY ("targetContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProviderHealth" ADD CONSTRAINT "ProviderHealth_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalReference" ADD CONSTRAINT "ExternalReference_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutboundWebhook" ADD CONSTRAINT "OutboundWebhook_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_outboundWebhookId_fkey" FOREIGN KEY ("outboundWebhookId") REFERENCES "OutboundWebhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobAttempt" ADD CONSTRAINT "JobAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
