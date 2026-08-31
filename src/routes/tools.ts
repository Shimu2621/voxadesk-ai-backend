import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../config/env.js";
import {
  providers,
  providersEnabled,
} from "../integrations/provider-factory.js";
import { prisma } from "../lib/prisma.js";
import {
  signSlotToken,
  verifySlotToken,
  verifyToolToken,
} from "../security/tool-tokens.js";
import type { ToolClaims } from "../security/tool-tokens.js";
import {
  isTransferAllowed,
  maskTransferDestination,
} from "../domain/transfer.js";

const calendarProvider = providers.calendar;
const telephonyProvider = providers.telephony;
const cuid = z.string().cuid();
const availabilitySchema = z
  .object({
    serviceId: cuid,
    locationId: cuid,
    timezone: z.string().min(1),
    dateFrom: z.coerce.date(),
    dateTo: z.coerce.date(),
  })
  .refine((value) => value.dateTo > value.dateFrom, {
    message: "dateTo must be after dateFrom",
  });
const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().toLowerCase().email().optional(),
});
const appointmentSchema = z.object({
  slotToken: z.string().min(32),
  idempotencyKey: z.string().min(8).max(200),
  contact: contactSchema,
  confirmed: z.literal(true),
});
const callbackSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  contact: contactSchema,
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  dueAt: z.coerce.date().optional(),
});
const actionSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  confirmed: z.literal(true),
});
const rescheduleSchema = actionSchema.extend({ slotToken: z.string().min(32) });
const transferSchema = z.object({
  idempotencyKey: z.string().min(8).max(200),
  destination: z.string().regex(/^\+[1-9]\d{7,14}$/),
  trigger: z.string().min(1).max(200),
  contact: contactSchema,
});

async function requireToolAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({
      code: "TOOL_UNAUTHENTICATED",
      message: "A signed tool token is required.",
      requestId: req.requestId,
    });
    return;
  }
  try {
    req.toolAuth = await verifyToolToken(header.slice(7), env.AUTH_SECRET);
    next();
  } catch {
    res.status(401).json({
      code: "TOOL_TOKEN_INVALID",
      message: "The tool token is invalid or expired.",
      requestId: req.requestId,
    });
  }
}

function requireScope(scope: ToolClaims["scopes"][number]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.toolAuth?.scopes.includes(scope)) {
      res.status(403).json({
        code: "TOOL_FORBIDDEN",
        message: "The agent cannot use this tool.",
        requestId: req.requestId,
      });
      return;
    }
    next();
  };
}

async function findOrCreateContact(
  organizationId: string,
  contact: z.infer<typeof contactSchema>,
  tx: Prisma.TransactionClient = prisma,
) {
  const normalizedPhone = contact.phone.replace(/\D/g, "");
  const existing = await tx.contact.findFirst({
    where: {
      organizationId,
      OR: [
        { normalizedPhone },
        ...(contact.email ? [{ email: contact.email }] : []),
      ],
    },
  });
  return (
    existing ??
    tx.contact.create({
      data: {
        organizationId,
        normalizedPhone,
        email: contact.email,
        name: contact.name,
      },
    })
  );
}

