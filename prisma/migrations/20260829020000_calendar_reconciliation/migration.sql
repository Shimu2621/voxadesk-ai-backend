CREATE TABLE "CalendarReconciliation" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "appointmentId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "providerEventId" TEXT,
  "providerOccurredAt" TIMESTAMP(3),
  "detailsSafeJson" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarReconciliation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CalendarReconciliation_organizationId_createdAt_idx" ON "CalendarReconciliation"("organizationId", "createdAt");
CREATE INDEX "CalendarReconciliation_appointmentId_createdAt_idx" ON "CalendarReconciliation"("appointmentId", "createdAt");
ALTER TABLE "CalendarReconciliation" ADD CONSTRAINT "CalendarReconciliation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CalendarReconciliation" ADD CONSTRAINT "CalendarReconciliation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
