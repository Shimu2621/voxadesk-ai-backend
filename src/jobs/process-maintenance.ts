import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { reconcileAppointment } from "./process-calendar.js";

export async function analyzeConversation(
  organizationId: string,
  conversationId: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, organizationId },
  });
  if (!conversation || !["COMPLETED", "FAILED"].includes(conversation.status))
    return;
  if (!conversation.outcome)
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        outcome: conversation.status === "FAILED" ? "failed" : "unknown",
      },
    });
}

export async function aggregateUsage(
  organizationId: string,
  period: Date = new Date(),
) {
  const periodStart = new Date(
    Date.UTC(period.getUTCFullYear(), period.getUTCMonth(), 1),
  );
  const periodEnd = new Date(
    Date.UTC(period.getUTCFullYear(), period.getUTCMonth() + 1, 1),
  );
  const groups = await prisma.usageEvent.groupBy({
    by: ["metric"],
    where: { organizationId, occurredAt: { gte: periodStart, lt: periodEnd } },
    _sum: { quantity: true },
  });
  await prisma.$transaction(
    groups.map((group) =>
      prisma.usageAggregate.upsert({
        where: {
          organizationId_periodStart_periodEnd_metric: {
            organizationId,
            periodStart,
            periodEnd,
            metric: group.metric,
          },
        },
        create: {
          organizationId,
          periodStart,
          periodEnd,
          metric: group.metric,
          quantity: group._sum.quantity ?? new Prisma.Decimal(0),
        },
        update: { quantity: group._sum.quantity ?? new Prisma.Decimal(0) },
      }),
    ),
  );
}

export async function reconcileCalendar(
  organizationId: string,
  appointmentId: string,
) {
  await reconcileAppointment(organizationId, appointmentId);
}

export async function processNotification(
  organizationId: string,
  deliveryId: string,
) {
  const delivery = await prisma.notificationDelivery.findFirst({
    where: { id: deliveryId, organizationId },
  });
  if (!delivery || delivery.status === "sent") return;
  await prisma.notificationDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "failed",
      errorCode: "NOTIFICATION_PROVIDER_NOT_CONFIGURED",
      attemptCount: { increment: 1 },
    },
  });
}