export const toolsRouter = Router();
toolsRouter.use(requireToolAuth);
toolsRouter.post(
  "/availability",
  requireScope("availability"),
  async (req, res) => {
    const input = availabilitySchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const [service, location, integration] = await Promise.all([
      prisma.service.findFirst({
        where: { id: input.serviceId, organizationId, active: true },
      }),
      prisma.location.findFirst({
        where: { id: input.locationId, organizationId },
      }),
      prisma.integration.findUnique({
        where: {
          organizationId_type: { organizationId, type: "GOOGLE_CALENDAR" },
        },
      }),
    ]);
    if (!service || !location) {
      res.status(404).json({
        code: "RESOURCE_NOT_FOUND",
        message: "Service or location not found.",
        requestId: req.requestId,
      });
      return;
    }
    if (!providersEnabled || integration?.status !== "connected") {
      res.status(503).json({
        success: false,
        code: "CALENDAR_NOT_CONNECTED",
        message:
          "A calendar must be connected before availability can be checked.",
        slots: [],
      });
      return;
    }
    const config = z
      .object({ calendarId: z.string().min(1).default("primary") })
      .parse(integration.configJson ?? {});
    const result = await calendarProvider.availability({
      calendarId: config.calendarId,
      from: input.dateFrom,
      to: input.dateTo,
      durationMinutes: service.durationMinutes,
      timezone: input.timezone,
    });
    if (!result.success) {
      res.status(503).json({
        success: false,
        code: result.code,
        message: result.message,
        slots: [],
      });
      return;
    }
    const slots = await Promise.all(
      result.data.slice(0, 5).map(async (slot) => ({
        startAt: slot.startAt,
        endAt: slot.endAt,
        timezone: slot.timezone,
        slotToken: await signSlotToken(
          {
            organizationId,
            serviceId: service.id,
            locationId: location.id,
            calendarId: config.calendarId,
            startAt: slot.startAt.toISOString(),
            endAt: slot.endAt.toISOString(),
            timezone: slot.timezone,
          },
          env.AUTH_SECRET,
        ),
      })),
    );
    res.json({ success: true, slots });
  },
);

toolsRouter.post(
  "/appointments/:id/reschedule",
  requireScope("appointments:update"),
  async (req, res) => {
    const appointmentId = cuid.parse(req.params.id);
    const input = rescheduleSchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const prior = await prisma.toolExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior?.responseSafeJson) {
      res.json(prior.responseSafeJson);
      return;
    }
    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, organizationId, status: "CONFIRMED" },
    });
    if (!appointment?.externalEventId) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Confirmed appointment not found.",
      });
      return;
    }
    let slot;
    try {
      slot = await verifySlotToken(input.slotToken, env.AUTH_SECRET);
    } catch {
      res.status(400).json({
        code: "SLOT_INVALID",
        message: "The offered slot is invalid or expired.",
      });
      return;
    }
    if (
      slot.organizationId !== organizationId ||
      slot.locationId !== appointment.locationId
    ) {
      res.status(404).json({ code: "NOT_FOUND", message: "Slot not found." });
      return;
    }
    if (!providersEnabled) {
      res.status(503).json({
        code: "CALENDAR_NOT_CONNECTED",
        message: "The appointment was not rescheduled.",
      });
      return;
    }
    const result = await calendarProvider.updateEvent({
      calendarId: slot.calendarId,
      eventId: appointment.externalEventId,
      slot: {
        startAt: new Date(slot.startAt),
        endAt: new Date(slot.endAt),
        timezone: slot.timezone,
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.success) {
      res.status(503).json({
        code: result.code,
        message: "The appointment was not rescheduled.",
      });
      return;
    }
    const response = await prisma.$transaction(async (tx) => {
      const updated = await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: slot.timezone,
          syncStatus: "synced",
        },
      });
      const safe = {
        success: true,
        appointmentId: updated.id,
        startAt: updated.startAt,
        endAt: updated.endAt,
        timezone: updated.timezone,
      };
      await tx.toolExecution.create({
        data: {
          organizationId,
          conversationId: req.toolAuth!.conversationId,
          toolName: "appointments.reschedule",
          requestSafeJson: { appointmentId },
          responseSafeJson: safe,
          status: "succeeded",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return safe;
    });
    res.json(response);
  },
);

