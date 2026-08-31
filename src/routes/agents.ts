import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import {
  providers,
  providersEnabled,
} from "../integrations/provider-factory.js";
import { checkEntitlement } from "../services/entitlements.js";

const voiceProvider = providers.voice;

const configSchema = z.object({
  name: z.string().trim().min(2).max(80),
  greeting: z.string().trim().min(5).max(500),
  voiceId: z.string().min(1),
  timezone: z.string().min(1),
  languages: z.array(z.string().min(2).max(20)).min(1).default(["en-US"]),
  tone: z.string().default("helpful"),
  role: z.string().min(2).max(200).default("AI receptionist"),
  pace: z.number().min(0.5).max(2).default(1),
  interruptible: z.boolean().default(true),
  pronunciation: z
    .array(
      z.object({
        phrase: z.string().min(1).max(100),
        pronunciation: z.string().min(1).max(200),
      }),
    )
    .max(100)
    .default([]),
  disclosure: z.string().default("You are speaking with an AI receptionist."),
  transferNumbers: z.array(z.string()).default([]),
  channels: z
    .object({
      phone: z.boolean().default(true),
      webVoice: z.boolean().default(true),
      webText: z.boolean().default(true),
    })
    .default({}),
  promptSections: z.object({
    objectives: z.string().min(1).max(4000),
    workflow: z.string().min(1).max(4000),
    safety: z.string().min(1).max(4000),
    prohibitedActions: z.string().min(1).max(4000),
  }),
  unknownFallback: z
    .string()
    .min(5)
    .max(500)
    .default("I cannot confirm that information. I can arrange a callback."),
});
const id = z.string().cuid();
export const agentsRouter = Router();
agentsRouter.use(requireAuth);
agentsRouter.get("/", async (req, res) =>
  res.json({
    data: await prisma.agent.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: { activeVersion: true },
      orderBy: { createdAt: "desc" },
    }),
  }),
);
agentsRouter.get("/:id", async (req, res) => {
  const agent = await prisma.agent.findFirst({
    where: {
      id: id.parse(req.params.id),
      organizationId: req.auth!.organizationId,
    },
    include: {
      versions: { orderBy: { version: "desc" } },
      activeVersion: true,
    },
  });
  if (!agent)
    return res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Agent not found." });
  res.json({ data: agent });
});
agentsRouter.post("/", requireRole("OWNER", "MANAGER"), async (req, res) => {
  const input = configSchema.parse(req.body);
  const agent = await prisma.agent.create({
    data: {
      organizationId: req.auth!.organizationId,
      name: input.name,
      draftConfig: input,
    },
  });
  await audit({
    organizationId: req.auth!.organizationId,
    actorId: req.auth!.userId,
    action: "agent.created",
    targetType: "agent",
    targetId: agent.id,
  });
  res.status(201).json({ data: agent });
});
agentsRouter.patch(
  "/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const input = configSchema.parse(req.body);
    const existing = await prisma.agent.findFirst({
      where: {
        id: id.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) return res.status(404).json({ code: "NOT_FOUND" });
    const agent = await prisma.agent.update({
      where: { id: existing.id },
      data: { name: input.name, draftConfig: input },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "agent.updated",
      targetType: "agent",
      targetId: agent.id,
    });
    res.json({ data: agent });
  },
);
agentsRouter.post(
  "/:id/publish",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.agent.findFirst({
      where: {
        id: id.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
    if (!existing) return res.status(404).json({ code: "NOT_FOUND" });
    const activeAgents = await prisma.agent.count({
      where: {
        organizationId: req.auth!.organizationId,
        status: "PUBLISHED",
        id: { not: existing.id },
      },
    });
    const entitlement = await checkEntitlement(
      req.auth!.organizationId,
      "activeAgents",
      activeAgents,
    );
    if (!entitlement.allowed) {
      res.status(403).json({
        code: "PLAN_LIMIT",
        message: `The ${entitlement.planCode} plan allows ${entitlement.limit} active agents.`,
        requestId: req.requestId,
      });
      return;
    }
    const validatedConfig = configSchema.parse(existing.draftConfig);
    if (!providersEnabled) {
      res.status(503).json({
        code: "PROVIDER_DISABLED",
        message:
          "Agent publishing is disabled until a voice provider is configured.",
      });
      return;
    }
    const nextVersion = (existing.versions[0]?.version ?? 0) + 1;
    const providerResult = await voiceProvider.publishAgent({
      agentId: existing.id,
      version: nextVersion,
      config: validatedConfig,
    });
    if (!providerResult.success) {
      res
        .status(503)
        .json({ code: providerResult.code, message: providerResult.message });
      return;
    }
    const publishedConfig = {
      ...validatedConfig,
      providerAgentId: providerResult.data.providerAgentId,
    };
    const version = await prisma.$transaction(async (tx) => {
      const created = await tx.agentVersion.create({
        data: {
          agentId: existing.id,
          version: nextVersion,
          config: publishedConfig,
          publishedById: req.auth!.userId,
        },
      });
      await tx.agent.update({
        where: { id: existing.id },
        data: { activeVersionId: created.id, status: "PUBLISHED" },
      });
      return created;
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "agent.published",
      targetType: "agent",
      targetId: existing.id,
      metadata: { version: version.version },
    });
    res.status(201).json({ data: version });
  },
);
agentsRouter.post(
  "/:id/duplicate",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.agent.findFirst({
      where: {
        id: id.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res.status(404).json({ code: "NOT_FOUND", message: "Agent not found." });
      return;
    }
    const created = await prisma.agent.create({
      data: {
        organizationId: req.auth!.organizationId,
        name: `${existing.name} copy`,
        draftConfig: existing.draftConfig as Prisma.InputJsonValue,
      },
    });
    res.status(201).json({ data: created });
  },
);
agentsRouter.post(
  "/:id/archive",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.agent.findFirst({
      where: {
        id: id.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res.status(404).json({ code: "NOT_FOUND", message: "Agent not found." });
      return;
    }
    const data = await prisma.agent.update({
      where: { id: existing.id },
      data: { status: "ARCHIVED", activeVersionId: null },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "agent.archived",
      targetType: "agent",
      targetId: data.id,
    });
    res.json({ data });
  },
);
agentsRouter.post(
  "/:id/signed-session",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const agent = await prisma.agent.findFirst({
      where: {
        id: id.parse(req.params.id),
        organizationId: req.auth!.organizationId,
        status: "PUBLISHED",
        activeVersionId: { not: null },
      },
      include: { activeVersion: true },
    });
    if (!agent?.activeVersion) {
      res.status(409).json({
        code: "AGENT_NOT_PUBLISHED",
        message: "Publish the agent before starting a test session.",
      });
      return;
    }
    if (!providersEnabled) {
      res.status(503).json({
        code: "PROVIDER_DISABLED",
        message:
          "Browser voice sessions are disabled until a provider is configured.",
      });
      return;
    }
    const providerSession = await voiceProvider.createSignedSession({
      agentId: agent.id,
      organizationId: req.auth!.organizationId,
    });
    if (!providerSession.success) {
      res
        .status(503)
        .json({ code: providerSession.code, message: providerSession.message });
      return;
    }
    const conversation = await prisma.conversation.create({
      data: {
        organizationId: req.auth!.organizationId,
        agentId: agent.id,
        agentVersionId: agent.activeVersion.id,
        provider:
          env.PROVIDER_MODE === "live" ? "elevenlabs" : "mock-elevenlabs",
        providerConversationId: randomUUID(),
        channel: "WEB_VOICE",
        isTest: true,
      },
    });
    res.status(201).json({
      data: {
        conversationId: conversation.id,
        token: providerSession.data.token,
        expiresAt: providerSession.data.expiresAt,
      },
    });
  },
);
agentsRouter.post(
  "/:id/rollback/:versionId",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const version = await prisma.agentVersion.findFirst({
      where: {
        id: id.parse(req.params.versionId),
        agent: {
          id: id.parse(req.params.id),
          organizationId: req.auth!.organizationId,
        },
      },
    });
    if (!version) return res.status(404).json({ code: "NOT_FOUND" });
    await prisma.agent.update({
      where: { id: version.agentId },
      data: { activeVersionId: version.id, status: "PUBLISHED" },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "agent.rolled_back",
      targetType: "agent",
      targetId: version.agentId,
      metadata: { version: version.version },
    });
    res.json({ data: version });
  },
);
