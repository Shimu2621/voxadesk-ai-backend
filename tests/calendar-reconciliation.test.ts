import { describe, expect, it } from "vitest";
import {
  decideCalendarReconciliation,
  type LocalAppointmentState,
  type RemoteCalendarEvent,
} from "../src/domain/calendar-reconciliation.js";

const reconciled = new Date("2026-08-29T10:00:00Z");
const local = (
  overrides: Partial<LocalAppointmentState> = {},
): LocalAppointmentState => ({
  externalEventId: "event-1",
  status: "CONFIRMED",
  startAt: new Date("2026-09-01T10:00:00Z"),
  endAt: new Date("2026-09-01T11:00:00Z"),
  updatedAt: new Date("2026-08-29T09:00:00Z"),
  lastReconciledAt: reconciled,
  ...overrides,
});
const remote = (
  overrides: Partial<RemoteCalendarEvent> = {},
): RemoteCalendarEvent => ({
  eventId: "event-1",
  status: "confirmed",
  startAt: new Date("2026-09-01T10:00:00Z"),
  endAt: new Date("2026-09-01T11:00:00Z"),
  updatedAt: new Date("2026-08-29T11:00:00Z"),
  ...overrides,
});

describe("calendar reconciliation decisions", () => {
  it("handles local creation and missing provider events", () => {
    expect(
      decideCalendarReconciliation(local({ externalEventId: null }), []),
    ).toBe("create_provider");
    expect(decideCalendarReconciliation(local(), [])).toBe("mark_missing");
  });
  it("handles cancellation in either direction", () => {
    expect(
      decideCalendarReconciliation(local({ status: "CANCELLED" }), [remote()]),
    ).toBe("cancel_provider");
    expect(
      decideCalendarReconciliation(local(), [remote({ status: "cancelled" })]),
    ).toBe("cancel_local");
  });
  it("handles modification, conflict, and out-of-order events", () => {
    const moved = remote({ startAt: new Date("2026-09-01T12:00:00Z") });
    expect(decideCalendarReconciliation(local(), [moved])).toBe("update_local");
    expect(
      decideCalendarReconciliation(
        local({ updatedAt: new Date("2026-08-29T12:00:00Z") }),
        [moved],
      ),
    ).toBe("conflict");
    expect(
      decideCalendarReconciliation(local(), [
        remote({
          startAt: moved.startAt,
          updatedAt: new Date("2026-08-29T08:00:00Z"),
        }),
      ]),
    ).toBe("ignore_stale");
  });
  it("detects duplicate provider events", () => {
    expect(
      decideCalendarReconciliation(local(), [
        remote(),
        remote({ eventId: "event-duplicate" }),
      ]),
    ).toBe("deduplicate_provider");
  });
});
