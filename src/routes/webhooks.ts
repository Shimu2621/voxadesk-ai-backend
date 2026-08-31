import { Router, raw } from "express";
import { Prisma, type IntegrationType } from "@prisma/client";
import Stripe from "stripe";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  normalizeElevenLabsWebhook,
  normalizeStripeWebhook,
  normalizeTwilioWebhook,
  type NormalizedProviderEvent,
} from "../integrations/webhook-normalizers.js";
import { enqueueWebhook } from "../jobs/queues.js";
import { prisma } from "../lib/prisma.js";
import {
  verifyMockWebhook,
  isWithinWebhookTolerance,
  verifyTimestampedHmac,
  verifyTwilioSignature,
  webhookEnvelopeSchema,
} from "../security/webhooks.js";
import { incrementMetric } from "../lib/metrics.js";

export const webhooksRouter = Router();
const integrationQuerySchema = z.object({ integrationId: z.string().cuid() });

async function acceptEvent(input: {
  provider: "elevenlabs" | "twilio" | "stripe";
  integrationType: IntegrationType;
  integrationId: string;
  event: NormalizedProviderEvent;
}) {
  const integration = await prisma.integration.findFirst({
    where: {
      id: input.integrationId,
      type: input.integrationType,
      status: "connected",
    },
    select: { organizationId: true },
  });
  if (!integration)
    return {
      status: 404,
      body: {
        code: "INTEGRATION_NOT_FOUND",
        message: "The connected provider integration was not found.",
      },
    };
  try {
    const event = await prisma.webhookEvent.create({
      data: {
        provider: input.provider,
        providerEventId: input.event.eventId,
        organizationId: integration.organizationId,
        type: input.event.type,
        status: "accepted",
        providerOccurredAt: input.event.occurredAt,
        payloadSafeJson: input.event.data as Prisma.InputJsonObject,
        receivedAt: new Date(),
      },
    });
    await enqueueWebhook(event.id);
    incrementMetric("webhook_events_total", {
      provider: input.provider,
      result: "accepted",
      organizationId: integration.organizationId,
    });
    return { status: 202, body: { accepted: true, duplicate: false } };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const existing = await prisma.webhookEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: input.provider,
            providerEventId: input.event.eventId,
          },
        },
      });
      if (existing && existing.status !== "processed")
        await enqueueWebhook(existing.id);
      incrementMetric("webhook_events_total", {
        provider: input.provider,
        result: "duplicate",
        organizationId: existing?.organizationId ?? undefined,
      });
      return { status: 200, body: { accepted: true, duplicate: true } };
    }
    throw error;
  }
}

function getRawBody(req: import("express").Request) {
  if (!Buffer.isBuffer(req.body))
    throw new SyntaxError("A raw webhook body is required.");
  return req.body;
}

function providerWebhook(
  provider: "elevenlabs" | "twilio" | "stripe",
  integrationType: IntegrationType,
  limit: string,
) {
  return [
    raw({ type: "*/*", limit }),
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        if (env.PROVIDER_MODE === "disabled") {
          res.status(503).json({
            code: "PROVIDER_DISABLED",
            message: `${provider} webhooks are disabled.`,
            requestId: req.requestId,
          });
          return;
        }
        const body = getRawBody(req);
        let integrationId: string;
        let event: NormalizedProviderEvent;
        if (env.PROVIDER_MODE === "mock") {
          const verification = verifyMockWebhook({
            rawBody: body,
            timestampHeader: req.header("x-mock-timestamp"),
            signatureHeader: req.header("x-mock-signature"),
            secret: env.MOCK_WEBHOOK_SECRET!,
          });
          if (!verification.valid) {
            res.status(401).json({
              code: verification.code,
              message: "Webhook verification failed.",
              requestId: req.requestId,
            });
            return;
          }
          const envelope = webhookEnvelopeSchema.parse(
            JSON.parse(body.toString("utf8")),
          );
          integrationId = envelope.integrationId;
          event = {
            eventId: envelope.eventId,
            type: envelope.type,
            occurredAt: new Date(envelope.occurredAt),
            data: envelope.data,
          };
        } else {
          integrationId = integrationQuerySchema.parse(req.query).integrationId;
          if (provider === "elevenlabs") {
            const verification = verifyTimestampedHmac({
              rawBody: body,
              signatureHeader: req.header("elevenlabs-signature"),
              secret: env.ELEVENLABS_WEBHOOK_SECRET!,
            });
            if (!verification.valid) {
              res.status(401).json({
                code: verification.code,
                message: "Webhook verification failed.",
                requestId: req.requestId,
              });
              return;
            }
            event = normalizeElevenLabsWebhook(
              JSON.parse(body.toString("utf8")),
            );
          } else if (provider === "twilio") {
            const params = Object.fromEntries(
              new URLSearchParams(body.toString("utf8")),
            );
            const url = new URL(
              req.originalUrl,
              env.PUBLIC_WEBHOOK_BASE_URL,
            ).toString();
            if (
              !verifyTwilioSignature({
                url,
                params,
                signatureHeader: req.header("x-twilio-signature"),
                authToken: env.TWILIO_AUTH_TOKEN!,
              })
            ) {
              res.status(401).json({
                code: "SIGNATURE_INVALID",
                message: "Webhook verification failed.",
                requestId: req.requestId,
              });
              return;
            }
            event = normalizeTwilioWebhook(params);
            if (!isWithinWebhookTolerance(event.occurredAt)) {
              res.status(401).json({
                code: "REPLAYED",
                message: "Webhook verification failed.",
                requestId: req.requestId,
              });
              return;
            }
          } else {
            const stripe = new Stripe(env.STRIPE_SECRET_KEY!);
            const stripeEvent = stripe.webhooks.constructEvent(
              body,
              req.header("stripe-signature") ?? "",
              env.STRIPE_WEBHOOK_SECRET!,
              300,
            );
            event = normalizeStripeWebhook(stripeEvent);
          }
        }
        const result = await acceptEvent({
          provider,
          integrationType,
          integrationId,
          event,
        });
        res
          .status(result.status)
          .json({ ...result.body, requestId: req.requestId });
      } catch (error) {
        if (
          error instanceof SyntaxError ||
          error instanceof z.ZodError ||
          error instanceof Stripe.errors.StripeSignatureVerificationError
        ) {
          res.status(400).json({
            code: "INVALID_WEBHOOK",
            message: "The webhook body or signature is invalid.",
            requestId: req.requestId,
          });
          return;
        }
        throw error;
      }
    },
  ] as const;
}

webhooksRouter.post(
  "/elevenlabs",
  ...providerWebhook("elevenlabs", "ELEVENLABS", "1mb"),
);
webhooksRouter.post("/twilio", ...providerWebhook("twilio", "TWILIO", "256kb"));
webhooksRouter.post("/stripe", ...providerWebhook("stripe", "STRIPE", "1mb"));