toolsRouter.post(
  "/appointments/:id/cancel",
  requireScope("appointments:cancel"),
  async (req, res) => {
    const appointmentId = cuid.parse(req.params.id);
    const input = actionSchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const prior = await prisma.toolExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior?.responseSafeJson) {
      res.json(prior.responseSafeJson);
      return;
    }
    const appointment = await prisma.appointment.findFirst({
      where: { id: appointmentId, organizationId, status: "CONFIRMED" },
    });
    if (!appointment?.externalEventId) {
      res.status(404).json({
        code: "NOT_FOUND",
        message: "Confirmed appointment not found.",
      });
      return;
    }
    if (!providersEnabled) {
      res.status(503).json({
        code: "CALENDAR_NOT_CONNECTED",
        message: "The appointment was not cancelled.",
      });
      return;
    }
    const result = await calendarProvider.cancelEvent({
      calendarId: "primary",
      eventId: appointment.externalEventId,
      idempotencyKey: input.idempotencyKey,
    });
    if (!result.success) {
      res.status(503).json({
        code: result.code,
        message: "The appointment was not cancelled.",
      });
      return;
    }
    const response = await prisma.$transaction(async (tx) => {
      const updated = await tx.appointment.update({
        where: { id: appointment.id },
        data: { status: "CANCELLED", syncStatus: "synced" },
      });
      const safe = {
        success: true,
        appointmentId: updated.id,
        status: updated.status,
      };
      await tx.toolExecution.create({
        data: {
          organizationId,
          conversationId: req.toolAuth!.conversationId,
          toolName: "appointments.cancel",
          requestSafeJson: { appointmentId },
          responseSafeJson: safe,
          status: "succeeded",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return safe;
    });
    res.json(response);
  },
);

toolsRouter.post(
  "/transfer",
  requireScope("transfer:create"),
  async (req, res) => {
    const input = transferSchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const prior = await prisma.toolExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior?.responseSafeJson) {
      res.json(prior.responseSafeJson);
      return;
    }
    const version = await prisma.agentVersion.findFirst({
      where: { id: req.toolAuth!.agentVersionId, agent: { organizationId } },
    });
    if (!version) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Agent version not found." });
      return;
    }
    const config = z
      .object({ transferNumbers: z.array(z.string()) })
      .passthrough()
      .parse(version.config);
    if (!isTransferAllowed(input.destination, config.transferNumbers)) {
      res.status(403).json({
        code: "TRANSFER_DESTINATION_FORBIDDEN",
        message: "The transfer destination is not allowlisted.",
      });
      return;
    }
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.toolAuth!.conversationId, organizationId },
    });
    if (!conversation) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Conversation not found." });
      return;
    }
    const result = await telephonyProvider.transfer({
      providerCallId: conversation.providerConversationId,
      destination: input.destination,
      idempotencyKey: input.idempotencyKey,
    });
    const response = await prisma.$transaction(async (tx) => {
      const contact = await findOrCreateContact(
        organizationId,
        input.contact,
        tx,
      );
      if (result.success) {
        const attempt = await tx.transferAttempt.create({
          data: {
            organizationId,
            conversationId: conversation.id,
            destinationMasked: maskTransferDestination(input.destination),
            trigger: input.trigger,
            status: "succeeded",
            providerTransferId: result.data.transferId,
            idempotencyKey: input.idempotencyKey,
          },
        });
        const safe = { success: true, transferId: attempt.id };
        await tx.toolExecution.create({
          data: {
            organizationId,
            conversationId: conversation.id,
            toolName: "transfer.create",
            requestSafeJson: { destinationMasked: attempt.destinationMasked },
            responseSafeJson: safe,
            status: "succeeded",
            idempotencyKey: input.idempotencyKey,
          },
        });
        return safe;
      }
      const task = await tx.inboxTask.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          contactId: contact.id,
          type: "CALLBACK",
          priority: "high",
        },
      });
      await tx.transferAttempt.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          destinationMasked: maskTransferDestination(input.destination),
          trigger: input.trigger,
          status: "failed",
          idempotencyKey: input.idempotencyKey,
        },
      });
      const safe = {
        success: false,
        code: result.code,
        callbackTaskId: task.id,
        message: "Transfer failed; a callback was created.",
      };
      await tx.toolExecution.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          toolName: "transfer.create",
          requestSafeJson: {
            destinationMasked: maskTransferDestination(input.destination),
          },
          responseSafeJson: safe,
          status: "failed",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return safe;
    });
    res.status(result.success ? 200 : 503).json(response);
  },
);

