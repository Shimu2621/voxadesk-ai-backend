import { z } from "zod";

export type NormalizedProviderEvent = {
  eventId: string;
  type: string;
  occurredAt: Date;
  data: Record<string, unknown>;
};

const elevenLabsSchema = z.object({
  type: z.string().min(1),
  event_timestamp: z.union([z.number(), z.string()]),
  data: z
    .object({
      conversation_id: z.string().min(1),
      status: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
      transcript: z.array(z.record(z.unknown())).optional(),
      analysis: z.record(z.unknown()).optional(),
    })
    .passthrough(),
});

const localMetadataSchema = z.object({
  voxadesk_agent_id: z.string().cuid(),
  voxadesk_agent_version_id: z.string().cuid(),
  voxadesk_channel: z.enum(["PHONE", "WEB_VOICE", "WEB_TEXT"]).default("PHONE"),
  voxadesk_is_test: z.union([z.boolean(), z.string()]).optional(),
});

const stripeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().nonnegative(),
  data: z.object({ object: z.record(z.unknown()) }),
});

const twilioSchema = z
  .object({
    EventSid: z.string().min(1).optional(),
    CallSid: z.string().min(1),
    CallStatus: z.string().min(1),
    Timestamp: z.string().min(1),
    To: z.string().optional(),
    From: z.string().optional(),
  })
  .passthrough();

export function normalizeElevenLabsWebhook(
  payload: unknown,
): NormalizedProviderEvent {
  const input = elevenLabsSchema.parse(payload);
  const seconds = Number(input.event_timestamp);
  if (!Number.isFinite(seconds))
    throw new Error("Invalid ElevenLabs event timestamp.");
  const metadata = localMetadataSchema.parse(input.data.metadata ?? {});
  const transcript = (input.data.transcript ?? []).map((message, sequence) => ({
    sequence,
    role: message.role === "agent" ? "agent" : "user",
    content: String(message.message ?? message.content ?? ""),
    timestamp: new Date(seconds * 1000).toISOString(),
  }));
  const analysis = input.data.analysis ?? {};
  return {
    eventId: `${input.type}:${input.data.conversation_id}:${seconds}`,
    type: input.type,
    occurredAt: new Date(seconds * 1000),
    data: {
      providerConversationId: input.data.conversation_id,
      agentId: metadata.voxadesk_agent_id,
      agentVersionId: metadata.voxadesk_agent_version_id,
      channel: metadata.voxadesk_channel,
      status: input.data.status === "failed" ? "FAILED" : "COMPLETED",
      outcome:
        typeof analysis.outcome === "string" ? analysis.outcome : undefined,
      summary:
        typeof analysis.summary === "string" ? analysis.summary : undefined,
      durationSeconds:
        typeof input.data.duration_seconds === "number"
          ? input.data.duration_seconds
          : undefined,
      isTest:
        metadata.voxadesk_is_test === true ||
        metadata.voxadesk_is_test === "true",
      messages: transcript,
    },
  };
}

export function normalizeTwilioWebhook(
  payload: unknown,
): NormalizedProviderEvent {
  const input = twilioSchema.parse(payload);
  const occurredAt = new Date(input.Timestamp);
  if (Number.isNaN(occurredAt.getTime()))
    throw new Error("Invalid Twilio event timestamp.");
  return {
    eventId:
      input.EventSid ??
      `${input.CallSid}:${input.CallStatus}:${occurredAt.toISOString()}`,
    type: `call.${input.CallStatus.toLowerCase()}`,
    occurredAt,
    data: {
      providerConversationId: input.CallSid,
      status: input.CallStatus,
      to: input.To,
      from: input.From,
    },
  };
}

export function normalizeStripeWebhook(
  payload: unknown,
): NormalizedProviderEvent {
  const input = stripeSchema.parse(payload);
  const object = input.data.object;
  const metadata = z.record(z.string()).catch({}).parse(object.metadata);
  const periodEnd =
    typeof object.current_period_end === "number"
      ? new Date(object.current_period_end * 1000).toISOString()
      : undefined;
  return {
    eventId: input.id,
    type: input.type,
    occurredAt: new Date(input.created * 1000),
    data: {
      customerId: String(object.customer ?? ""),
      subscriptionId: String(object.id ?? ""),
      planCode: metadata.planCode ?? "starter",
      status: String(object.status ?? "incomplete"),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: object.cancel_at_period_end === true,
    },
  };
}
