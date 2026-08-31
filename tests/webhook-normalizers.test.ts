import { describe, expect, it } from "vitest";
import {
  normalizeElevenLabsWebhook,
  normalizeStripeWebhook,
  normalizeTwilioWebhook,
} from "../src/integrations/webhook-normalizers.js";

const agentId = "cm12345678901234567890123";
const versionId = "cm22345678901234567890123";

describe("provider webhook normalization", () => {
  it("normalizes a sanitized ElevenLabs post-call fixture", () => {
    expect(
      normalizeElevenLabsWebhook({
        type: "post_call_transcription",
        event_timestamp: 1_700_000_000,
        data: {
          conversation_id: "conv_fixture",
          status: "done",
          metadata: {
            voxadesk_agent_id: agentId,
            voxadesk_agent_version_id: versionId,
            voxadesk_channel: "PHONE",
          },
          transcript: [],
        },
      }),
    ).toMatchObject({
      eventId: "post_call_transcription:conv_fixture:1700000000",
      type: "post_call_transcription",
      data: {
        providerConversationId: "conv_fixture",
        agentId,
        agentVersionId: versionId,
        status: "COMPLETED",
      },
    });
  });
  it("normalizes a sanitized Stripe subscription fixture", () => {
    expect(
      normalizeStripeWebhook({
        id: "evt_fixture",
        type: "customer.subscription.updated",
        created: 1_700_000_000,
        data: {
          object: {
            id: "sub_fixture",
            customer: "cus_fixture",
            status: "active",
            metadata: { planCode: "growth" },
            current_period_end: 1_800_000_000,
          },
        },
      }),
    ).toMatchObject({
      eventId: "evt_fixture",
      data: {
        subscriptionId: "sub_fixture",
        customerId: "cus_fixture",
        planCode: "growth",
        status: "active",
      },
    });
  });
  it("normalizes a sanitized Twilio status fixture", () => {
    expect(
      normalizeTwilioWebhook({
        EventSid: "EV_fixture",
        CallSid: "CA_fixture",
        CallStatus: "completed",
        Timestamp: "2026-08-29T01:00:00.000Z",
        To: "+15550101000",
      }),
    ).toMatchObject({
      eventId: "EV_fixture",
      type: "call.completed",
      data: { providerConversationId: "CA_fixture" },
    });
  });
  it("rejects malformed provider fixtures", () => {
    expect(() =>
      normalizeElevenLabsWebhook({ type: "post_call_transcription", data: {} }),
    ).toThrow();
    expect(() => normalizeTwilioWebhook({ CallStatus: "completed" })).toThrow();
  });
});
