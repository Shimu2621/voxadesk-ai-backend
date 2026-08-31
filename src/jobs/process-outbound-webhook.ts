import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { safePublicUrlSchema } from "../security/url-policy.js";
import { enqueueOutboundWebhook } from "./queues.js";
import { incrementMetric } from "../lib/metrics.js";

export async function fanoutOutboundEvent(input: {
  organizationId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}) {
  const hooks = await prisma.outboundWebhook.findMany({
    where: { organizationId: input.organizationId, active: true },
  });
  for (const hook of hooks) {
    const types = Array.isArray(hook.eventTypesJson)
      ? hook.eventTypesJson.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    if (!types.includes(input.eventType) && !types.includes("*")) continue;
    const delivery = await prisma.webhookDelivery.upsert({
      where: {
        outboundWebhookId_eventId: {
          outboundWebhookId: hook.id,
          eventId: input.eventId,
        },
      },
      create: {
        organizationId: input.organizationId,
        outboundWebhookId: hook.id,
        eventId: input.eventId,
        eventType: input.eventType,
        payloadSafeJson: input.payload as Prisma.InputJsonObject,
      },
      update: {},
    });
    await enqueueOutboundWebhook(input.organizationId, delivery.id);
  }
}

export async function processOutboundWebhook(
  organizationId: string,
  deliveryId: string,
) {
  const delivery = await prisma.webhookDelivery.findFirst({
    where: { id: deliveryId, organizationId },
    include: { outboundWebhook: true },
  });
  if (!delivery || delivery.status === "delivered") return;
  const url = safePublicUrlSchema.parse(delivery.outboundWebhook.url);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    id: delivery.eventId,
    type: delivery.eventType,
    createdAt: delivery.createdAt.toISOString(),
    data: delivery.payloadSafeJson,
  });
  const signature = createHmac("sha256", env.AUTH_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "user-agent": "VoxaDesk-Webhook/1.0",
        "x-voxadesk-event": delivery.eventType,
        "x-voxadesk-timestamp": timestamp,
        "x-voxadesk-signature": `v1=${signature}`,
      },
      body,
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "delivered",
        responseStatus: response.status,
        deliveredAt: new Date(),
        attemptCount: { increment: 1 },
        nextAttemptAt: null,
      },
    });
    incrementMetric("outbound_webhook_deliveries_total", {
      result: "delivered",
      organizationId,
    });
  } catch (error) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "failed",
        attemptCount: { increment: 1 },
        nextAttemptAt: new Date(Date.now() + 60_000),
      },
    });
    incrementMetric("outbound_webhook_deliveries_total", {
      result: "failed",
      organizationId,
    });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
