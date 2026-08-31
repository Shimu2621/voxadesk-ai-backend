import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const webhookEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
  occurredAt: z.string().datetime(),
  integrationId: z.string().cuid(),
  data: z.record(z.unknown()).default({}),
});

export type WebhookEnvelope = z.infer<typeof webhookEnvelopeSchema>;

export function signMockWebhook(
  rawBody: Uint8Array,
  timestamp: number,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
}

export function verifyMockWebhook(input: {
  rawBody: Uint8Array;
  timestampHeader?: string;
  signatureHeader?: string;
  secret: string;
  now?: number;
  replayWindowSeconds?: number;
}):
  | { valid: true }
  | {
      valid: false;
      code: "SIGNATURE_INVALID" | "TIMESTAMP_INVALID" | "REPLAYED";
    } {
  const timestamp = Number(input.timestampHeader);
  if (!Number.isInteger(timestamp))
    return { valid: false, code: "TIMESTAMP_INVALID" };
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (input.replayWindowSeconds ?? 300))
    return { valid: false, code: "REPLAYED" };
  if (!input.signatureHeader || !/^[a-f0-9]{64}$/i.test(input.signatureHeader))
    return { valid: false, code: "SIGNATURE_INVALID" };
  const expected = Buffer.from(
    signMockWebhook(input.rawBody, timestamp, input.secret),
    "hex",
  );
  const actual = Buffer.from(input.signatureHeader, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { valid: true }
    : { valid: false, code: "SIGNATURE_INVALID" };
}

export function verifyTimestampedHmac(input: {
  rawBody: Uint8Array;
  signatureHeader?: string;
  secret: string;
  now?: number;
  replayWindowSeconds?: number;
}):
  | { valid: true }
  | {
      valid: false;
      code: "SIGNATURE_INVALID" | "TIMESTAMP_INVALID" | "REPLAYED";
    } {
  const values = Object.fromEntries(
    (input.signatureHeader ?? "")
      .split(",")
      .map((part) => part.trim().split("=", 2)),
  );
  const timestamp = Number(values.t);
  if (!Number.isInteger(timestamp))
    return { valid: false, code: "TIMESTAMP_INVALID" };
  if (
    Math.abs((input.now ?? Math.floor(Date.now() / 1000)) - timestamp) >
    (input.replayWindowSeconds ?? 300)
  )
    return { valid: false, code: "REPLAYED" };
  if (!/^[a-f0-9]{64}$/i.test(values.v0 ?? ""))
    return { valid: false, code: "SIGNATURE_INVALID" };
  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.`)
    .update(input.rawBody)
    .digest();
  const actual = Buffer.from(values.v0, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { valid: true }
    : { valid: false, code: "SIGNATURE_INVALID" };
}

export function verifyTwilioSignature(input: {
  url: string;
  params: Record<string, string>;
  signatureHeader?: string;
  authToken: string;
}) {
  const value =
    input.url +
    Object.keys(input.params)
      .sort()
      .map((key) => `${key}${input.params[key]}`)
      .join("");
  const expected = createHmac("sha1", input.authToken).update(value).digest();
  const actual = Buffer.from(input.signatureHeader ?? "", "base64");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isWithinWebhookTolerance(
  occurredAt: Date,
  now = new Date(),
  toleranceSeconds = 300,
) {
  return (
    Number.isFinite(occurredAt.getTime()) &&
    Math.abs(now.getTime() - occurredAt.getTime()) <= toleranceSeconds * 1_000
  );
}
