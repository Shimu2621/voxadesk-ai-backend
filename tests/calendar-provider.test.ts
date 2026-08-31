import { describe, expect, it } from "vitest";
import { FakeCalendarReconciliationProvider } from "../src/integrations/calendar-reconciliation.js";

const slot = {
  startAt: new Date("2026-09-01T10:00:00Z"),
  endAt: new Date("2026-09-01T11:00:00Z"),
  timezone: "UTC",
};

describe("fake calendar reconciliation provider", () => {
  it("confirms idempotent create, read, and cancellation actions", async () => {
    const provider = new FakeCalendarReconciliationProvider();
    const created = await provider.createEvent({
      slot,
      idempotencyKey: "fixture",
    });
    expect(created).toMatchObject({
      success: true,
      data: { eventId: "fake-fixture" },
    });
    await expect(provider.findEvents("fake-fixture")).resolves.toMatchObject({
      success: true,
      data: [{ status: "confirmed" }],
    });
    await expect(
      provider.cancelEvent({
        eventId: "fake-fixture",
        idempotencyKey: "cancel-fixture",
      }),
    ).resolves.toMatchObject({ success: true });
    await expect(provider.findEvents("fake-fixture")).resolves.toMatchObject({
      success: true,
      data: [{ status: "cancelled" }],
    });
  });
  it("reports provider failure without claiming an action succeeded", async () => {
    const provider = new FakeCalendarReconciliationProvider(true);
    await expect(provider.findEvents("fake-event")).resolves.toMatchObject({
      success: false,
      code: "TIMEOUT",
    });
    await expect(
      provider.createEvent({ slot, idempotencyKey: "fixture" }),
    ).resolves.toMatchObject({ success: false });
  });
});
