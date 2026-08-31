import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const rangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    includeTests: z.coerce.boolean().default(false),
  })
  .refine(
    (value) => !value.from || !value.to || value.to > value.from,
    "to must be after from",
  );
export const analyticsRouter = Router();
analyticsRouter.get("/", requireAuth, async (req, res) => {
  const range = rangeSchema.parse(req.query);
  const organizationId = req.auth!.organizationId;
  const createdAt =
    range.from || range.to ? { gte: range.from, lt: range.to } : undefined;
  const where = {
    organizationId,
    createdAt,
    ...(range.includeTests ? {} : { isTest: false }),
  };
  const [total, outcomes, duration, cost, unresolved] = await Promise.all([
    prisma.conversation.count({ where }),
    prisma.conversation.groupBy({
      by: ["outcome"],
      where,
      _count: { _all: true },
    }),
    prisma.conversation.aggregate({ where, _avg: { durationSeconds: true } }),
    prisma.conversation.aggregate({ where, _sum: { estimatedCost: true } }),
    prisma.inboxTask.count({
      where: { organizationId, status: { not: "RESOLVED" }, createdAt },
    }),
  ]);
  res.json({
    data: {
      totalConversations: total,
      outcomes: outcomes.map((item) => ({
        outcome: item.outcome ?? "unknown",
        count: item._count._all,
      })),
      averageDurationSeconds: duration._avg.durationSeconds ?? 0,
      estimatedCost: cost._sum.estimatedCost?.toString() ?? "0",
      unresolvedTasks: unresolved,
    },
  });
});
