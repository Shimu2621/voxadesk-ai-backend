import { z } from "zod";
import {
  normalizeOutcome,
  nextConversationState,
} from "../domain/conversations.js";
import { planCodeSchema } from "../domain/entitlements.js";
import { prisma } from "../lib/prisma.js";
import { enqueue } from "./queues.js";
import { fanoutOutboundEvent } from "./process-outbound-webhook.js";

const conversationPayload = z.object({
  providerConversationId: z.string().min(1),
  agentId: z.string().cuid(),
  agentVersionId: z.string().cuid(),
  channel: z.enum(["PHONE", "WEB_VOICE", "WEB_TEXT"]),
  status: z.enum(["STARTED", "IN_PROGRESS", "COMPLETED", "FAILED"]),
  outcome: z.string().optional(),
  summary: z.string().max(10_000).optional(),
  durationSeconds: z.number().int().min(0).optional(),
  estimatedCost: z.number().min(0).optional(),
  isTest: z.boolean().default(false),
  messages: z
    .array(
      z.object({
        sequence: z.number().int().min(0),
        role: z.enum(["agent", "user", "system", "tool"]),
        content: z.string().max(50_000),
        timestamp: z.string().datetime(),
      }),
    )
    .default([]),
});
const stripePayload = z.object({
  customerId: z.string().min(1),
  subscriptionId: z.string().min(1),
  planCode: planCodeSchema,
  status: z.enum([
    "trialing",
    "active",
    "past_due",
    "canceled",
    "unpaid",
    "incomplete",
  ]),
  currentPeriodEnd: z.string().datetime().optional(),
  cancelAtPeriodEnd: z.boolean().default(false),
});
const twilioPayload = z.object({
  providerConversationId: z.string().min(1),
  status: z.string().min(1),
});

const twilioStates: Record<
  string,
  "STARTED" | "IN_PROGRESS" | "COMPLETED" | "FAILED"
> = {
  queued: "STARTED",
  initiated: "STARTED",
  ringing: "IN_PROGRESS",
  "in-progress": "IN_PROGRESS",
  completed: "COMPLETED",
  busy: "FAILED",
  failed: "FAILED",
  "no-answer": "FAILED",
  canceled: "FAILED",
};

async function processTwilio(event: {
  organizationId: string | null;
  payloadSafeJson: unknown;
}) {
  if (!event.organizationId)
    throw new Error("Twilio webhook has no organization.");
  const input = twilioPayload.parse(event.payloadSafeJson);
  const conversation = await prisma.conversation.findFirst({
    where: {
      organizationId: event.organizationId,
      provider: "twilio",
      providerConversationId: input.providerConversationId,
    },
  });
  if (!conversation) return;
  const incoming = twilioStates[input.status.toLowerCase()];
  if (!incoming) throw new Error("Unsupported Twilio call status.");
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { status: nextConversationState(conversation.status, incoming) },
  });
}

