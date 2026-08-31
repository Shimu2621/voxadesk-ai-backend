import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  signMockWebhook,
  verifyMockWebhook,
  isWithinWebhookTolerance,
  verifyTimestampedHmac,
  verifyTwilioSignature,
  webhookEnvelopeSchema,
} from "../src/security/webhooks.js";

const secret = "mock-webhook-secret-at-least-32-characters";
const rawBody = Buffer.from(
  JSON.stringify({
    eventId: "evt_1",
    type: "conversation.completed",
    occurredAt: "2026-08-27T12:00:00.000Z",
    integrationId: "cm12345678901234567890123",
    data: {},
  }),
);

describe("mock webhook security", () => {
  it("accepts a correctly signed envelope inside the replay window", () => {
    const timestamp = 1_800_000_000;
    expect(
      verifyMockWebhook({
        rawBody,
        timestampHeader: `${timestamp}`,
        signatureHeader: signMockWebhook(rawBody, timestamp, secret),
        secret,
        now: timestamp,
      }),
    ).toEqual({ valid: true });
    expect(
      webhookEnvelopeSchema.parse(JSON.parse(rawBody.toString())),
    ).toMatchObject({ eventId: "evt_1" });
  });

  it("rejects forged signatures", () => {
    expect(
      verifyMockWebhook({
        rawBody,
        timestampHeader: "1800000000",
        signatureHeader: "0".repeat(64),
        secret,
        now: 1_800_000_000,
      }),
    ).toEqual({ valid: false, code: "SIGNATURE_INVALID" });
  });

  it("rejects events outside the replay window", () => {
    const timestamp = 1_800_000_000;
    expect(
      verifyMockWebhook({
        rawBody,
        timestampHeader: `${timestamp}`,
        signatureHeader: signMockWebhook(rawBody, timestamp, secret),
        secret,
        now: timestamp + 301,
      }),
    ).toEqual({ valid: false, code: "REPLAYED" });
  });
});

describe("live provider webhook security", () => {
  it("verifies timestamped HMAC and rejects replay", () => {
    const body = Buffer.from('{"type":"post_call_transcription"}');
    const timestamp = 1_700_000_000;
    const digest = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(body)
      .digest("hex");
    expect(
      verifyTimestampedHmac({
        rawBody: body,
        signatureHeader: `t=${timestamp},v0=${digest}`,
        secret,
        now: timestamp,
      }).valid,
    ).toBe(true);
    expect(
      verifyTimestampedHmac({
        rawBody: body,
        signatureHeader: `t=${timestamp},v0=${digest}`,
        secret,
        now: timestamp + 301,
      }),
    ).toEqual({ valid: false, code: "REPLAYED" });
  });

  it("verifies Twilio sorted-parameter HMAC", () => {
    const url = "https://example.com/telephony/inbound";
    const params = { CallSid: "CA123", To: "+15550101000" };
    const signatureHeader = createHmac("sha1", secret)
      .update(`${url}CallSidCA123To+15550101000`)
      .digest("base64");
    expect(
      verifyTwilioSignature({
        url,
        params,
        signatureHeader,
        authToken: secret,
      }),
    ).toBe(true);
  });

  it("rejects stale Twilio event timestamps", () => {
    const now = new Date("2026-08-29T12:00:00.000Z");
    expect(
      isWithinWebhookTolerance(new Date("2026-08-29T11:55:00.000Z"), now),
    ).toBe(true);
    expect(
      isWithinWebhookTolerance(new Date("2026-08-29T11:54:59.999Z"), now),
    ).toBe(false);
  });
});
