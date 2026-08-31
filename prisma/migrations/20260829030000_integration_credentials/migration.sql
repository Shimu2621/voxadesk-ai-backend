CREATE TABLE "IntegrationCredential" (
  "id" TEXT NOT NULL, "integrationId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
  "version" INTEGER NOT NULL, "keyVersion" TEXT NOT NULL, "ciphertext" TEXT NOT NULL,
  "iv" TEXT NOT NULL, "authTag" TEXT NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "rotatedAt" TIMESTAMP(3),
  CONSTRAINT "IntegrationCredential_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IntegrationCredential_integrationId_version_key" ON "IntegrationCredential"("integrationId", "version");
CREATE INDEX "IntegrationCredential_organizationId_active_idx" ON "IntegrationCredential"("organizationId", "active");
ALTER TABLE "IntegrationCredential" ADD CONSTRAINT "IntegrationCredential_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
