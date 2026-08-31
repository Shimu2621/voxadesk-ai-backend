import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { credentialCipherFromEnvironment } from "../security/credentials.js";

export async function storeIntegrationCredential(input: {
  organizationId: string;
  integrationId: string;
  credential: Record<string, string>;
}) {
  const cipher = credentialCipherFromEnvironment(
    env.CREDENTIAL_ENCRYPTION_KEYS,
  );
  if (!cipher) throw new Error("CREDENTIAL_ENCRYPTION_NOT_CONFIGURED");
  const integration = await prisma.integration.findFirst({
    where: { id: input.integrationId, organizationId: input.organizationId },
  });
  if (!integration) throw new Error("INTEGRATION_NOT_FOUND");
  const latest = await prisma.integrationCredential.findFirst({
    where: { integrationId: integration.id },
    orderBy: { version: "desc" },
  });
  const encrypted = cipher.encrypt(input.credential);
  const version = (latest?.version ?? 0) + 1;
  return prisma.$transaction(async (tx) => {
    await tx.integrationCredential.updateMany({
      where: { integrationId: integration.id, active: true },
      data: { active: false, rotatedAt: new Date() },
    });
    const stored = await tx.integrationCredential.create({
      data: {
        integrationId: integration.id,
        organizationId: input.organizationId,
        version,
        ...encrypted,
      },
    });
    await tx.integration.update({
      where: { id: integration.id },
      data: { encryptedCredentialRef: stored.id },
    });
    return {
      id: stored.id,
      version: stored.version,
      keyVersion: stored.keyVersion,
      createdAt: stored.createdAt,
    };
  });
}

export async function rotateIntegrationCredential(
  organizationId: string,
  integrationId: string,
) {
  const cipher = credentialCipherFromEnvironment(
    env.CREDENTIAL_ENCRYPTION_KEYS,
  );
  if (!cipher) throw new Error("CREDENTIAL_ENCRYPTION_NOT_CONFIGURED");
  const current = await prisma.integrationCredential.findFirst({
    where: { integrationId, organizationId, active: true },
  });
  if (!current) throw new Error("CREDENTIAL_NOT_FOUND");
  return storeIntegrationCredential({
    organizationId,
    integrationId,
    credential: cipher.decrypt(current),
  });
}