async function processConversation(event: {
  id: string;
  provider: string;
  providerEventId: string;
  organizationId: string | null;
  payloadSafeJson: unknown;
}) {
  if (!event.organizationId)
    throw new Error("Conversation webhook has no organization.");
  const input = conversationPayload.parse(event.payloadSafeJson);
  const version = await prisma.agentVersion.findFirst({
    where: {
      id: input.agentVersionId,
      agentId: input.agentId,
      agent: { organizationId: event.organizationId },
    },
  });
  if (!version)
    throw new Error(
      "Conversation agent version is outside the webhook organization.",
    );
  const existing = await prisma.conversation.findUnique({
    where: {
      provider_providerConversationId: {
        provider: event.provider,
        providerConversationId: input.providerConversationId,
      },
    },
  });
  const status = existing
    ? nextConversationState(existing.status, input.status)
    : input.status;
  const conversation = existing
    ? await prisma.conversation.update({
        where: { id: existing.id },
        data: {
          status,
          outcome: normalizeOutcome(input.outcome),
          summary: input.summary,
          durationSeconds: input.durationSeconds,
          estimatedCost: input.estimatedCost,
          isTest: input.isTest,
        },
      })
    : await prisma.conversation.create({
        data: {
          organizationId: event.organizationId,
          agentId: input.agentId,
          agentVersionId: input.agentVersionId,
          provider: event.provider,
          providerConversationId: input.providerConversationId,
          channel: input.channel,
          status,
          outcome: normalizeOutcome(input.outcome),
          summary: input.summary,
          durationSeconds: input.durationSeconds,
          estimatedCost: input.estimatedCost,
          isTest: input.isTest,
        },
      });
  if (input.messages.length)
    await prisma.conversationMessage.createMany({
      data: input.messages.map((message) => ({
        conversationId: conversation.id,
        sequence: message.sequence,
        role: message.role,
        content: message.content,
        timestamp: new Date(message.timestamp),
      })),
      skipDuplicates: true,
    });
  if (input.durationSeconds !== undefined)
    await prisma.usageEvent.upsert({
      where: {
        organizationId_idempotencyKey: {
          organizationId: event.organizationId,
          idempotencyKey: `conversation:${event.provider}:${input.providerConversationId}:duration`,
        },
      },
      create: {
        organizationId: event.organizationId,
        conversationId: conversation.id,
        metric: "voice_minutes",
        quantity: input.durationSeconds / 60,
        occurredAt: new Date(),
        idempotencyKey: `conversation:${event.provider}:${input.providerConversationId}:duration`,
      },
      update: {},
    });
  return conversation.id;
}

async function processStripe(event: {
  organizationId: string | null;
  payloadSafeJson: unknown;
}) {
  if (!event.organizationId)
    throw new Error("Stripe webhook has no organization.");
  const input = stripePayload.parse(event.payloadSafeJson);
  await prisma.subscription.upsert({
    where: { organizationId: event.organizationId },
    create: {
      organizationId: event.organizationId,
      providerCustomerId: input.customerId,
      providerSubscriptionId: input.subscriptionId,
      planCode: input.planCode,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd
        ? new Date(input.currentPeriodEnd)
        : null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    },
    update: {
      providerCustomerId: input.customerId,
      providerSubscriptionId: input.subscriptionId,
      planCode: input.planCode,
      status: input.status,
      currentPeriodEnd: input.currentPeriodEnd
        ? new Date(input.currentPeriodEnd)
        : null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    },
  });
}

export async function processWebhookEvent(webhookEventId: string) {
  const event = await prisma.webhookEvent.findUnique({
    where: { id: webhookEventId },
  });
  if (!event || event.status === "processed") return;
  await prisma.webhookEvent.update({
    where: { id: event.id },
    data: { status: "processing", attemptCount: { increment: 1 } },
  });
  try {
    let conversationId: string | undefined;
    if (event.provider === "elevenlabs")
      conversationId = await processConversation(event);
    else if (event.provider === "twilio") await processTwilio(event);
    else if (event.provider === "stripe") await processStripe(event);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "processed", processedAt: new Date() },
    });
    if (event.organizationId) {
      if (conversationId)
        await enqueue(
          "conversation-analysis",
          {
            organizationId: event.organizationId,
            resourceId: conversationId,
            operation: "analyze-conversation",
          },
          `analysis-${conversationId}`,
        );
      await fanoutOutboundEvent({
        organizationId: event.organizationId,
        eventId: event.id,
        eventType: event.type,
        payload: (event.payloadSafeJson ?? {}) as Record<string, unknown>,
      });
      await enqueue(
        "analytics-aggregation",
        {
          organizationId: event.organizationId,
          resourceId: event.organizationId,
          operation: "aggregate-usage",
        },
        `analytics-${event.id}`,
      );
    }
  } catch (error) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "failed" },
    });
    throw error;
  }
}
