import { Router } from "express";
import { z } from "zod";
import { queues, queueNames } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { safePublicUrlSchema } from "../security/url-policy.js";
import { enqueueOutboundWebhook } from "../jobs/queues.js";
import { audit } from "../lib/audit.js";
import { metricSnapshot } from "../lib/metrics.js";

const querySchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const operationsRouter = Router();
operationsRouter.use(requireAuth, requireRole("OWNER"));

operationsRouter.get("/health", async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const [providerChecks, queueCounts] = await Promise.all([
    prisma.providerHealth.findMany({
      where: { organizationId },
      orderBy: { checkedAt: "desc" },
      take: 100,
    }),
    Promise.all(
      queueNames.map(async (queue) => ({
        queue,
        ...(await queues[queue].getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
        )),
      })),
    ),
  ]);
  const providers = [
    ...new Map(providerChecks.map((check) => [check.provider, check])).values(),
  ];
  res.json({ data: { providers, queues: queueCounts } });
});

operationsRouter.get("/metrics", (req, res) =>
  res.json({ data: metricSnapshot(req.auth!.organizationId) }),
);

operationsRouter.get("/job-attempts", async (req, res) => {
  const query = querySchema.parse(req.query);
  const records = await prisma.jobAttempt.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const data = records.slice(0, query.limit);
  res.json({ data, nextCursor: hasMore ? data.at(-1)?.id : null });
});

operationsRouter.get("/webhook-deliveries", async (req, res) => {
  const query = querySchema.parse(req.query);
  const records = await prisma.webhookDelivery.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const data = records.slice(0, query.limit);
  res.json({ data, nextCursor: hasMore ? data.at(-1)?.id : null });
});

operationsRouter.get("/calendar-reconciliations", async (req, res) => {
  const query = querySchema.parse(req.query);
  const records = await prisma.calendarReconciliation.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const data = records.slice(0, query.limit);
  res.json({ data, nextCursor: hasMore ? data.at(-1)?.id : null });
});

operationsRouter.get("/outbound-webhooks", async (req, res) =>
  res.json({
    data: await prisma.outboundWebhook.findMany({
      where: { organizationId: req.auth!.organizationId },
      orderBy: { createdAt: "desc" },
    }),
  }),
);

operationsRouter.post("/outbound-webhooks", async (req, res) => {
  const input = z
    .object({
      url: safePublicUrlSchema,
      eventTypes: z.array(z.string().min(1).max(100)).min(1).max(50),
    })
    .parse(req.body);
  const data = await prisma.outboundWebhook.create({
    data: {
      organizationId: req.auth!.organizationId,
      url: input.url,
      eventTypesJson: [...new Set(input.eventTypes)],
      secretRef: "deployment:outbound-webhook:v1",
    },
  });
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "outbound_webhook.created",
    targetType: "outbound_webhook",
    targetId: data.id,
    metadata: {
      urlOrigin: new URL(input.url).origin,
      eventTypes: input.eventTypes,
    },
  });
  res.status(201).json({ data: { ...data, secretRef: undefined } });
});

operationsRouter.delete("/outbound-webhooks/:id", async (req, res) => {
  const id = z.string().cuid().parse(req.params.id);
  const hook = await prisma.outboundWebhook.findFirst({
    where: { id, organizationId: req.auth!.organizationId },
  });
  if (!hook) {
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Outbound webhook not found." });
    return;
  }
  await prisma.outboundWebhook.update({
    where: { id },
    data: { active: false },
  });
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "outbound_webhook.disabled",
    targetType: "outbound_webhook",
    targetId: id,
  });
  res.status(204).end();
});

operationsRouter.post("/webhook-deliveries/:id/replay", async (req, res) => {
  const id = z.string().cuid().parse(req.params.id);
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id, organizationId: req.auth!.organizationId },
  });
  if (!delivery) {
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Webhook delivery not found." });
    return;
  }
  await prisma.webhookDelivery.update({
    where: { id },
    data: { status: "queued", nextAttemptAt: null },
  });
  await enqueueOutboundWebhook(req.auth!.organizationId, id);
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "webhook_delivery.replayed",
    targetType: "webhook_delivery",
    targetId: id,
  });
  res.status(202).json({ data: { id, status: "queued" } });
});
