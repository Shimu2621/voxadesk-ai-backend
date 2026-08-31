import { describe, expect, it } from "vitest";
import {
  MockCalendarProvider,
  MockStorageProvider,
  MockTelephonyProvider,
} from "../src/integrations/providers.js";

describe("mock provider adapters", () => {
  it("returns the same calendar event for a repeated idempotency key", async () => {
    const provider = new MockCalendarProvider();
    const input = {
      calendarId: "calendar",
      slot: { startAt: new Date(), endAt: new Date(), timezone: "UTC" },
      title: "Service",
      idempotencyKey: "booking-1",
    };
    const first = await provider.createEvent(input);
    const duplicate = await provider.createEvent(input);
    expect(first).toEqual(duplicate);
  });

  it("returns the same transfer for a repeated idempotency key", async () => {
    const provider = new MockTelephonyProvider();
    const input = {
      providerCallId: "call",
      destination: "+15555550100",
      idempotencyKey: "transfer-1",
    };
    expect(await provider.transfer(input)).toEqual(
      await provider.transfer(input),
    );
  });

  it("models timeouts without reporting success", async () => {
    const result = await new MockCalendarProvider("timeout").createEvent({
      calendarId: "calendar",
      slot: { startAt: new Date(), endAt: new Date(), timezone: "UTC" },
      title: "Service",
      idempotencyKey: "timeout",
    });
    expect(result).toMatchObject({ success: false, code: "TIMEOUT" });
  });

  it("prevents cross-tenant storage access", async () => {
    const provider = new MockStorageProvider();
    const stored = await provider.put({
      organizationId: "org-a",
      key: "faq.txt",
      contentType: "text/plain",
      bytes: new Uint8Array([1, 2, 3]),
    });
    if (!stored.success) throw new Error("Mock storage failed unexpectedly");
    expect(
      await provider.get({
        organizationId: "org-b",
        storageKey: stored.data.storageKey,
      }),
    ).toMatchObject({ success: false, code: "REJECTED" });
  });
});