toolsRouter.post(
  "/appointments",
  requireScope("appointments:create"),
  async (req, res) => {
    const input = appointmentSchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const prior = await prisma.toolExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior?.responseSafeJson) {
      res.json(prior.responseSafeJson);
      return;
    }
    let slot;
    try {
      slot = await verifySlotToken(input.slotToken, env.AUTH_SECRET);
    } catch {
      res.status(400).json({
        success: false,
        code: "SLOT_INVALID",
        message: "The offered slot is invalid or expired.",
      });
      return;
    }
    if (slot.organizationId !== organizationId) {
      res.status(404).json({ code: "NOT_FOUND", message: "Slot not found." });
      return;
    }
    const [service, location] = await Promise.all([
      prisma.service.findFirst({
        where: { id: slot.serviceId, organizationId, active: true },
      }),
      prisma.location.findFirst({
        where: { id: slot.locationId, organizationId },
      }),
    ]);
    if (!service || !location) {
      res
        .status(404)
        .json({ code: "NOT_FOUND", message: "Slot resources not found." });
      return;
    }
    if (!providersEnabled) {
      res.status(503).json({
        success: false,
        code: "CALENDAR_NOT_CONNECTED",
        message: "The appointment was not created. Offer a callback instead.",
      });
      return;
    }
    const providerResult = await calendarProvider.createEvent({
      calendarId: slot.calendarId,
      slot: {
        startAt: new Date(slot.startAt),
        endAt: new Date(slot.endAt),
        timezone: slot.timezone,
      },
      title: service.name,
      idempotencyKey: input.idempotencyKey,
    });
    if (!providerResult.success) {
      res.status(503).json({
        success: false,
        code: providerResult.code,
        message: "The appointment was not confirmed. Offer a callback instead.",
      });
      return;
    }
    const response = await prisma.$transaction(async (tx) => {
      const contact = await findOrCreateContact(
        organizationId,
        input.contact,
        tx,
      );
      const appointment = await tx.appointment.create({
        data: {
          organizationId,
          contactId: contact.id,
          locationId: location.id,
          externalEventId: providerResult.data.eventId,
          startAt: new Date(slot.startAt),
          endAt: new Date(slot.endAt),
          timezone: slot.timezone,
          source: "AI_TOOL",
          conversationId: req.toolAuth!.conversationId,
        },
      });
      const safeResponse = {
        success: true,
        appointmentId: appointment.id,
        startAt: appointment.startAt,
        endAt: appointment.endAt,
        timezone: appointment.timezone,
      };
      await tx.toolExecution.create({
        data: {
          organizationId,
          conversationId: req.toolAuth!.conversationId,
          toolName: "appointments.create",
          requestSafeJson: { serviceId: service.id, locationId: location.id },
          responseSafeJson: safeResponse,
          status: "succeeded",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return safeResponse;
    });
    res.status(201).json(response);
  },
);

toolsRouter.post(
  "/callbacks",
  requireScope("callbacks:create"),
  async (req, res) => {
    const input = callbackSchema.parse(req.body);
    const organizationId = req.toolAuth!.organizationId;
    const prior = await prisma.toolExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (prior?.responseSafeJson) {
      res.json(prior.responseSafeJson);
      return;
    }
    const response = await prisma.$transaction(async (tx) => {
      const contact = await findOrCreateContact(
        organizationId,
        input.contact,
        tx,
      );
      const task = await tx.inboxTask.create({
        data: {
          organizationId,
          conversationId: req.toolAuth!.conversationId,
          contactId: contact.id,
          type: "CALLBACK",
          priority: input.priority,
          dueAt: input.dueAt,
        },
      });
      const safeResponse = { success: true, taskId: task.id };
      await tx.toolExecution.create({
        data: {
          organizationId,
          conversationId: req.toolAuth!.conversationId,
          toolName: "callbacks.create",
          requestSafeJson: { priority: input.priority },
          responseSafeJson: safeResponse,
          status: "succeeded",
          idempotencyKey: input.idempotencyKey,
        },
      });
      return safeResponse;
    });
    res.status(201).json(response);
  },
);
