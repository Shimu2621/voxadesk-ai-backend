import { describe, expect, it } from "vitest";
import {
  signSlotToken,
  signToolToken,
  verifySlotToken,
  verifyToolToken,
} from "../src/security/tool-tokens.js";

const secret = "test-auth-secret-that-is-at-least-32-characters";
const ids = {
  organizationId: "cm12345678901234567890123",
  agentVersionId: "cm22345678901234567890123",
  conversationId: "cm32345678901234567890123",
};

describe("signed tool and slot tokens", () => {
  it("round trips tenant-bound tool claims", async () => {
    const claims = { ...ids, scopes: ["availability" as const] };
    expect(
      await verifyToolToken(await signToolToken(claims, secret), secret),
    ).toEqual(claims);
  });

  it("rejects a token verified with another secret", async () => {
    const token = await signToolToken(
      { ...ids, scopes: ["availability"] },
      secret,
    );
    await expect(
      verifyToolToken(token, "a-different-secret-that-is-32-characters"),
    ).rejects.toThrow();
  });

  it("binds slot details and rejects expired tokens", async () => {
    const claims = {
      organizationId: ids.organizationId,
      serviceId: "cm42345678901234567890123",
      locationId: "cm52345678901234567890123",
      calendarId: "primary",
      startAt: "2026-09-01T14:00:00.000Z",
      endAt: "2026-09-01T15:00:00.000Z",
      timezone: "America/New_York",
    };
    expect(
      await verifySlotToken(await signSlotToken(claims, secret), secret),
    ).toEqual(claims);
    const expired = await signSlotToken(claims, secret, -1);
    await expect(verifySlotToken(expired, secret)).rejects.toThrow();
  });
});
