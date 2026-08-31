import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { audit } from "../lib/audit.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { checkEntitlement } from "../services/entitlements.js";
import {
  rotateIntegrationCredential,
  storeIntegrationCredential,
} from "../services/integration-credentials.js";

const typeSchema = z.enum([
  "ELEVENLABS",
  "TWILIO",
  "GOOGLE_CALENDAR",
  "STRIPE",
]);
const mockConfigSchema = z.object({
  calendarId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(100).optional(),
});
const liveConfigured = (type: z.infer<typeof typeSchema>) =>
  ({
    ELEVENLABS: Boolean(env.ELEVENLABS_API_KEY),
    TWILIO: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
    GOOGLE_CALENDAR: Boolean(
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.GOOGLE_REFRESH_TOKEN,
    ),
    STRIPE: Boolean(env.STRIPE_SECRET_KEY),
  })[type];
const phoneSchema = z.object({
  e164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  providerNumberId: z.string().min(1).max(200),
  locationId: z.string().cuid(),
  agentId: z.string().cuid(),
});
export const integrationsRouter = Router();
integrationsRouter.use(requireAuth);
integrationsRouter.get("/", async (req, res) =>
  res.json({
    data: await prisma.integration.findMany({
      where: { organizationId: req.auth!.organizationId },
      select: {
        id: true,
        type: true,
        status: true,
        configJson: true,
        lastCheckedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  }),
);
integrationsRouter.post(
  "/mock/:type",
  requireRole("OWNER"),
  async (req, res) => {
    const type = typeSchema.parse(req.params.type);
    const config = mockConfigSchema.parse(req.body);
    if (env.PROVIDER_MODE !== "mock") {
      res.status(403).json({
        code: "MOCK_MODE_DISABLED",
        message: "Mock integrations require PROVIDER_MODE=mock.",
      });
      return;
    }
    const data = await prisma.integration.upsert({
      where: {
        organizationId_type: { organizationId: req.auth!.organizationId, type },
      },
      create: {
        organizationId: req.auth!.organizationId,
        type,
        status: "connected",
        configJson: config,
        lastCheckedAt: new Date(),
      },
      update: {
        status: "connected",
        configJson: config,
        lastCheckedAt: new Date(),
        encryptedCredentialRef: null,
      },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "integration.mock_connected",
      targetType: "integration",
      targetId: data.id,
      metadata: { type },
    });
    await prisma.providerHealth.create({
      data: {
        organizationId: req.auth!.organizationId,
        provider: type,
        status: "healthy",
        latencyMs: 0,
      },
    });
    res.status(201).json({ data });
  },
);
integrationsRouter.post(
  "/live/:type",
  requireRole("OWNER"),
  async (req, res) => {
    const type = typeSchema.parse(req.params.type);
    const config = mockConfigSchema.parse(req.body);
    if (env.PROVIDER_MODE !== "live" || !liveConfigured(type)) {
      res.status(503).json({
        code: "PROVIDER_NOT_CONFIGURED",
        message: `${type} live credentials are not configured.`,
      });
      return;
    }
    const safeConfig =
      type === "GOOGLE_CALENDAR"
        ? {
            calendarId: config.calendarId ?? env.GOOGLE_CALENDAR_ID,
            label: config.label ?? "Google Calendar",
          }
        : { label: config.label ?? type };
    const data = await prisma.integration.upsert({
      where: {
        organizationId_type: { organizationId: req.auth!.organizationId, type },
      },
      create: {
        organizationId: req.auth!.organizationId,
        type,
        status: "connected",
        configJson: safeConfig,
        lastCheckedAt: new Date(),
        encryptedCredentialRef: "environment",
      },
      update: {
        status: "connected",
        configJson: safeConfig,
        lastCheckedAt: new Date(),
        encryptedCredentialRef: "environment",
      },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "integration.live_connected",
      targetType: "integration",
      targetId: data.id,
      metadata: { type },
    });
    await prisma.providerHealth.create({
      data: {
        organizationId: req.auth!.organizationId,
        provider: type,
        status: "configured",
      },
    });
    res.status(201).json({
      data: {
        id: data.id,
        type: data.type,
        status: data.status,
        configJson: data.configJson,
      },
    });
  },
);
integrationsRouter.delete("/:type", requireRole("OWNER"), async (req, res) => {
  const type = typeSchema.parse(req.params.type);
  const integration = await prisma.integration.findUnique({
    where: {
      organizationId_type: { organizationId: req.auth!.organizationId, type },
    },
  });
  if (!integration) {
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Integration not found." });
    return;
  }
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "disconnected", encryptedCredentialRef: null },
  });
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "integration.disconnected",
    targetType: "integration",
    targetId: integration.id,
    metadata: { type },
  });
  await prisma.providerHealth.create({
    data: {
      organizationId: req.auth!.organizationId,
      provider: type,
      status: "disconnected",
    },
  });
  res.status(204).end();
});
integrationsRouter.post(
  "/:type/credentials",
  requireRole("OWNER"),
  async (req, res) => {
    const type = typeSchema.parse(req.params.type);
    const credential = z
      .record(z.string().min(1).max(10_000))
      .refine((value) => Object.keys(value).length > 0)
      .parse(req.body);
    const integration = await prisma.integration.findUnique({
      where: {
        organizationId_type: {
          organizationId: req.auth!.organizationId,
          type,
        },
      },
    });
    if (!integration) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Integration not found." });
      return;
    }
    try {
      const data = await storeIntegrationCredential({
        organizationId: req.auth!.organizationId,
        integrationId: integration.id,
        credential,
      });
      res.status(201).json({ data });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CREDENTIAL_ENCRYPTION_NOT_CONFIGURED"
      ) {
        res.status(503).json({
          code: error.message,
          message: "Credential encryption is not configured.",
        });
        return;
      }
      throw error;
    }
  },
);
integrationsRouter.post(
  "/:type/credentials/rotate",
  requireRole("OWNER"),
  async (req, res) => {
    const type = typeSchema.parse(req.params.type);
    const integration = await prisma.integration.findUnique({
      where: {
        organizationId_type: {
          organizationId: req.auth!.organizationId,
          type,
        },
      },
    });
    if (!integration) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Integration not found." });
      return;
    }
    const data = await rotateIntegrationCredential(
      req.auth!.organizationId,
      integration.id,
    );
    res.status(201).json({ data });
  },
);
integrationsRouter.get("/phone-numbers", async (req, res) =>
  res.json({
    data: await prisma.phoneNumber.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: {
        agent: { select: { id: true, name: true, status: true } },
        location: { select: { id: true, name: true } },
      },
    }),
  }),
);
integrationsRouter.post(
  "/phone-numbers",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const input = phoneSchema.parse(req.body);
    const organizationId = req.auth!.organizationId;
    const [location, agent, integration, count] = await Promise.all([
      prisma.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
      prisma.agent.findFirst({
        where: {
          id: input.agentId,
          organizationId,
          status: "PUBLISHED",
          activeVersionId: { not: null },
        },
      }),
      prisma.integration.findUnique({
        where: { organizationId_type: { organizationId, type: "TWILIO" } },
      }),
      prisma.phoneNumber.count({ where: { organizationId, status: "active" } }),
    ]);
    if (!location || !agent) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Published agent or location not found.",
      });
      return;
    }
    if (
      env.PROVIDER_MODE === "disabled" ||
      integration?.status !== "connected"
    ) {
      res.status(503).json({
        code: "TWILIO_NOT_CONNECTED",
        message: "Connect Twilio before assigning a phone number.",
      });
      return;
    }
    const entitlement = await checkEntitlement(
      organizationId,
      "phoneNumbers",
      count,
    );
    if (!entitlement.allowed) {
      res.status(403).json({
        code: "PLAN_LIMIT",
        message: `The ${entitlement.planCode} plan allows ${entitlement.limit} phone numbers.`,
      });
      return;
    }
    const data = await prisma.phoneNumber.create({
      data: { organizationId, ...input },
    });
    res.status(201).json({ data });
  },
);
