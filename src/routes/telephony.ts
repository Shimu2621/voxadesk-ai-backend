import { randomUUID } from "node:crypto";
import { Router, raw } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { MockTelephonyProvider } from "../integrations/providers.js";
import { prisma } from "../lib/prisma.js";
import { verifyMockWebhook } from "../security/webhooks.js";

const telephonyProvider = new MockTelephonyProvider();
const inboundSchema = z.object({
  eventId: z.string().min(1),
  occurredAt: z.string().datetime(),
  data: z.object({
    to: z.string().regex(/^\+[1-9]\d{7,14}$/),
    callId: z.string().min(1).max(200),
  }),
});
export const telephonyRouter = Router();
telephonyRouter.post(
  "/inbound",
  raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    if (env.PROVIDER_MODE !== "mock" || !env.MOCK_WEBHOOK_SECRET) {
      res.status(503).json({
        code: "PROVIDER_DISABLED",
        message: "Inbound telephony is disabled.",
      });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(400).json({
        code: "INVALID_BODY",
        message: "A raw request body is required.",
      });
      return;
    }
    const verified = verifyMockWebhook({
      rawBody: req.body,
      timestampHeader: req.header("x-mock-timestamp"),
      signatureHeader: req.header("x-mock-signature"),
      secret: env.MOCK_WEBHOOK_SECRET,
    });
    if (!verified.valid) {
      res.status(401).json({
        code: verified.code,
        message: "Inbound request verification failed.",
      });
      return;
    }
    let input: z.infer<typeof inboundSchema>;
    try {
      input = inboundSchema.parse(JSON.parse(req.body.toString("utf8")));
    } catch {
      res.status(400).json({
        code: "INVALID_INBOUND_CALL",
        message: "The inbound call payload is invalid.",
      });
      return;
    }
    const assigned = await prisma.phoneNumber.findUnique({
      where: { e164: input.data.to },
      include: { agent: { include: { activeVersion: true } } },
    });
    if (
      !assigned ||
      assigned.status !== "active" ||
      !assigned.agent.activeVersion ||
      assigned.agent.status !== "PUBLISHED"
    ) {
      res.status(404).json({
        code: "ROUTE_NOT_FOUND",
        message: "No active published agent is assigned to this number.",
      });
      return;
    }
    const routed = await telephonyProvider.routeInbound({
      phoneNumber: assigned.e164,
      providerCallId: input.data.callId,
    });
    if (!routed.success) {
      res.status(503).json({ code: routed.code, message: routed.message });
      return;
    }
    const conversation = await prisma.conversation.upsert({
      where: {
        provider_providerConversationId: {
          provider: "mock-twilio",
          providerConversationId: routed.data.providerConversationId,
        },
      },
      create: {
        organizationId: assigned.organizationId,
        agentId: assigned.agentId,
        agentVersionId: assigned.agent.activeVersion.id,
        provider: "mock-twilio",
        providerConversationId: routed.data.providerConversationId,
        channel: "PHONE",
      },
      update: {},
    });
    res.json({
      data: {
        conversationId: conversation.id,
        routeId: randomUUID(),
        providerConversationId: routed.data.providerConversationId,
      },
    });
  },
);
