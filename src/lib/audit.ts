import { prisma } from "./prisma.js";
import type { Prisma } from "@prisma/client";

export async function audit(input: {
  organizationId: string;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  result?: string;
  metadata?: Prisma.InputJsonObject;
}) {
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result ?? "success",
      metadataSafeJson: input.metadata,
    },
  });
}
