export type LocalAppointmentState = {
  externalEventId?: string | null;
  status: "CONFIRMED" | "CANCELLED" | "COMPLETED" | "NO_SHOW";
  startAt: Date;
  endAt: Date;
  updatedAt: Date;
  lastReconciledAt?: Date | null;
};

export type RemoteCalendarEvent = {
  eventId: string;
  status: "confirmed" | "cancelled";
  startAt: Date;
  endAt: Date;
  updatedAt: Date;
};

export type ReconciliationAction =
  | "create_provider"
  | "mark_missing"
  | "cancel_provider"
  | "cancel_local"
  | "update_local"
  | "conflict"
  | "deduplicate_provider"
  | "ignore_stale"
  | "none";

export function decideCalendarReconciliation(
  local: LocalAppointmentState,
  remoteEvents: RemoteCalendarEvent[],
): ReconciliationAction {
  if (remoteEvents.length > 1) return "deduplicate_provider";
  const remote = remoteEvents[0];
  if (!remote)
    return local.externalEventId
      ? "mark_missing"
      : local.status === "CONFIRMED"
        ? "create_provider"
        : "none";
  if (local.status === "CANCELLED" && remote.status !== "cancelled")
    return "cancel_provider";
  if (remote.status === "cancelled" && local.status === "CONFIRMED")
    return "cancel_local";
  const changed =
    remote.startAt.getTime() !== local.startAt.getTime() ||
    remote.endAt.getTime() !== local.endAt.getTime();
  if (!changed) return "none";
  if (local.lastReconciledAt && remote.updatedAt <= local.lastReconciledAt)
    return "ignore_stale";
  if (local.lastReconciledAt && local.updatedAt > local.lastReconciledAt)
    return "conflict";
  return "update_local";
}
