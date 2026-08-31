import {
  FakeKnowledgeIngestionProvider,
  type KnowledgeIngestionProvider,
} from "../integrations/knowledge-ingestion.js";
import { prisma } from "../lib/prisma.js";
import { createHash } from "node:crypto";

export async function processKnowledgeSource(
  organizationId: string,
  sourceId: string,
  provider: KnowledgeIngestionProvider = new FakeKnowledgeIngestionProvider(),
) {
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: sourceId, organizationId, archivedAt: null },
  });
  if (!source || source.status === "ready") return;
  const latestJob = await prisma.knowledgeProcessingJob.findFirst({
    where: { knowledgeSourceId: source.id, operation: "ingest" },
    orderBy: { attempt: "desc" },
  });
  const processingJob = await prisma.knowledgeProcessingJob.create({
    data: {
      organizationId,
      knowledgeSourceId: source.id,
      operation: "ingest",
      attempt: (latestJob?.attempt ?? 0) + 1,
    },
  });
  await prisma.knowledgeSource.update({
    where: { id: source.id },
    data: { status: "processing", error: null },
  });
  const result = await provider.extract(source);
  if (!result.success) {
    await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "failed", error: result.message },
    });
    await prisma.knowledgeProcessingJob.update({
      where: { id: processingJob.id },
      data: {
        status: "failed",
        errorCode: result.code,
        completedAt: new Date(),
      },
    });
    throw new Error(result.code);
  }
  const latestDocument = await prisma.knowledgeDocument.findFirst({
    where: { knowledgeSourceId: source.id },
    orderBy: { version: "desc" },
  });
  const contentChecksum = createHash("sha256")
    .update(result.data.content)
    .digest("hex");
  await prisma.$transaction([
    prisma.knowledgeDocument.create({
      data: {
        organizationId,
        knowledgeSourceId: source.id,
        version: (latestDocument?.version ?? 0) + 1,
        contentText: result.data.content,
        checksum: contentChecksum,
        indexedAt: new Date(),
      },
    }),
    prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "ready", contentText: result.data.content, error: null },
    }),
    prisma.knowledgeProcessingJob.update({
      where: { id: processingJob.id },
      data: { status: "completed", completedAt: new Date() },
    }),
  ]);
}
