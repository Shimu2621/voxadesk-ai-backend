import { Prisma } from "@prisma/client";
import { decideCalendarReconciliation } from "../domain/calendar-reconciliation.js";
import {
  FakeCalendarReconciliationProvider,
  type CalendarReconciliationProvider,
} from "../integrations/calendar-reconciliation.js";
import { prisma } from "../lib/prisma.js";
import { incrementMetric } from "../lib/metrics.js";

export async function reconcileAppointment(
  organizationId: string,
  appointmentId: string,
  provider: CalendarReconciliationProvider = new FakeCalendarReconciliationProvider(),
) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, organizationId },
  });
  if (!appointment) return;
  const previous = await prisma.calendarReconciliation.findFirst({
    where: { organizationId, appointmentId },
    orderBy: { createdAt: "desc" },
  });
  const remote = await provider.findEvents(appointment.externalEventId);
  if (!remote.success) {
    incrementMetric("provider_failures_total", {
      provider: "calendar",
      code: remote.code,
      organizationId,
    });
    await prisma.calendarReconciliation.create({
      data: {
        organizationId,
        appointmentId,
        action: "provider_read",
        status: "failed",
        detailsSafeJson: { code: remote.code },
      },
    });
    throw new Error(remote.code);
  }
  const action = decideCalendarReconciliation(
    { ...appointment, lastReconciledAt: previous?.createdAt },
    remote.data,
  );
  let status = "completed";
  let providerEventId = appointment.externalEventId;
  try {
    if (action === "create_provider") {
      const result = await provider.createEvent({
        slot: {
          startAt: appointment.startAt,
          endAt: appointment.endAt,
          timezone: appointment.timezone,
        },
        idempotencyKey: `appointment-${appointment.id}`,
      });
      if (!result.success) throw new Error(result.code);
      providerEventId = result.data.eventId;
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: { externalEventId: providerEventId, syncStatus: "synced" },
      });
    } else if (action === "cancel_provider" && appointment.externalEventId) {
      const result = await provider.cancelEvent({
        eventId: appointment.externalEventId,
        idempotencyKey: `cancel-${appointment.id}`,
      });
      if (!result.success) throw new Error(result.code);
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: { syncStatus: "synced" },
      });
    } else if (action === "cancel_local") {
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: { status: "CANCELLED", syncStatus: "synced" },
      });
    } else if (action === "update_local") {
      const event = remote.data[0]!;
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          startAt: event.startAt,
          endAt: event.endAt,
          syncStatus: "synced",
        },
      });
    } else if (
      ["mark_missing", "conflict", "deduplicate_provider"].includes(action)
    ) {
      status = "needs_attention";
      await prisma.appointment.update({
        where: { id: appointment.id },
        data: { syncStatus: "needs_attention" },
      });
    }
  } catch (error) {
    status = "failed";
    await prisma.appointment.update({
      where: { id: appointment.id },
      data: { syncStatus: "failed" },
    });
    await prisma.calendarReconciliation.create({
      data: {
        organizationId,
        appointmentId,
        action,
        status,
        providerEventId,
        detailsSafeJson: {
          errorCode: error instanceof Error ? error.message : "UNKNOWN",
        },
      },
    });
    throw error;
  }
  await prisma.calendarReconciliation.create({
    data: {
      organizationId,
      appointmentId,
      action,
      status,
      providerEventId,
      providerOccurredAt: remote.data[0]?.updatedAt,
      detailsSafeJson: {
        remoteCount: remote.data.length,
      } as Prisma.InputJsonObject,
    },
  });
  incrementMetric("calendar_reconciliations_total", {
    action,
    status,
    organizationId,
  });
}
