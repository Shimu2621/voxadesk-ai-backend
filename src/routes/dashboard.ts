import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { prisma } from "../lib/prisma.js";

export const dashboardRouter = Router();
dashboardRouter.get("/", requireAuth, async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const production = { organizationId, isTest: false };
  const [
    organization,
    totalConversations,
    booked,
    qualifiedLeads,
    unresolvedTasks,
    duration,
    cost,
  ] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    }),
    prisma.conversation.count({ where: production }),
    prisma.conversation.count({ where: { ...production, outcome: "booked" } }),
    prisma.contact.count({ where: { organizationId, leadScore: { gte: 50 } } }),
    prisma.inboxTask.count({
      where: { organizationId, status: { not: "RESOLVED" } },
    }),
    prisma.conversation.aggregate({
      where: production,
      _avg: { durationSeconds: true },
    }),
    prisma.conversation.aggregate({
      where: production,
      _sum: { estimatedCost: true },
    }),
  ]);
  res.json({
    organization,
    metrics: {
      totalConversations,
      bookingRate: totalConversations ? booked / totalConversations : 0,
      qualifiedLeads,
      unresolvedTasks,
      averageDurationSeconds: duration._avg.durationSeconds ?? 0,
      estimatedCost: cost._sum.estimatedCost?.toString() ?? "0",
    },
  });
});
