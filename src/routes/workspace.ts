import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  businessStatus,
  closureSchema,
  weeklyHoursSchema,
} from "../domain/business-hours.js";
import { createHash, randomBytes } from "node:crypto";
import { MockStorageProvider } from "../integrations/providers.js";
import { safePublicUrlSchema } from "../security/url-policy.js";
import { maskEmail, maskPhone, maskTranscript } from "../security/pii.js";
import { checkEntitlement } from "../services/entitlements.js";
import { emailProvider } from "../integrations/email.js";
import { hashToken } from "../middleware/auth.js";
import { enqueueKnowledge } from "../jobs/queues.js";
import { FakeKnowledgeIngestionProvider } from "../integrations/knowledge-ingestion.js";

const storageProvider = new MockStorageProvider();
const knowledgeIngestionProvider = new FakeKnowledgeIngestionProvider();
const checksum = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const knowledgeInput = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("TEXT"),
    name: z.string().min(2).max(120),
    content: z.string().min(1).max(100_000),
  }),
  z.object({
    type: z.literal("URL"),
    name: z.string().min(2).max(120),
    sourceUrl: safePublicUrlSchema,
  }),
  z.object({
    type: z.enum(["PDF", "DOCX", "TXT"]),
    name: z.string().min(2).max(120),
    mimeType: z.enum([
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ]),
    contentBase64: z.string().min(1),
  }),
]);

const timezone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone");
const organizationProfile = z.object({
  name: z.string().min(2).max(100),
  legalName: z.string().max(150).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  locale: z.string().min(2).max(20).default("en-US"),
  timezone,
  contactEmail: z.string().email().nullable().optional(),
  website: z.string().url().nullable().optional(),
  serviceAreaJson: z
    .object({
      description: z.string().max(500),
      postalCodes: z.array(z.string().max(20)).max(200).default([]),
    })
    .nullable()
    .optional(),
  fallbackContactJson: z
    .object({
      name: z.string().min(1).max(100),
      phone: z.string().min(7).max(30),
      email: z.string().email().optional(),
    })
    .nullable()
    .optional(),
  onboardingStep: z.number().int().min(1).max(6).optional(),
  onboardingCompleted: z.boolean().optional(),
});
const locationSchema = z.object({
  name: z.string().min(2).max(100),
  timezone,
  phone: z.string().min(7).max(30).nullable().optional(),
  addressJson: z
    .object({
      line1: z.string().min(1).max(150),
      line2: z.string().max(150).optional(),
      city: z.string().min(1).max(100),
      region: z.string().min(1).max(100),
      postalCode: z.string().min(1).max(20),
      country: z.string().length(2),
    })
    .nullable()
    .optional(),
  hoursJson: weeklyHoursSchema,
  closuresJson: z.array(closureSchema).max(100).default([]),
});
const nullableJson = (value: Prisma.InputJsonValue | null | undefined) =>
  value === null ? Prisma.JsonNull : value;
const locationData = (input: z.infer<typeof locationSchema>) => ({
  name: input.name,
  timezone: input.timezone,
  phone: input.phone,
  addressJson: nullableJson(input.addressJson),
  hoursJson: input.hoursJson,
  closuresJson: input.closuresJson,
});

