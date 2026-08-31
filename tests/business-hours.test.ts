import { describe, expect, it } from "vitest";
import {
  businessStatus,
  weeklyHoursSchema,
} from "../src/domain/business-hours.js";

const hours = weeklyHoursSchema.parse({
  monday: [
    { open: "09:00", close: "12:00" },
    { open: "13:00", close: "17:00" },
  ],
  tuesday: [{ open: "09:00", close: "17:00" }],
});

describe("business hours", () => {
  it("handles split shifts in the configured timezone", () => {
    expect(
      businessStatus({
        at: new Date("2026-08-31T15:00:00.000Z"),
        timezone: "America/New_York",
        weeklyHours: hours,
      }).open,
    ).toBe(true);
    const lunch = businessStatus({
      at: new Date("2026-08-31T16:30:00.000Z"),
      timezone: "America/New_York",
      weeklyHours: hours,
    });
    expect(lunch.open).toBe(false);
    expect(lunch.nextOpening?.toISOString()).toBe("2026-08-31T17:00:00.000Z");
  });

  it("honors a local-date closure and finds the next opening", () => {
    const status = businessStatus({
      at: new Date("2026-08-31T14:00:00.000Z"),
      timezone: "America/New_York",
      weeklyHours: hours,
      closures: [{ date: "2026-08-31", label: "Holiday" }],
    });
    expect(status.open).toBe(false);
    expect(status.nextOpening?.toISOString()).toBe("2026-09-01T13:00:00.000Z");
  });
});
