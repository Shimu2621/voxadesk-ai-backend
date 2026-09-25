import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import Stripe from "stripe";

vi.mock("../src/config/env.js", () => ({
  env: {
    NODE_ENV: "test",
    PROVIDER_MODE: "live",
    FRONTEND_URL: "http://localhost:3000",
    STRIPE_SECRET_KEY: "sk_test_fixture_only",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture_only",
  },
}));
vi.mock("../src/integrations/provider-factory.js", () => ({
  providers: {},
  providersEnabled: true,
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    integration: { findFirst: vi.fn() },
    webhookEvent: { create: vi.fn() },
    session: { findFirst: vi.fn() },
  },
}));
vi.mock("../src/lib/redis.js", () => ({
  redis: { incr: vi.fn().mockResolvedValue(1), expire: vi.fn() },
}));
vi.mock("../src/jobs/queues.js", () => ({
  queues: {},
  queueNames: [],
  enqueue: vi.fn(),
  enqueueWebhook: vi.fn(),
  enqueueKnowledge: vi.fn(),
  enqueueOutboundWebhook: vi.fn(),
  enqueueNotification: vi.fn(),
}));

import { app } from "../src/app.js";
import { env } from "../src/config/env.js";
import { prisma } from "../src/lib/prisma.js";
import { logger } from "../src/lib/logger.js";
import { enqueueWebhook } from "../src/jobs/queues.js";

const stripe = new Stripe("sk_test_fixture_only");
const integrationId = "cm12345678901234567890123";
// Whitespace is intentional: JSON parsing and reserialization must fail verification.
const payload = JSON.stringify(
  {
    id: "evt_fixture",
    type: "checkout.session.completed",
    created: 1800000000,
    data: { object: { id: "cs_fixture", customer: "cus_fixture" } },
  },
  null,
  2,
);
const signature = (
  body = payload,
  secret = "whsec_fixture_only",
  timestamp = Math.floor(Date.now() / 1000),
) =>
  stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret,
    timestamp,
  });
const send = (
  header: string,
  body = payload,
  path = "/api/v1/webhooks/stripe",
) =>
  request(app)
    .post(`${path}?integrationId=${integrationId}`)
    .set("Content-Type", "application/json")
    .set("stripe-signature", header)
    .send(body);

describe("Stripe webhook routing and verification", () => {
  it.each(["elevenlabs", "twilio"])(
    "rejects unconfigured %s webhooks clearly",
    async (provider) => {
      const response = await request(app)
        .post(`/api/v1/webhooks/${provider}`)
        .send({});
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("PROVIDER_NOT_CONFIGURED");
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    },
  );
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    env.STRIPE_WEBHOOK_SECRET = "whsec_fixture_only";
    vi.mocked(prisma.integration.findFirst).mockResolvedValue({
      organizationId: "org_fixture",
    } as never);
    vi.mocked(prisma.webhookEvent.create).mockResolvedValue({
      id: "webhook_fixture",
    } as never);
  });

  it.each(["/api/v1/webhooks/stripe", "/webhooks/stripe"])(
    "accepts CLI-format signatures on %s without session or CSRF",
    async (path) => {
      const response = await send(signature(), payload, path);
      expect(response.status).toBe(202);
      expect(response.body.accepted).toBe(true);
      expect(enqueueWebhook).toHaveBeenCalledWith("webhook_fixture");
      expect(prisma.session.findFirst).not.toHaveBeenCalled();
    },
  );

  it.each(["wrong-secret", "changed-body", "expired", "missing"])(
    "rejects %s signatures without storing events",
    async (reason) => {
      const header =
        reason === "missing"
          ? ""
          : reason === "wrong-secret"
            ? signature(payload, "whsec_wrong_fixture")
            : reason === "expired"
              ? signature(
                  payload,
                  "whsec_fixture_only",
                  Math.floor(Date.now() / 1000) - 600,
                )
              : signature();
      const response = await send(
        header,
        reason === "changed-body" ? `${payload} ` : payload,
      );
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("INVALID_WEBHOOK");
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { provider: "stripe", category: "signature_invalid" },
        "Webhook rejected",
      );
    },
  );

  it("keeps CSRF protection on application routes", async () => {
    const response = await request(app)
      .post("/api/v1/billing/checkout")
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.code).toBe("CSRF_INVALID");
  });

  it("fails closed when the webhook signing secret is missing", async () => {
    env.STRIPE_WEBHOOK_SECRET = undefined;
    const response = await send(signature());
    expect(response.status).toBe(503);
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("requires an explicit integration after verifying the signature", async () => {
    const response = await request(app)
      .post("/api/v1/webhooks/stripe")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature())
      .send(payload);
    expect(response.status).toBe(400);
    expect(logger.warn).toHaveBeenCalledWith(
      { provider: "stripe", category: "webhook_validation_failed" },
      "Webhook rejected",
    );
  });
});