const cuid = z.string().cuid();
const service = z.object({
  name: z.string().min(2).max(100),
  description: z.string().max(1000).optional(),
  durationMinutes: z.number().int().min(5).max(480).default(60),
  bufferMinutes: z.number().int().min(0).max(240).default(0),
  priceLabel: z.string().max(80).optional(),
  bookingRulesJson: z
    .object({
      horizonDays: z.number().int().min(1).max(365).default(60),
      minimumNoticeHours: z.number().int().min(0).max(720).default(2),
    })
    .optional(),
  active: z.boolean().default(true),
});
const faq = z.object({
  question: z.string().min(3).max(500),
  answer: z.string().min(2).max(4000),
  active: z.boolean().default(true),
});
const taskUpdate = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED"]).optional(),
  priority: z.string().max(30).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  assignedToId: cuid.nullable().optional(),
});
const conversationQuery = z.object({
  cursor: cuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(["STARTED", "IN_PROGRESS", "COMPLETED", "FAILED"]).optional(),
  channel: z.enum(["PHONE", "WEB_VOICE", "WEB_TEXT"]).optional(),
  outcome: z.string().max(50).optional(),
  includeTests: z.coerce.boolean().default(false),
});
const noteInput = z.object({ body: z.string().trim().min(1).max(4000) });
const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(["MANAGER", "OPERATOR", "VIEWER"]),
});
export const workspaceRouter = Router();
workspaceRouter.use(requireAuth);
workspaceRouter.get("/organization", async (req, res) =>
  res.json({
    data: await prisma.organization.findUnique({
      where: { id: req.auth!.organizationId },
      include: {
        locations: true,
        memberships: {
          include: { user: { select: { id: true, email: true, name: true } } },
        },
      },
    }),
  }),
);
workspaceRouter.get("/team", requireRole("OWNER"), async (req, res) => {
  const organizationId = req.auth!.organizationId;
  const [members, invitations] = await Promise.all([
    prisma.membership.findMany({
      where: { organizationId },
      include: {
        user: {
          select: { id: true, email: true, name: true, verifiedAt: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.invitation.findMany({
      where: {
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  res.json({ data: { members, invitations } });
});
workspaceRouter.post("/invitations", requireRole("OWNER"), async (req, res) => {
  const input = inviteInput.parse(req.body);
  const organizationId = req.auth!.organizationId;
  const existingUser = await prisma.user.findUnique({
    where: { email: input.email },
    include: { memberships: { where: { organizationId } } },
  });
  if (existingUser?.memberships.length) {
    res.status(409).json({
      code: "ALREADY_MEMBER",
      message: "This user already belongs to the organization.",
    });
    return;
  }
  const memberCount = await prisma.membership.count({
    where: { organizationId },
  });
  const entitlement = await checkEntitlement(
    organizationId,
    "seats",
    memberCount,
  );
  if (!entitlement.allowed) {
    res.status(403).json({
      code: "PLAN_LIMIT",
      message: `The ${entitlement.planCode} plan allows ${entitlement.limit} seats.`,
    });
    return;
  }
  await prisma.invitation.updateMany({
    where: {
      organizationId,
      email: input.email,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });
  const token = randomBytes(32).toString("base64url");
  const invitation = await prisma.invitation.create({
    data: {
      organizationId,
      email: input.email,
      role: input.role,
      tokenHash: hashToken(token),
      invitedById: req.auth!.userId,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
  await emailProvider.send({
    to: input.email,
    subject: "You are invited to VoxaDesk AI",
    text: `Use this single-use invitation token: ${token}`,
  });
  await audit({
    organizationId,
    actorId: req.auth!.userId,
    action: "invitation.created",
    targetType: "invitation",
    targetId: invitation.id,
    metadata: { role: input.role },
  });
  res.status(201).json({
    data: {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    },
  });
});
workspaceRouter.delete(
  "/invitations/:id",
  requireRole("OWNER"),
  async (req, res) => {
    const invitation = await prisma.invitation.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
        acceptedAt: null,
      },
    });
    if (!invitation) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Invitation not found." });
      return;
    }
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: invitation.id,
    });
    res.status(204).end();
  },
);
workspaceRouter.patch(
  "/members/:id",
  requireRole("OWNER"),
  async (req, res) => {
    const { role } = z
      .object({ role: z.enum(["OWNER", "MANAGER", "OPERATOR", "VIEWER"]) })
      .parse(req.body);
    const membership = await prisma.membership.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!membership) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Membership not found." });
      return;
    }
    if (membership.role === "OWNER" && role !== "OWNER") {
      const ownerCount = await prisma.membership.count({
        where: { organizationId: req.auth!.organizationId, role: "OWNER" },
      });
      if (ownerCount <= 1) {
        res.status(409).json({
          code: "LAST_OWNER",
          message: "The last owner cannot be demoted.",
        });
        return;
      }
    }
    const data = await prisma.membership.update({
      where: { id: membership.id },
      data: { role },
    });
    await prisma.session.deleteMany({
      where: {
        userId: membership.userId,
        organizationId: req.auth!.organizationId,
      },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "membership.role_changed",
      targetType: "membership",
      targetId: membership.id,
      metadata: { from: membership.role, to: role },
    });
    res.json({ data });
  },
);
workspaceRouter.patch(
  "/organization",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const input = organizationProfile.parse(req.body);
    const { onboardingCompleted, ...profile } = input;
    const data = await prisma.organization.update({
      where: { id: req.auth!.organizationId },
      data: {
        name: profile.name,
        legalName: profile.legalName,
        category: profile.category,
        locale: profile.locale,
        timezone: profile.timezone,
        contactEmail: profile.contactEmail,
        website: profile.website,
        serviceAreaJson: nullableJson(profile.serviceAreaJson),
        fallbackContactJson: nullableJson(profile.fallbackContactJson),
        onboardingStep: profile.onboardingStep,
        onboardingCompletedAt: onboardingCompleted
          ? new Date()
          : onboardingCompleted === false
            ? null
            : undefined,
      },
    });
    await audit({
      organizationId: req.auth!.organizationId,
      actorId: req.auth!.userId,
      action: "organization.updated",
      targetType: "organization",
      targetId: data.id,
    });
    res.json({ data });
  },
);
workspaceRouter.post(
  "/locations",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const input = locationSchema.parse(req.body);
    const count = await prisma.location.count({
      where: { organizationId: req.auth!.organizationId },
    });
    const entitlement = await checkEntitlement(
      req.auth!.organizationId,
      "locations",
      count,
    );
    if (!entitlement.allowed) {
      res.status(403).json({
        code: "PLAN_LIMIT",
        message: `The ${entitlement.planCode} plan allows ${entitlement.limit} locations.`,
        requestId: req.requestId,
      });
      return;
    }
    const data = await prisma.location.create({
      data: {
        ...locationData(input),
        organizationId: req.auth!.organizationId,
      },
    });
    res.status(201).json({ data });
  },
);
workspaceRouter.patch(
  "/locations/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.location.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Location not found." });
      return;
    }
    const data = await prisma.location.update({
      where: { id: existing.id },
      data: locationData(locationSchema.parse(req.body)),
    });
    res.json({ data });
  },
);
workspaceRouter.get("/locations/:id/business-status", async (req, res) => {
  const at = z.coerce
    .date()
    .default(() => new Date())
    .parse(req.query.at);
  const location = await prisma.location.findFirst({
    where: {
      id: cuid.parse(req.params.id),
      organizationId: req.auth!.organizationId,
    },
  });
  if (!location) {
    res.status(404).json({ code: "NOT_FOUND", message: "Location not found." });
    return;
  }
  const weeklyHours = weeklyHoursSchema.parse(location.hoursJson ?? {});
  const closures = z.array(closureSchema).parse(location.closuresJson ?? []);
  res.json({
    data: businessStatus({
      at,
      timezone: location.timezone,
      weeklyHours,
      closures,
    }),
  });
});
workspaceRouter.get("/services", async (req, res) =>
  res.json({
    data: await prisma.service.findMany({
      where: { organizationId: req.auth!.organizationId },
      orderBy: { createdAt: "desc" },
    }),
  }),
);
workspaceRouter.post(
  "/services",
  requireRole("OWNER", "MANAGER"),
  async (req, res) =>
    res.status(201).json({
      data: await prisma.service.create({
        data: {
          ...service.parse(req.body),
          organizationId: req.auth!.organizationId,
        },
      }),
    }),
);
workspaceRouter.patch(
  "/services/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.service.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Service not found." });
      return;
    }
    res.json({
      data: await prisma.service.update({
        where: { id: existing.id },
        data: service.parse(req.body),
      }),
    });
  },
);
workspaceRouter.delete(
  "/services/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.service.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Service not found." });
      return;
    }
    await prisma.service.update({
      where: { id: existing.id },
      data: { active: false },
    });
    res.status(204).end();
  },
);
workspaceRouter.get("/faqs", async (req, res) =>
  res.json({
    data: await prisma.faq.findMany({
      where: { organizationId: req.auth!.organizationId },
      orderBy: { createdAt: "desc" },
    }),
  }),
);
workspaceRouter.post(
  "/faqs",
  requireRole("OWNER", "MANAGER"),
  async (req, res) =>
    res.status(201).json({
      data: await prisma.faq.create({
        data: {
          ...faq.parse(req.body),
          organizationId: req.auth!.organizationId,
        },
      }),
    }),
);
workspaceRouter.patch(
  "/faqs/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.faq.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res.status(404).json({ code: "NOT_FOUND", message: "FAQ not found." });
      return;
    }
    res.json({
      data: await prisma.faq.update({
        where: { id: existing.id },
        data: faq.parse(req.body),
      }),
    });
  },
);
workspaceRouter.delete(
  "/faqs/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const existing = await prisma.faq.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res.status(404).json({ code: "NOT_FOUND", message: "FAQ not found." });
      return;
    }
    await prisma.faq.update({
      where: { id: existing.id },
      data: { active: false },
    });
    res.status(204).end();
  },
);
workspaceRouter.get("/knowledge", async (req, res) =>
  res.json({
    data: await prisma.knowledgeSource.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: { attachments: true },
      orderBy: { createdAt: "desc" },
    }),
  }),
);
workspaceRouter.post(
  "/knowledge",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const input = knowledgeInput.parse(req.body);
    const organizationId = req.auth!.organizationId;
    if (input.type === "TEXT") {
      const bytes = Buffer.from(input.content, "utf8");
      const usage = await prisma.knowledgeSource.aggregate({
        where: { organizationId, archivedAt: null },
        _sum: { sizeBytes: true },
      });
      const entitlement = await checkEntitlement(
        organizationId,
        "knowledgeBytes",
        usage._sum.sizeBytes ?? 0,
        bytes.byteLength,
      );
      if (!entitlement.allowed) {
        res.status(403).json({
          code: "PLAN_LIMIT",
          message: `The ${entitlement.planCode} knowledge limit has been reached.`,
          requestId: req.requestId,
        });
        return;
      }
      const data = await prisma.knowledgeSource.create({
        data: {
          organizationId,
          ownerId: req.auth!.userId,
          name: input.name,
          type: input.type,
          contentText: input.content,
          checksum: checksum(bytes),
          sizeBytes: bytes.byteLength,
          mimeType: "text/plain",
          status: "queued",
        },
      });
      await enqueueKnowledge(organizationId, data.id);
      res.status(202).json({ data });
      return;
    }
    if (input.type === "URL") {
      const data = await prisma.knowledgeSource.create({
        data: {
          organizationId,
          ownerId: req.auth!.userId,
          name: input.name,
          type: input.type,
          sourceUrl: input.sourceUrl,
          checksum: checksum(Buffer.from(input.sourceUrl)),
          status: "queued",
        },
      });
      await enqueueKnowledge(organizationId, data.id);
      res.status(202).json({ data });
      return;
    }
    const bytes = Buffer.from(input.contentBase64, "base64");
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024) {
      res.status(413).json({
        code: "FILE_SIZE_INVALID",
        message: "Knowledge files must be between 1 byte and 5 MB.",
        requestId: req.requestId,
      });
      return;
    }
    const expectedMime = {
      PDF: "application/pdf",
      DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      TXT: "text/plain",
    }[input.type];
    if (input.mimeType !== expectedMime) {
      res.status(400).json({
        code: "FILE_TYPE_INVALID",
        message: "The file type and MIME type do not match.",
        requestId: req.requestId,
      });
      return;
    }
    const usage = await prisma.knowledgeSource.aggregate({
      where: { organizationId, archivedAt: null },
      _sum: { sizeBytes: true },
    });
    const entitlement = await checkEntitlement(
      organizationId,
      "knowledgeBytes",
      usage._sum.sizeBytes ?? 0,
      bytes.byteLength,
    );
    if (!entitlement.allowed) {
      res.status(403).json({
        code: "PLAN_LIMIT",
        message: `The ${entitlement.planCode} knowledge limit has been reached.`,
        requestId: req.requestId,
      });
      return;
    }
    const stored = await storageProvider.put({
      organizationId,
      key: `${checksum(bytes)}-${input.name}`,
      contentType: input.mimeType,
      bytes,
    });
    if (!stored.success) {
      res.status(503).json({ code: stored.code, message: stored.message });
      return;
    }
    const data = await prisma.knowledgeSource.create({
      data: {
        organizationId,
        ownerId: req.auth!.userId,
        name: input.name,
        type: input.type,
        storageKey: stored.data.storageKey,
        contentText: input.type === "TXT" ? bytes.toString("utf8") : undefined,
        checksum: checksum(bytes),
        sizeBytes: bytes.byteLength,
        mimeType: input.mimeType,
        status: "queued",
      },
    });
    await enqueueKnowledge(organizationId, data.id);
    res.status(202).json({ data });
  },
);
workspaceRouter.post(
  "/knowledge/:id/sync",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const source = await prisma.knowledgeSource.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
        archivedAt: null,
      },
    });
    if (!source) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Knowledge source not found." });
      return;
    }
    const data = await prisma.knowledgeSource.update({
      where: { id: source.id },
      data: { status: "queued", error: null },
    });
    await enqueueKnowledge(req.auth!.organizationId, data.id);
    res.status(202).json({ data });
  },
);
workspaceRouter.post(
  "/knowledge/:id/archive",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const source = await prisma.knowledgeSource.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!source) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Knowledge source not found." });
      return;
    }
    const data = await prisma.$transaction(async (tx) => {
      await tx.agentKnowledgeAttachment.deleteMany({
        where: {
          organizationId: req.auth!.organizationId,
          knowledgeSourceId: source.id,
        },
      });
      await tx.knowledgeDocument.updateMany({
        where: {
          organizationId: req.auth!.organizationId,
          knowledgeSourceId: source.id,
          deletedAt: null,
        },
        data: { status: "archived", deletedAt: new Date() },
      });
      return tx.knowledgeSource.update({
        where: { id: source.id },
        data: { status: "archived", archivedAt: new Date(), contentText: null },
      });
    });
    res.json({ data });
  },
);
workspaceRouter.delete(
  "/knowledge/:id",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const source = await prisma.knowledgeSource.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!source) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Knowledge source not found." });
      return;
    }
    const removed = await knowledgeIngestionProvider.remove({
      storageKey: source.storageKey,
    });
    if (!removed.success) {
      res.status(503).json({ code: removed.code, message: removed.message });
      return;
    }
    await prisma.knowledgeSource.delete({ where: { id: source.id } });
    res.status(204).end();
  },
);
workspaceRouter.post(
  "/knowledge/:id/attach",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const { agentId } = z.object({ agentId: cuid }).parse(req.body);
    const organizationId = req.auth!.organizationId;
    const [source, agent] = await Promise.all([
      prisma.knowledgeSource.findFirst({
        where: {
          id: cuid.parse(req.params.id),
          organizationId,
          status: "ready",
        },
      }),
      prisma.agent.findFirst({ where: { id: agentId, organizationId } }),
    ]);
    if (!source || !agent) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Knowledge source or agent not found.",
      });
      return;
    }
    const data = await prisma.agentKnowledgeAttachment.upsert({
      where: {
        agentId_knowledgeSourceId: {
          agentId: agent.id,
          knowledgeSourceId: source.id,
        },
      },
      create: {
        organizationId,
        agentId: agent.id,
        knowledgeSourceId: source.id,
      },
      update: {},
    });
    res.status(201).json({ data });
  },
);
workspaceRouter.get("/conversations", async (req, res) => {
  const query = conversationQuery.parse(req.query);
  const where: Prisma.ConversationWhereInput = {
    organizationId: req.auth!.organizationId,
    status: query.status,
    channel: query.channel,
    outcome: query.outcome,
    ...(query.includeTests ? {} : { isTest: false }),
  };
  const records = await prisma.conversation.findMany({
    where,
    include: {
      agent: { select: { name: true } },
      contact: true,
      toolExecutions: {
        select: { id: true, toolName: true, status: true, createdAt: true },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const data = records.slice(0, query.limit).map((record) =>
    req.auth!.role === "VIEWER" && record.contact
      ? {
          ...record,
          contact: {
            ...record.contact,
            normalizedPhone: maskPhone(record.contact.normalizedPhone),
            email: maskEmail(record.contact.email),
          },
        }
      : record,
  );
  res.json({ data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null });
});
workspaceRouter.get("/conversations/:id", async (req, res) => {
  const data = await prisma.conversation.findFirst({
    where: {
      id: cuid.parse(req.params.id),
      organizationId: req.auth!.organizationId,
    },
    include: {
      messages: { orderBy: { sequence: "asc" } },
      toolExecutions: true,
      inboxTasks: { include: { notes: true } },
      contact: true,
      notes: true,
      feedback: true,
      transferAttempts: true,
    },
  });
  if (!data) {
    res
      .status(404)
      .json({ code: "NOT_FOUND", message: "Conversation not found." });
    return;
  }
  const appointments = await prisma.appointment.findMany({
    where: {
      organizationId: req.auth!.organizationId,
      conversationId: data.id,
    },
    include: { contact: true, location: true },
  });
  if (req.auth!.role === "VIEWER") {
    res.json({
      data: {
        ...data,
        extractedDataJson: null,
        messages: data.messages.map((message) => ({
          ...message,
          content: maskTranscript(message.content),
        })),
        contact: data.contact
          ? {
              ...data.contact,
              normalizedPhone: maskPhone(data.contact.normalizedPhone),
              email: maskEmail(data.contact.email),
            }
          : null,
      },
      appointments: appointments.map((appointment) => ({
        ...appointment,
        contact: {
          ...appointment.contact,
          normalizedPhone: maskPhone(appointment.contact.normalizedPhone),
          email: maskEmail(appointment.contact.email),
        },
      })),
    });
    return;
  }
  res.json({ data, appointments });
});
workspaceRouter.post(
  "/conversations/:id/feedback",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const input = z
      .object({
        rating: z.number().int().min(1).max(5),
        correction: z.string().trim().max(4000).optional(),
      })
      .parse(req.body);
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!conversation) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Conversation not found." });
      return;
    }
    const data = await prisma.feedback.create({
      data: {
        organizationId: req.auth!.organizationId,
        conversationId: conversation.id,
        actorId: req.auth!.userId,
        ...input,
      },
    });
    res.status(201).json({ data });
  },
);
workspaceRouter.post(
  "/conversations/:id/notes",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const conversation = await prisma.conversation.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!conversation) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Conversation not found." });
      return;
    }
    const data = await prisma.note.create({
      data: {
        organizationId: req.auth!.organizationId,
        authorId: req.auth!.userId,
        conversationId: conversation.id,
        ...noteInput.parse(req.body),
      },
    });
    res.status(201).json({ data });
  },
);
workspaceRouter.get("/contacts", async (req, res) => {
  const query = z
    .object({
      cursor: z.string().cuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .parse(req.query);
  const records = await prisma.contact.findMany({
    where: {
      organizationId: req.auth!.organizationId,
      mergesAsSource: { none: {} },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const contacts = records.slice(0, query.limit);
  res.json({
    data:
      req.auth!.role === "VIEWER"
        ? contacts.map((contact) => ({
            ...contact,
            normalizedPhone: maskPhone(contact.normalizedPhone),
            email: maskEmail(contact.email),
          }))
        : contacts,
    nextCursor: hasMore ? contacts.at(-1)?.id : null,
  });
});
workspaceRouter.post(
  "/contacts",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        phone: z.string().min(7).max(30).optional(),
        email: z.string().trim().toLowerCase().email().optional(),
        leadScore: z.number().int().min(0).max(100).optional(),
      })
      .parse(req.body);
    const normalizedPhone = input.phone?.replace(/\D/g, "");
    const organizationId = req.auth!.organizationId;
    const existing = await prisma.contact.findFirst({
      where: {
        organizationId,
        OR: [
          ...(normalizedPhone ? [{ normalizedPhone }] : []),
          ...(input.email ? [{ email: input.email }] : []),
        ],
      },
    });
    const data = existing
      ? await prisma.contact.update({
          where: { id: existing.id },
          data: {
            name: input.name,
            normalizedPhone,
            email: input.email,
            leadScore: input.leadScore,
          },
        })
      : await prisma.contact.create({
          data: {
            organizationId,
            name: input.name,
            normalizedPhone,
            email: input.email,
            leadScore: input.leadScore,
          },
        });
    res.status(existing ? 200 : 201).json({ data });
  },
);
workspaceRouter.post(
  "/contacts/:id/merge",
  requireRole("OWNER", "MANAGER"),
  async (req, res) => {
    const sourceId = cuid.parse(req.params.id);
    const { targetContactId, reason } = z
      .object({
        targetContactId: cuid,
        reason: z.string().trim().max(500).optional(),
      })
      .refine((value) => value.targetContactId !== sourceId, {
        message: "A contact cannot be merged into itself.",
      })
      .parse(req.body);
    const organizationId = req.auth!.organizationId;
    const [source, target] = await Promise.all([
      prisma.contact.findFirst({
        where: { id: sourceId, organizationId, mergesAsSource: { none: {} } },
      }),
      prisma.contact.findFirst({
        where: {
          id: targetContactId,
          organizationId,
          mergesAsSource: { none: {} },
        },
      }),
    ]);
    if (!source || !target) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Source or target contact not found.",
      });
      return;
    }
    const merge = await prisma.$transaction(async (tx) => {
      await Promise.all([
        tx.conversation.updateMany({
          where: { organizationId, contactId: source.id },
          data: { contactId: target.id },
        }),
        tx.appointment.updateMany({
          where: { organizationId, contactId: source.id },
          data: { contactId: target.id },
        }),
        tx.inboxTask.updateMany({
          where: { organizationId, contactId: source.id },
          data: { contactId: target.id },
        }),
        tx.note.updateMany({
          where: { organizationId, contactId: source.id },
          data: { contactId: target.id },
        }),
      ]);
      await tx.contact.update({
        where: { id: target.id },
        data: {
          name: target.name ?? source.name,
          normalizedPhone: target.normalizedPhone ?? source.normalizedPhone,
          email: target.email ?? source.email,
          leadScore: Math.max(target.leadScore ?? 0, source.leadScore ?? 0),
        },
      });
      return tx.contactMerge.create({
        data: {
          organizationId,
          sourceContactId: source.id,
          targetContactId: target.id,
          mergedById: req.auth!.userId,
          reason,
        },
      });
    });
    await audit({
      organizationId,
      actorId: req.auth!.userId,
      action: "contact.merged",
      targetType: "contact",
      targetId: target.id,
      metadata: { sourceContactId: source.id, mergeId: merge.id },
    });
    res.status(201).json({ data: merge });
  },
);
workspaceRouter.get("/appointments", async (req, res) =>
  res.json({
    data: await prisma.appointment.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: { contact: true, location: true },
      orderBy: { startAt: "desc" },
    }),
  }),
);
workspaceRouter.patch(
  "/appointments/:id",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const input = z
      .object({
        status: z.enum(["CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"]),
      })
      .parse(req.body);
    const existing = await prisma.appointment.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Appointment not found." });
      return;
    }
    const data = await prisma.appointment.update({
      where: { id: existing.id },
      data: input,
    });
    res.json({ data });
  },
);
workspaceRouter.get("/inbox", async (req, res) =>
  res.json({
    data: await prisma.inboxTask.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: { contact: true, conversation: true, notes: true },
      orderBy: { createdAt: "desc" },
    }),
  }),
);
workspaceRouter.patch(
  "/inbox/:id",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const existing = await prisma.inboxTask.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!existing) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Inbox task not found." });
      return;
    }
    const input = taskUpdate.parse(req.body);
    if (input.assignedToId) {
      const member = await prisma.membership.findUnique({
        where: {
          organizationId_userId: {
            organizationId: req.auth!.organizationId,
            userId: input.assignedToId,
          },
        },
      });
      if (!member) {
        res.status(400).json({
          code: "ASSIGNEE_INVALID",
          message: "The assignee is not a member of this organization.",
        });
        return;
      }
    }
    res.json({
      data: await prisma.inboxTask.update({
        where: { id: existing.id },
        data: input,
      }),
    });
  },
);
workspaceRouter.post(
  "/inbox/:id/notes",
  requireRole("OWNER", "MANAGER", "OPERATOR"),
  async (req, res) => {
    const task = await prisma.inboxTask.findFirst({
      where: {
        id: cuid.parse(req.params.id),
        organizationId: req.auth!.organizationId,
      },
    });
    if (!task) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Inbox task not found." });
      return;
    }
    const data = await prisma.note.create({
      data: {
        organizationId: req.auth!.organizationId,
        authorId: req.auth!.userId,
        inboxTaskId: task.id,
        ...noteInput.parse(req.body),
      },
    });
    res.status(201).json({ data });
  },
);
workspaceRouter.get("/audit", requireRole("OWNER"), async (req, res) => {
  const query = z
    .object({
      cursor: cuid.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .parse(req.query);
  const records = await prisma.auditLog.findMany({
    where: { organizationId: req.auth!.organizationId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });
  const hasMore = records.length > query.limit;
  const data = records.slice(0, query.limit);
  res.json({ data, nextCursor: hasMore ? data.at(-1)?.id : null });
});
